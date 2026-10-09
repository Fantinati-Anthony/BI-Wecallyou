import { Role, label } from './token.js';
import { fail, readJson, readRaw, sendJson, clientIp, RateLimit } from './http.js';
import { verifySignature, applyEvent } from './stripe.js';
import { checkMessage, relay } from './relay.js';
import { LIFETIMES, PRO_LIFETIMES, DEFAULT_LIFETIME } from './store.js';
import { STATS_DAYS } from './pro.js';
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

/** Couleurs personnalisées (option Pro) : écran public et page du client. null = couleurs d'origine. */
const THEME_KEYS = ['screenBg', 'screenText', 'screenNumber', 'accent'];
function cleanTheme(value) {
  if (!value || typeof value !== 'object') return null;
  const theme = {};
  for (const key of THEME_KEYS) if (/^#[0-9a-f]{6}$/i.test(value[key] ?? '')) theme[key] = value[key].toLowerCase();
  return Object.keys(theme).length ? theme : null;
}

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

/** À la création, le lot n'a pas encore de compte : durées gratuites seulement (sauf installation « allPro »). */
const freeLifetime = (value, allPro = false) => {
  const ttl = lifetime(value);
  return PRO_LIFETIMES.includes(ttl) && !allPro ? fail(403, 'pro_required') : ttl;
};

const lifetime = (value) => (value === undefined ? DEFAULT_LIFETIME : LIFETIMES.includes(Number(value)) ? Number(value) : fail(400, 'ttl'));

function publicKey(value) {
  const ok = typeof value === 'string' && /^[\w-]{87}$/.test(value);
  const bytes = ok ? Buffer.from(value, 'base64url') : null;
  return bytes?.length === 65 && bytes[0] === 4 ? value : fail(400, 'key');
}

const IDENT = /^[a-z0-9][a-z0-9._-]{2,31}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const MAX_VAULT = 60_000;
const sealed = (value, max) => typeof value === 'string' && value.length >= 40 && value.length <= max && /^[\w-]+$/.test(value);
const pick = (object, keys) => Object.fromEntries(keys.map((k) => [k, object[k]]));

/* ------------------------------------------------------------------ API */

export function createApi({ config, store, accounts, plans, tokens, events, gate }) {
  const limits = new RateLimit();

  /* ---------------------------------------------------- comptes et priorité */

  const accountOf = async (req, kind = 'acc') => {
    const header = req.headers.authorization ?? '';
    const prefix = kind === 'acc' ? 'Account ' : 'Recovery ';
    const account = header.startsWith(prefix) ? await accounts.byToken(kind, header.slice(prefix.length)) : null;
    if (account) return account;
    limits.check(`auth:${clientIp(req)}`, 60, 10 * MINUTE);
    return fail(401, 'login');
  };

  const accountView = async (account) => ({
    ok: true,
    usage: await plans.usage(account), // tickets actifs sur 30 jours et prix Pro conseillé
    id: account.id,
    wrapPw: account.wrapPw,
    vault: account.vault,
    version: account.version,
    pro: accounts.isPro(account),
    premiumUntil: account.premiumUntil || null,
  });

  const lotIsPro = async (lotId) => {
    if (config.allPro) return true;
    if (!Number.isInteger(lotId) || lotId < 1) return false;
    const lot = await store.lot(lotId);
    return lot?.owner ? accounts.isProId(lot.owner) : false;
  };

  /** Lot (ou compte) concerné par une requête, pour savoir s'il passe en priorité. */
  const priorityOf = async (req, pathname) => {
    try {
      const header = req.headers.authorization ?? '';
      if (header.startsWith('Account ')) return accounts.isPro(await accounts.byToken('acc', header.slice(8)));
      let lotId = header.startsWith('Lot ') ? (await store.lotByAuth(header.slice(4)))?.id : undefined;
      const ticket = /^\/t\/([A-Za-z2-7]{26})$/.exec(pathname)?.[1];
      if (!lotId && ticket) lotId = tokens.decode(ticket.toUpperCase())?.lot;
      const screen = /^\/screen\/([A-Za-z2-7]{23})$/.exec(pathname)?.[1];
      if (!lotId && screen) lotId = base32.decode(screen.toUpperCase())?.readUInt32BE(0);
      lotId ??= Number(req.headers['x-lot']); // simple indice envoyé par la page d'un ticket
      return lotIsPro(lotId);
    } catch {
      return false;
    }
  };

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

  const publicLot = async (lot) => {
    const { pro } = await plans.status(lot);
    return {
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
      // Options Pro : sans mention de WeCallYou (le lien Confidentialité reste, il est obligatoire)
      // et couleurs personnalisées. Hors Pro, elles restent enregistrées mais ne s'appliquent plus.
      whiteLabel: Boolean(lot.whiteLabel) && pro,
      theme: pro ? cleanTheme(lot.theme) : null,
    };
  };

  /** Nom du premier groupe du lot qui contient ce numéro ('' sinon). */
  const groupOf = (lot, n) => (lot.groups ?? []).find((g) => parseNumbers(g.numbers)?.includes(n))?.name ?? '';

  /** Ce que seul le commerçant voit : modèle, listes, groupes, écran public, statut Pro du lot. */
  const privateLot = async (lot) => {
    const status = await plans.status(lot);
    return {
      ...(await publicLot(lot)),
      template: lot.template ?? '',
      lists: lot.lists ?? [],
      groups: lot.groups ?? [],
      screen: screenToken(lot),
      whiteLabelSetting: Boolean(lot.whiteLabel),
      themeSetting: cleanTheme(lot.theme),
      pro: status.pro,
      proUntil: status.until,
      // Durée de vie réellement appliquée (une durée Pro retombe à 48 h après la fin du Pro et de sa marge).
      ttlApplied: await plans.lifetimeHours(lot, lot.ttl ?? DEFAULT_LIFETIME),
    };
  };

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
    ['GET', /^\/info$/, async () => ({ ok: true, brand: config.brand, domain: config.domain, contact: config.contact, allPro: Boolean(config.allPro), stats: await store.stats() })],

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
        ttl: freeLifetime(body.ttl, config.allPro),
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
      return { ok: true, ...(await publicLot(lot)) };
    }],

    ['GET', /^\/lot$/, async (req) => {
      const lot = await lotOf(req);
      const waiting = await store.waiting(lot.id);
      return {
        ok: true,
        ...(await privateLot(lot)),
        wrapped: lot.wrapped,
        owned: Boolean(lot.owner),
        pro: await lotIsPro(lot.id),
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
      const { pro } = await plans.status(lot);
      const theme = pro ? cleanTheme(lot.theme) : null;
      return { ok: true, name: lot.name, promo: lot.promo ?? '', link: lot.link ?? '', theme, ...queueView(await store.queue(lot.id), null) };
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
      // Options Pro (durées longues, marque masquée, couleurs) : refusées si le lot n'est pas Pro.
      // Revenir aux réglages gratuits reste toujours possible.
      const { pro } = await plans.status(lot);
      const ttl = lifetime(body.ttl ?? lot.ttl);
      const theme = body.theme === undefined ? cleanTheme(lot.theme) : cleanTheme(body.theme);
      if (PRO_LIFETIMES.includes(ttl) && ttl !== lot.ttl && !pro) fail(403, 'pro_required');
      if (body.whiteLabel === true && !lot.whiteLabel && !pro) fail(403, 'pro_required');
      if (theme && JSON.stringify(theme) !== JSON.stringify(cleanTheme(lot.theme)) && !pro) fail(403, 'pro_required');
      lot.ttl = ttl;
      if (body.whiteLabel !== undefined) lot.whiteLabel = body.whiteLabel === true;
      if (theme) lot.theme = theme;
      else delete lot.theme;
      lot.channels = cleanChannels(body.channels);
      if (body.template !== undefined) lot.template = cleanText(body.template, 280);
      lot.lists = cleanLists(body.lists) ?? lot.lists ?? [];
      lot.groups = cleanGroups(body.groups) ?? lot.groups ?? [];
      await store.saveLot(lot);
      return { ok: true, ...(await privateLot(lot)) };
    }],

    // Suivi : tickets actifs (journal sans donnée personnelle) et statistiques des 30 derniers jours.
    ['GET', /^\/lot\/history$/, async (req) => {
      const lot = await lotOf(req);
      return { ok: true, tickets: (await store.history(lot.id)).map((t) => ({ ...t, label: label(t.n) })) };
    }],

    // Statistiques : 90 jours au plus en gratuit, un an en Pro (l'export se fait depuis la page).
    ['GET', /^\/lot\/stats$/, async (req) => {
      const lot = await lotOf(req);
      const max = (await plans.status(lot)).pro ? STATS_DAYS.pro : STATS_DAYS.free;
      const asked = Number(new URL(req.url, 'http://x').searchParams.get('days') ?? 30);
      return { ok: true, max, days: await store.lotStats(lot.id, Math.min(Math.max(Number.isInteger(asked) ? asked : 30, 1), max)) };
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
        ...(await publicLot(lot)),
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

    /* ------------------------------------------------- comptes (facultatifs) */

    // Création : le navigateur envoie seulement des empreintes et des blocs chiffrés.
    ['POST', /^\/account$/, async (req) => {
      limits.check(`signup:${clientIp(req)}`, 10, HOUR);
      const body = await readJson(req);
      const ident = typeof body.ident === 'string' ? body.ident.trim().toLowerCase() : '';
      if (!IDENT.test(ident)) fail(400, 'ident');
      if (!HEX64.test(body.verifier ?? '') || !HEX64.test(body.recoveryVerifier ?? '') || body.verifier === body.recoveryVerifier) fail(400, 'verifier');
      if (!sealed(body.wrapPw, 200) || !sealed(body.wrapRec, 200) || !sealed(body.vault, MAX_VAULT)) fail(400, 'vault');
      const account = (await accounts.create({ ident, ...pick(body, ['verifier', 'recoveryVerifier', 'wrapPw', 'wrapRec', 'vault']) })) ?? fail(409, 'ident_taken');
      return { ok: true, id: account.id, version: account.version };
    }],

    ['GET', /^\/account$/, async (req) => accountView(await accountOf(req))],

    // Fiche de secours : ouvre le coffre sans le mot de passe, pour en choisir un nouveau.
    ['GET', /^\/account\/recover$/, async (req) => {
      const account = await accountOf(req, 'rec');
      return { ok: true, id: account.id, wrapRec: account.wrapRec, vault: account.vault, version: account.version };
    }],

    ['POST', /^\/account\/password$/, async (req) => {
      const recovery = (req.headers.authorization ?? '').startsWith('Recovery ');
      const account = await accountOf(req, recovery ? 'rec' : 'acc');
      const body = await readJson(req);
      if (!HEX64.test(body.verifier ?? '') || !sealed(body.wrapPw, 200)) fail(400, 'verifier');
      // Le nouveau mot de passe est dérivé de l'identifiant : une faute de frappe rendrait le compte
      // impossible à ouvrir ensuite. On vérifie donc l'identifiant (par son empreinte) avant d'accepter.
      const ident = typeof body.ident === 'string' ? body.ident.trim().toLowerCase() : '';
      if (recovery && accounts.identHash(ident) !== account.identHash) fail(400, 'ident');
      await accounts.setPassword(account, body.verifier, body.wrapPw);
      return { ok: true };
    }],

    ['POST', /^\/account\/recovery$/, async (req) => {
      const account = await accountOf(req);
      const body = await readJson(req);
      if (!HEX64.test(body.recoveryVerifier ?? '') || !sealed(body.wrapRec, 200)) fail(400, 'verifier');
      await accounts.setRecovery(account, body.recoveryVerifier, body.wrapRec);
      return { ok: true };
    }],

    ['POST', /^\/account\/vault$/, async (req) => {
      const account = await accountOf(req);
      const body = await readJson(req);
      if (!sealed(body.vault, MAX_VAULT) || !Number.isInteger(body.version)) fail(400, 'vault');
      return { ok: true, version: (await accounts.setVault(account, body.vault, body.version)) ?? fail(409, 'conflict') };
    }],

    // Rattache un lot au compte (preuve : le jeton du lot) : ses requêtes profitent du Pro du compte.
    ['POST', /^\/account\/link$/, async (req) => {
      const account = await accountOf(req);
      const body = await readJson(req);
      const lot = (await store.lotByAuth(body.lotAuth)) ?? fail(404, 'invalid');
      // Gratuit : un lot par compte. Plusieurs lots réunis sur un compte : option Pro.
      if (!(account.lots ?? []).includes(lot.id) && !accounts.isPro(account) && !config.allPro) {
        const alive = (await Promise.all((account.lots ?? []).map((id) => store.lot(id)))).filter(Boolean);
        if (alive.length >= 1) fail(403, 'pro_required');
      }
      await accounts.addLot(account, lot.id);
      if (lot.owner !== account.id) {
        lot.owner = account.id;
        await store.saveLot(lot);
      }
      return { ok: true };
    }],

    // Détache un lot du compte (il reste utilisable avec sa page clé) : libère la place d'un compte gratuit.
    ['POST', /^\/account\/unlink$/, async (req) => {
      const account = await accountOf(req);
      const body = await readJson(req);
      const id = Number(body.lot);
      if (!Number.isInteger(id) || !(await accounts.removeLot(account, id))) fail(404, 'invalid');
      const lot = await store.lot(id);
      if (lot?.owner === account.id) {
        delete lot.owner;
        await store.saveLot(lot);
      }
      return { ok: true };
    }],

    ['POST', /^\/account\/delete$/, async (req) => {
      await accounts.remove(await accountOf(req));
      return { ok: true };
    }],

    // Stripe prévient d'un paiement : signature vérifiée, chaque événement traité une seule fois.
    ['POST', /^\/stripe\/webhook$/, async (req) => {
      const raw = await readRaw(req);
      if (!verifySignature(raw, req.headers['stripe-signature'], config.stripeWebhookSecret)) fail(400, 'signature');
      let event;
      try {
        event = JSON.parse(raw);
      } catch {
        fail(400, 'bad_json');
      }
      if (await accounts.alreadyHandled(event.id)) return { ok: true, duplicate: true };
      const pricing = {
        proLinks: config.stripeProLinks ?? [],
        suggested: async (id) => (await plans.usage(await accounts.get(id))).suggested,
      };
      return { ok: true, result: await applyEvent(event, accounts, pricing) };
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
      // Les dernières places de temps réel sont gardées pour les lots Pro ; les autres pages passent
      // alors en vérification périodique (même résultat, quelques secondes plus tard).
      const reserved = events.clients >= events.maxClients * 0.8;
      const pro = reserved ? await lotIsPro(Number(new URL(req.url, 'http://x').searchParams.get('l'))) : true;
      if (!pro || !events.subscribe(sse[1], req, res)) sendJson(res, 503, { ok: false, error: 'busy' });
      return true;
    }
    // Une même adresse peut avoir plusieurs méthodes (GET /account, POST /account).
    const matching = routes.filter(([, pattern]) => pattern.test(pathname));
    if (matching.length === 0) return false;
    const [method, pattern, handler] = matching.find(([m]) => m === req.method) ?? matching[0];
    let entered = false;
    try {
      if (req.method !== method) fail(405, 'method');
      // Priorité seulement si le serveur sature : sinon, personne ne paie le coût de la vérification.
      entered = await gate.enter(gate.saturated ? await priorityOf(req, pathname) : false);
      if (!entered) fail(503, 'busy');
      sendJson(res, 200, await handler(req, pattern.exec(pathname).slice(1)));
    } catch (err) {
      if (err.status) sendJson(res, err.status, { ok: false, error: err.code });
      else {
        console.error(err);
        sendJson(res, 500, { ok: false, error: 'server' });
      }
    } finally {
      if (entered) gate.leave();
    }
    return true;
  };
}
