import { Role, label } from './token.js';
import { fail, readJson, sendJson, clientIp, RateLimit } from './http.js';
import { checkMessage, relay } from './relay.js';
import { LIFETIMES, DEFAULT_LIFETIME } from './store.js';
import { createHmac, timingSafeEqual } from 'node:crypto';
import * as base32 from './base32.js';

export const CHANNELS = ['push', 'sms', 'wa', 'mail'];
const MAX_TICKETS_PER_REQUEST = 1200; // un « cahier » d'impression (50 pages de 24 tickets)
const MAX_NUMBER = 999_999; // un lot peut compter jusqu'à 999 999 tickets : imprimés, ils ne coûtent rien ici
const MAX_BLOB = 4096;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const MAX_QUEUE_GAP = 300;

/**
 * Place estimée d'un ticket : les tickets sont distribués et appelés à peu près dans l'ordre,
 * donc « dernier numéro appelé 039, vous avez le 042 » = vous êtes le 3e.
 */
function placeInQueue(queue, n) {
  const last = queue.last?.n;
  if (last === undefined || n <= last || n - last > MAX_QUEUE_GAP) return null;
  const position = n - last;
  return {
    position,
    last: label(last),
    waitMin: queue.avgMs ? Math.max(1, Math.round((position * queue.avgMs) / MINUTE)) : null,
  };
}

const queueView = (queue, waiting) => ({
  last: queue.last ? label(queue.last.n) : null,
  lastAt: queue.last?.at ?? null,
  recent: queue.recent.map((c) => ({ label: label(c.n), at: c.at, tag: c.tag, batch: c.batch })),
  calls: queue.calls,
  avgMs: queue.avgMs,
  waiting,
});

/* ------------------------------------------------- listes, groupes, modèle */

const MAX_GROUP_CALL = 200;

/**
 * Listes personnalisées du lot (variables du message) : [{ name: 'Terrain', options: ['Terrain 1', …] }].
 * Une option « U11 > Rouge » crée une sous-liste (deux menus déroulants).
 */
function cleanLists(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 5) fail(400, 'lists');
  return value.map((list) => {
    const name = cleanText(list?.name, 24);
    if (!/^[\p{L}\p{N}][\p{L}\p{N} _-]*$/u.test(name)) fail(400, 'lists');
    const options = Array.isArray(list.options) ? list.options.map((o) => cleanText(o, 60)).filter(Boolean).slice(0, 50) : [];
    return { name, options };
  });
}

/** Plage « 12-18, 25 » → liste de numéros (vérifiée et bornée). */
export function parseNumbers(text, max = MAX_GROUP_CALL) {
  const numbers = new Set();
  for (const part of String(text).split(/[,;\s]+/).filter(Boolean)) {
    const match = /^(\d{1,6})(?:-(\d{1,6}))?$/.exec(part);
    if (!match) return null;
    const a = Number(match[1]);
    const b = Number(match[2] ?? match[1]);
    if (a < 1 || b < a || b > MAX_NUMBER || b - a + 1 > max) return null;
    for (let n = a; n <= b && numbers.size <= max; n++) numbers.add(n);
    if (numbers.size > max) return null;
  }
  return numbers.size ? [...numbers].sort((x, y) => x - y) : null;
}

/** Variables intégrées du message : {nom}/{name}, {numero}/{number}, {groupe}/{group}. */
export function fillBuiltins(text, { name, label: number, group }) {
  const values = { nom: name, name, numero: number, number, num: number, groupe: group, group };
  return text.replace(/\{([\p{L}\p{N} _-]{1,24})\}/gu, (match, key) => {
    const value = values[key.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()];
    return value === undefined ? match : value;
  });
}

/** Groupes de tickets : [{ name: 'U11 Rouge', numbers: '12-18, 25' }]. */
function cleanGroups(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 100) fail(400, 'groups');
  return value.map((group) => {
    const name = cleanText(group?.name, 40) || fail(400, 'groups');
    const numbers = cleanText(group?.numbers, 200);
    if (!parseNumbers(numbers)) fail(400, 'groups');
    return { name, numbers };
  });
}

/* ------------------------------------------------------------ validations */

const cleanText = (value, max) =>
  typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '';

const cleanName = (value) => cleanText(value, 60);

/** Lien du créateur du lot (réseau social, partenaire) : https uniquement. */
function cleanLink(value) {
  if (typeof value !== 'string' || value.trim() === '') return '';
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    fail(400, 'link');
  }
  return url.protocol === 'https:' && url.href.length <= 200 && !url.username && !url.password ? url.href : fail(400, 'link');
}

const cleanChannels = (value) => (Array.isArray(value) ? CHANNELS.filter((c) => value.includes(c)) : []);

function number(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= MAX_NUMBER ? n : fail(400, 'number');
}

/** Plage de numéros ; `max` limite la taille d'un cahier d'impression (pas celle du lot). */
function range(from, to, max = MAX_NUMBER) {
  const a = number(from);
  const b = number(to);
  if (b < a || b - a + 1 > max) fail(400, 'range');
  return [a, b];
}

const lifetime = (value) => (value === undefined ? DEFAULT_LIFETIME : LIFETIMES.includes(Number(value)) ? Number(value) : fail(400, 'ttl'));

function publicKey(value) {
  const ok = typeof value === 'string' && /^[\w-]{87}$/.test(value);
  const bytes = ok ? Buffer.from(value, 'base64url') : null;
  return bytes?.length === 65 && bytes[0] === 4 ? value : fail(400, 'key');
}

/* ------------------------------------------------------------------ API */

export function createApi({ config, store, tokens, events }) {
  const limits = new RateLimit();

  const ticketOf = (text, role) => {
    const ticket = tokens.decode(typeof text === 'string' ? text.toUpperCase() : '');
    return ticket && (role === undefined || ticket.role === role) ? ticket : fail(404, 'invalid');
  };

  const lotOf = async (req) => {
    const header = req.headers.authorization ?? '';
    const lot = header.startsWith('Lot ') ? await store.lotByAuth(header.slice(4)) : null;
    if (lot) return lot;
    limits.check(`auth:${clientIp(req)}`, 60, 10 * MINUTE); // essais de clés au hasard : vite freinés
    return fail(401, 'login');
  };

  const mint = (lot, from, to) => {
    const tickets = [];
    for (let n = from; n <= to; n++) {
      tickets.push({ n, label: label(n), c: tokens.encode(lot, n, Role.CLIENT), s: tokens.encode(lot, n, Role.STUB) });
    }
    return tickets;
  };

  const publicLot = (lot) => ({
    lot: lot.id,
    name: lot.name,
    // La seule « publicité » possible : celle du créateur du lot (partenaire, réseaux sociaux).
    promo: lot.promo ?? '',
    link: lot.link ?? '',
    ttl: lot.ttl ?? DEFAULT_LIFETIME,
    from: lot.from,
    to: lot.to,
    channels: lot.channels,
    pubEcdh: lot.pubEcdh,
    pubVapid: lot.pubVapid,
  });

  /** Nom du premier groupe du lot qui contient ce numéro ('' sinon). */
  const groupOf = (lot, n) => (lot.groups ?? []).find((g) => parseNumbers(g.numbers)?.includes(n))?.name ?? '';

  /** Ce que seul le commerçant voit : modèle de message, listes, groupes, lien de l'écran public. */
  const privateLot = (lot) => ({
    ...publicLot(lot),
    template: lot.template ?? '',
    lists: lot.lists ?? [],
    groups: lot.groups ?? [],
    screen: screenToken(lot),
  });

  /**
   * Lien de l'écran public : numéro de lot + signature (HMAC) ; rien à stocker.
   * Changer `screenGen` révoque tous les anciens liens.
   */
  function screenToken(lot) {
    const id = Buffer.alloc(4);
    id.writeUInt32BE(lot.id);
    const tag = createHmac('sha256', config.statusKey).update(`screen|${lot.id}|${lot.screenGen ?? 0}`).digest().subarray(0, 10);
    return base32.encode(Buffer.concat([id, tag]));
  }

  async function lotOfScreen(token) {
    const bin = /^[A-Z2-7]{23}$/.test(token) ? base32.decode(token) : null;
    const lot = bin?.length === 14 ? await store.lot(bin.readUInt32BE(0)) : null;
    const expected = lot ? Buffer.from(screenToken(lot)) : null;
    return expected && timingSafeEqual(expected, Buffer.from(token)) ? lot : fail(404, 'invalid');
  }

  /** Appel d'un ticket : état publié pour les pages ouvertes, blocs chiffrés rendus au commerçant. */
  const call = async (lot, n, info = {}) => {
    const firstEvent = (await store.events(lot.id, n))[0]?.[0];
    const previous = await store.call(lot.id, n, info);
    events.notify(store.statusId(lot.id, n));
    await store.event(lot.id, n, previous === null ? 'call' : 'recall');
    if (previous === null && firstEvent) {
      store.count(lot.id, 'wait_ms', Date.now() - firstEvent); // attente réelle entre scan et appel
      store.count(lot.id, 'waits');
    }
    return {
      ok: true,
      n,
      label: label(n),
      previousAt: previous,
      clientToken: tokens.encode(lot.id, n, Role.CLIENT),
      subs: (await store.subs(lot.id, n)).map(({ id, blob }) => ({ id, blob })),
    };
  };

  const routes = [
    ['GET', /^\/info$/, async () => ({ ok: true, brand: config.brand, domain: config.domain, contact: config.contact, stats: await store.stats() })],

    // Création d'un lot : le navigateur a déjà fabriqué les clés, il n'envoie que les parties publiques
    // et les clés privées chiffrées avec la clé du lot (que le serveur ne reçoit jamais).
    ['POST', /^\/lots$/, async (req) => {
      limits.check(`lots:${clientIp(req)}`, 20, HOUR);
      const body = await readJson(req);
      const [from, to] = range(body.from, body.to);
      const name = cleanName(body.name) || fail(400, 'name');
      if (typeof body.wrapped !== 'string' || !/^[\w-]{20,2048}$/.test(body.wrapped)) fail(400, 'wrapped');
      if (typeof body.verifier !== 'string' || !/^[0-9a-f]{64}$/.test(body.verifier)) fail(400, 'verifier');
      const lot = await store.createLot({
        name,
        promo: cleanText(body.promo, 140),
        link: cleanLink(body.link),
        ttl: lifetime(body.ttl),
        channels: cleanChannels(body.channels),
        pubEcdh: publicKey(body.pubEcdh),
        pubVapid: publicKey(body.pubVapid),
        wrapped: body.wrapped,
        verifier: body.verifier,
        from,
        to,
      });
      await store.countLot(to - from + 1);
      // Les tickets eux-mêmes sont demandés ensuite, cahier par cahier (POST /lot/tickets).
      return { ok: true, ...publicLot(lot) };
    }],

    ['GET', /^\/lot$/, async (req) => {
      const lot = await lotOf(req);
      const waiting = await store.waiting(lot.id);
      return {
        ok: true,
        ...privateLot(lot),
        wrapped: lot.wrapped,
        waiting: waiting.map((w) => ({ n: w.n, label: label(w.n), calledAt: w.calledAt, subs: w.subs })),
        queue: queueView(await store.queue(lot.id), waiting.filter((w) => w.calledAt === null).length),
      };
    }],

    // Nouveau lien d'écran public : l'ancien cesse aussitôt de fonctionner.
    ['POST', /^\/lot\/screen\/reset$/, async (req) => {
      const lot = await lotOf(req);
      lot.screenGen = (lot.screenGen ?? 0) + 1;
      await store.saveLot(lot);
      return { ok: true, screen: screenToken(lot) };
    }],

    // Écran public (tablette, TV) : lien secret à diffuser, seulement des numéros et des repères.
    ['GET', /^\/screen\/([A-Za-z2-7]{23})$/, async (req, [token]) => {
      limits.check(`screen:${clientIp(req)}`, 300, 10 * MINUTE);
      const lot = await lotOfScreen(token.toUpperCase());
      return { ok: true, name: lot.name, promo: lot.promo ?? '', link: lot.link ?? '', ...queueView(await store.queue(lot.id), null) };
    }],

    // Écran d'affichage (tablette, TV) : seulement des numéros, rafraîchi toutes les quelques secondes.
    ['GET', /^\/lot\/queue$/, async (req) => {
      const lot = await lotOf(req);
      return { ok: true, name: lot.name, ...queueView(await store.queue(lot.id), null) };
    }],

    ['POST', /^\/lot\/tickets$/, async (req) => {
      const lot = await lotOf(req);
      const body = await readJson(req);
      const [from, to] = range(body.from, body.to, MAX_TICKETS_PER_REQUEST);
      if (from < (lot.from ?? 1) || to > (lot.to ?? MAX_NUMBER)) {
        // Numéros en dehors du lot initial : le lot s'agrandit (et les statistiques le comptent).
        await store.countTickets(Math.max(0, (lot.from ?? from) - from) + Math.max(0, to - (lot.to ?? to)));
        lot.from = Math.min(lot.from ?? from, from);
        lot.to = Math.max(lot.to ?? to, to);
        await store.saveLot(lot);
      }
      return { ok: true, tickets: mint(lot.id, from, to) };
    }],

    ['POST', /^\/lot\/settings$/, async (req) => {
      const lot = await lotOf(req);
      const body = await readJson(req);
      lot.name = cleanName(body.name) || lot.name;
      lot.promo = cleanText(body.promo, 140);
      lot.link = cleanLink(body.link);
      lot.ttl = lifetime(body.ttl ?? lot.ttl);
      lot.channels = cleanChannels(body.channels);
      if (body.template !== undefined) lot.template = cleanText(body.template, 280);
      lot.lists = cleanLists(body.lists) ?? lot.lists ?? [];
      lot.groups = cleanGroups(body.groups) ?? lot.groups ?? [];
      await store.saveLot(lot);
      return { ok: true, ...privateLot(lot) };
    }],

    // Suivi : tickets actifs (journal sans donnée personnelle) et statistiques des 30 derniers jours.
    ['GET', /^\/lot\/history$/, async (req) => {
      const lot = await lotOf(req);
      return { ok: true, tickets: (await store.history(lot.id)).map((t) => ({ ...t, label: label(t.n) })) };
    }],

    ['GET', /^\/lot\/stats$/, async (req) => {
      const lot = await lotOf(req);
      return { ok: true, days: await store.lotStats(lot.id) };
    }],

    // Le téléphone du commerçant signale qu'il a ouvert un SMS / WhatsApp / e-mail pour ce ticket.
    ['POST', /^\/lot\/event$/, async (req) => {
      const lot = await lotOf(req);
      const body = await readJson(req);
      const n = number(body.n);
      if (body.type !== 'send' || !['sms', 'wa', 'mail'].includes(body.detail)) fail(400, 'event');
      if (!(await store.isActive(lot.id, n))) fail(404, 'invalid');
      await store.event(lot.id, n, 'send', body.detail);
      return { ok: true };
    }],

    // Page d'un ticket (client ou souche) : tout ce qu'il faut pour chiffrer, rien de secret.
    ['GET', /^\/t\/([A-Za-z2-7]{26})$/, async (req, [token]) => {
      const ticket = ticketOf(token);
      const lot = (await store.lot(ticket.lot)) ?? fail(404, 'invalid');
      const callInfo = await store.callInfo(lot.id, ticket.n);
      const called = callInfo !== null;
      // Premier scan du client : le ticket s'active (et commence sa durée de vie).
      if (ticket.role === Role.CLIENT && !(await store.isActive(lot.id, ticket.n))) await store.event(lot.id, ticket.n, 'scan');
      return {
        ok: true,
        role: ticket.role === Role.STUB ? 'stub' : 'client',
        n: ticket.n,
        label: label(ticket.n),
        ...publicLot(lot),
        status: store.statusId(lot.id, ticket.n),
        called,
        // Le message de l'appel (ex. « attendus au Terrain 3 ») s'affiche aussi sur la page du client.
        message: callInfo?.m ?? '',
        tag: callInfo?.tag ?? '',
        // La souche du commerçant a besoin des variables pour proposer le message avant l'appel.
        ...(ticket.role === Role.STUB ? { template: lot.template ?? '', lists: lot.lists ?? [], group: groupOf(lot, ticket.n) } : {}),
        queue: called ? null : placeInQueue(await store.queue(lot.id), ticket.n),
      };
    }],

    ['POST', /^\/sub$/, async (req) => {
      limits.check(`sub:${clientIp(req)}`, 60, 10 * MINUTE);
      const body = await readJson(req);
      const ticket = ticketOf(body.t, Role.CLIENT);
      if (!(await store.lot(ticket.lot))) fail(404, 'invalid');
      if (typeof body.blob !== 'string' || body.blob.length > MAX_BLOB || !/^[\w-]{100,}$/.test(body.blob)) fail(400, 'blob');
      // Le type de canal (pas la coordonnée !) est donné en clair, uniquement pour les statistiques.
      const kind = CHANNELS.includes(body.kind) ? body.kind : fail(400, 'kind');
      const rid = (await store.addSub(ticket.lot, ticket.n, body.blob)) ?? fail(409, 'full');
      await store.event(ticket.lot, ticket.n, 'sub', kind);
      return { ok: true, rid };
    }],

    ['POST', /^\/unsub$/, async (req) => {
      const body = await readJson(req);
      const ticket = ticketOf(body.t, Role.CLIENT);
      const removed = await store.removeSub(ticket.lot, ticket.n, body.rid);
      if (removed) await store.event(ticket.lot, ticket.n, 'unsub');
      return { ok: removed };
    }],

    // La page du client a affiché « C'est à vous » : le commerçant sait que l'appel a été vu.
    ['POST', /^\/seen$/, async (req) => {
      const body = await readJson(req);
      const ticket = ticketOf(body.t, Role.CLIENT);
      const log = await store.events(ticket.lot, ticket.n);
      if (log.some(([, type]) => type === 'call' || type === 'recall') && !log.some(([, type]) => type === 'seen')) {
        await store.event(ticket.lot, ticket.n, 'seen');
      }
      return { ok: true };
    }],

    // Appel d'un ticket (souche ou numéro) ou d'un groupe entier, avec le message choisi au moment de l'envoi.
    ['POST', /^\/call$/, async (req) => {
      const lot = await lotOf(req);
      const body = await readJson(req);
      const message = cleanText(body.message, 280);
      const tag = cleanText(body.tag, 80);
      // {numero}, {nom}, {groupe} : remplacés pour chaque ticket (le message s'affiche aussi chez le client).
      const infoFor = (n) => ({ m: fillBuiltins(message, { name: lot.name, label: label(n), group: groupOf(lot, n) }), tag });
      if (body.numbers !== undefined) {
        const numbers = parseNumbers(Array.isArray(body.numbers) ? body.numbers.join(',') : body.numbers) ?? fail(400, 'numbers');
        const batch = Date.now().toString(36); // même appel de groupe : une seule annonce sur l'écran
        const calls = [];
        for (const n of numbers) calls.push(await call(lot, n, { ...infoFor(n), b: batch }));
        return { ok: true, calls };
      }
      if (body.t !== undefined) {
        const ticket = ticketOf(body.t, Role.STUB);
        if (ticket.lot !== lot.id) fail(403, 'other_lot');
        return call(lot, ticket.n, infoFor(ticket.n));
      }
      const n = number(body.n);
      return call(lot, n, infoFor(n));
    }],

    ['POST', /^\/sub\/drop$/, async (req) => {
      const lot = await lotOf(req);
      const body = await readJson(req);
      return { ok: await store.dropSub(lot.id, number(body.n), body.id) };
    }],

    ['POST', /^\/relay$/, async (req) => {
      const lot = await lotOf(req);
      const body = await readJson(req);
      const n = number(body.n);
      if (!Array.isArray(body.messages) || body.messages.length === 0 || body.messages.length > 10) fail(400, 'messages');
      const messages = body.messages.map((m) => checkMessage(m, lot.pubVapid) ?? fail(400, 'message'));
      const statuses = await relay(messages);
      for (const status of statuses) {
        const outcome = status >= 200 && status < 300 ? 'ok' : status === 404 || status === 410 ? 'gone' : 'fail';
        await store.event(lot.id, n, 'push', outcome);
      }
      return { ok: true, statuses };
    }],
  ];

  /** Traite la requête si elle vise l'API ; renvoie false sinon. */
  return async function handle(req, res, pathname) {
    const sse = /^\/events\/([0-9a-f]{32})$/.exec(pathname);
    if (sse && req.method === 'GET') {
      try {
        limits.check(`sse:${clientIp(req)}`, 600, 10 * MINUTE);
      } catch (err) {
        sendJson(res, err.status, { ok: false, error: err.code });
        return true;
      }
      if (!events.subscribe(sse[1], req, res)) sendJson(res, 503, { ok: false, error: 'busy' });
      return true;
    }
    for (const [method, pattern, handler] of routes) {
      const match = pattern.exec(pathname);
      if (!match) continue;
      try {
        if (req.method !== method) fail(405, 'method');
        sendJson(res, 200, await handler(req, match.slice(1)));
      } catch (err) {
        if (err.status) sendJson(res, err.status, { ok: false, error: err.code });
        else {
          console.error(err);
          sendJson(res, 500, { ok: false, error: 'server' });
        }
      }
      return true;
    }
    return false;
  };
}
