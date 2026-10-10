// Parcours complet contre un vrai serveur : création de lot, inscription chiffrée,
// appel par la souche, temps réel, relais des notifications, annulation et purge.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, utimesSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createServer } from '../lib/server.js';
import { purge } from '../lib/purge.js';
import { clientIp } from '../lib/http.js';
import * as wc from '../../public/assets/crypto.js';

let base;
let server;
let store;
let events;
let health;
let tmp;

before(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), 'wecallyou-'));
  const config = {
    domain: 'wecall.you',
    brand: 'WeCall.You',
    contact: 'mailto:contact@wecall.you',
    dataDir: path.join(tmp, 'data'),
    publicDir: path.join(tmp, 'public'),
    serveStatic: false,
    basePath: '/api',
    tokenKey: randomBytes(16),
    statusKey: randomBytes(32),
  };
  ({ server, store, events, health } = await createServer(config));
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${server.address().port}/api`;
});

after(() => {
  server.closeAllConnections();
  server.close();
  rmSync(tmp, { recursive: true, force: true });
});

async function call(method, route, body, authToken) {
  const headers = { 'Content-Type': 'application/json' };
  if (authToken) headers.Authorization = `Lot ${authToken}`;
  const res = await fetch(base + route, { method, headers, body: body && JSON.stringify(body) });
  return { status: res.status, ...(await res.json()) };
}

async function newLot(extra = {}) {
  const lot = await wc.createLot();
  const res = await call('POST', '/lots', { name: 'Snack Tony', channels: ['push', 'sms', 'wa', 'mail'], from: 1, to: 20, ...lot.request, ...extra });
  if (res.ok) res.tickets = (await call('POST', '/lot/tickets', { from: 1, to: 20 }, lot.authToken)).tickets;
  return { ...lot, res };
}

test('un lot peut compter 999 999 tickets, imprimés cahier par cahier, sans rien stocker', async () => {
  const lot = await newLot({ from: 1, to: 999_999 });
  assert.equal(lot.res.to, 999_999);
  const batch = await call('POST', '/lot/tickets', { from: 998_800, to: 999_999 }, lot.authToken);
  assert.equal(batch.tickets.length, 1200);
  assert.equal(batch.tickets.at(-1).label, '999999');
  assert.equal((await call('GET', `/t/${batch.tickets.at(-1).c}`)).n, 999_999);
  assert.equal((await call('POST', '/lot/tickets', { from: 1, to: 1201 }, lot.authToken)).status, 400);
  assert.equal((await call('POST', '/lots', { ...lot.request, name: 'x', from: 1, to: 1_000_000 })).status, 400);
});

test('création d’un lot et lecture publique d’un ticket', async () => {
  const lot = await newLot();
  assert.equal(lot.res.status, 200);
  assert.equal(lot.res.tickets.length, 20);
  const [first] = lot.res.tickets;
  assert.equal(first.label, '001');

  const client = await call('GET', `/t/${first.c}`);
  assert.equal(client.role, 'client');
  assert.equal(client.name, 'Snack Tony');
  assert.equal(client.pubEcdh, lot.request.pubEcdh);
  assert.equal(client.called, false);
  assert.equal('wrapped' in client, false);

  const stub = await call('GET', `/t/${first.s.toLowerCase()}`);
  assert.equal(stub.role, 'stub');
  assert.equal((await call('GET', `/t/${'A'.repeat(26)}`)).status, 404);
});

test('le serveur ne stocke que des blocs illisibles', async () => {
  const lot = await newLot();
  const ticket = lot.res.tickets[4];
  const blob = await wc.sealForLot(lot.request.pubEcdh, { c: 'sms', v: '+33612345678', l: 'fr' });
  const sub = await call('POST', '/sub', { t: ticket.c, blob, kind: 'sms' });
  assert.equal(sub.status, 200);
  const dir = path.join(tmp, 'data', 'subs', String(lot.res.lot), '5');
  const stored = readFileSync(path.join(dir, readdirSync(dir)[0]), 'utf8');
  assert.equal(stored, blob);
  for (const entry of readdirSync(path.join(tmp, 'data'), { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) assert.ok(!readFileSync(path.join(entry.parentPath, entry.name), 'utf8').includes('612345678'));
  }
});

test('parcours complet : inscription, temps réel, appel par la souche, relais', async () => {
  const lot = await newLot();
  const ticket = lot.res.tickets[1];
  const info = await call('GET', `/t/${ticket.c}`);

  const blob = await wc.sealForLot(info.pubEcdh, { c: 'mail', v: 'client@example.com', l: 'en' });
  const { rid } = await call('POST', '/sub', { t: ticket.c, blob, kind: 'mail' });
  assert.ok(rid);

  // Page client ouverte : connexion temps réel.
  const sse = await fetch(`${base}/events/${info.status}`);
  assert.equal(sse.headers.get('content-type'), 'text/event-stream; charset=utf-8');
  const reader = sse.body.getReader();

  // Sans la clé du lot, impossible d'appeler.
  assert.equal((await call('POST', '/call', { t: ticket.s })).status, 401);
  assert.equal((await call('POST', '/call', { t: ticket.c }, lot.authToken)).status, 404);

  const called = await call('POST', '/call', { t: ticket.s }, lot.authToken);
  assert.equal(called.status, 200);
  assert.equal(called.previousAt, null);
  assert.equal(called.clientToken, ticket.c);
  assert.equal(called.subs.length, 1);

  // Le téléphone du commerçant déchiffre localement.
  const lotInfo = await call('GET', '/lot', undefined, lot.authToken);
  const keys = await wc.openLot(lot.secret, lotInfo.wrapped);
  assert.deepEqual(await wc.openFromClient(keys.ecdh, called.subs[0].blob), { c: 'mail', v: 'client@example.com', l: 'en' });

  let received = '';
  while (!received.includes('event: ready')) received += new TextDecoder().decode((await reader.read()).value);
  await reader.cancel();

  assert.equal((await call('GET', `/t/${ticket.c}`)).called, true);
  const again = await call('POST', '/call', { n: 2 }, lot.authToken);
  assert.ok(again.previousAt > 0);

  // Le relais refuse ce qui ne vient pas de ce lot ou ne vise pas un service de notification.
  const ua = (await wc.createLot()).request.pubEcdh;
  const subscription = { endpoint: 'https://fcm.googleapis.com/fcm/send/x', keys: { p256dh: ua, auth: wc.b64u.encode(wc.randomBytes(16)) } };
  const good = await wc.buildPush({ subscription, payload: { t: 1 }, vapidKey: keys.vapid, vapidPublic: lot.request.pubVapid, subject: 'mailto:a@b.c' });
  const evil = { ...good, endpoint: 'https://example.com/steal' };
  assert.equal((await call('POST', '/relay', { n: 2, messages: [evil] }, lot.authToken)).status, 400);
  const other = await newLot();
  assert.equal((await call('POST', '/relay', { n: 2, messages: [good] }, other.authToken)).status, 400);

  assert.equal((await call('POST', '/unsub', { t: ticket.c, rid })).ok, true);
  assert.equal((await call('POST', '/call', { n: 2 }, lot.authToken)).subs.length, 0);
});

test('3 inscriptions maximum par ticket', async () => {
  const lot = await newLot();
  const ticket = lot.res.tickets[2];
  const blob = await wc.sealForLot(lot.request.pubEcdh, { c: 'sms', v: '+33600000000', l: 'fr' });
  for (let i = 0; i < 3; i++) assert.equal((await call('POST', '/sub', { t: ticket.c, blob, kind: 'sms' })).status, 200);
  assert.equal((await call('POST', '/sub', { t: ticket.c, blob, kind: 'sms' })).status, 409);
  assert.equal((await call('POST', '/sub', { t: ticket.s, blob, kind: 'sms' })).status, 404);
});

test('réglages et tickets supplémentaires réservés au lot', async () => {
  const lot = await newLot();
  const more = await call('POST', '/lot/tickets', { from: 21, to: 30 }, lot.authToken);
  assert.equal(more.tickets.length, 10);
  assert.equal((await call('POST', '/lot/tickets', { from: 1, to: 1300 }, lot.authToken)).status, 400);
  const settings = await call(
    'POST',
    '/lot/settings',
    { name: 'Tournoi U11', channels: ['sms'], promo: 'Merci à la Boulangerie Martin\n', link: 'https://instagram.com/club' },
    lot.authToken,
  );
  assert.deepEqual(settings.channels, ['sms']);
  const page = await call('GET', `/t/${more.tickets[0].c}`);
  assert.equal(page.name, 'Tournoi U11');
  assert.equal(page.promo, 'Merci à la Boulangerie Martin');
  assert.equal(page.link, 'https://instagram.com/club');
  for (const link of ['javascript:alert(1)', 'http://insecure.example', 'https://user:pw@example.com']) {
    assert.equal((await call('POST', '/lot/settings', { name: 'x', channels: [], link }, lot.authToken)).status, 400);
  }
  assert.equal((await call('GET', '/lot', undefined, 'x'.repeat(43))).status, 401);
});

test('cycle de vie : rien avant le scan, journal pendant, tout s’efface à la fin sauf les statistiques', async () => {
  const lot = await newLot({ ttl: 1 });
  const id = lot.res.lot;
  const ticket = lot.res.tickets[9];
  assert.equal((await call('POST', '/lots', { ...lot.request, name: 'x', from: 1, to: 2, ttl: 5 })).status, 400);

  // Imprimé, puis souche consultée : toujours rien sur le serveur.
  assert.equal(await store.isActive(id, 10), false);
  await call('GET', `/t/${ticket.s}`);
  assert.equal(await store.isActive(id, 10), false);

  // Premier scan du client : le ticket s'active.
  await call('GET', `/t/${ticket.c}`);
  await call('GET', `/t/${ticket.c}`);
  const blob = await wc.sealForLot(lot.request.pubEcdh, { c: 'wa', v: '+33611111111', l: 'fr' });
  await call('POST', '/sub', { t: ticket.c, blob, kind: 'wa' });
  await call('POST', '/call', { t: ticket.s }, lot.authToken);
  await call('POST', '/seen', { t: ticket.c });
  await call('POST', '/seen', { t: ticket.c });
  await call('POST', '/lot/event', { n: 10, type: 'send', detail: 'wa' }, lot.authToken);
  await call('POST', '/lot/event', { n: 10, type: 'send', detail: 'tel' }, lot.authToken); // le commerçant a téléphoné
  assert.equal((await call('POST', '/lot/event', { n: 10, type: 'send', detail: 'fax' }, lot.authToken)).status, 400);
  assert.equal((await call('POST', '/lot/event', { n: 11, type: 'send', detail: 'wa' }, lot.authToken)).status, 404);

  const history = await call('GET', '/lot/history', undefined, lot.authToken);
  const entry = history.tickets.find((t) => t.n === 10);
  assert.deepEqual(entry.events.map(([, type, detail]) => (detail ? `${type}:${detail}` : type)), ['scan', 'sub:wa', 'call', 'seen', 'send:wa', 'send:tel']);
  assert.ok(!JSON.stringify(history).includes('611111111'));

  // 30 min après l'appel : la coordonnée chiffrée disparaît, le journal (anonyme) reste.
  const subDir = store.subsPath(id, 10);
  const before = new Date(Date.now() - 40 * 60_000);
  for (const f of readdirSync(subDir)) utimesSync(path.join(subDir, f), before, before);
  const calledAt = new Date(Date.now() - 35 * 60_000);
  utimesSync(store.callFile(id, 10), calledAt, calledAt);
  await purge(store);
  assert.equal(existsSync(subDir), false);
  assert.equal(await store.isActive(id, 10), true);

  // Fin de vie (1 h après le premier scan) : plus rien sur ce ticket, sauf des compteurs.
  const statusFile = store.statusFile(store.statusId(id, 10));
  assert.ok(existsSync(statusFile));
  const done = await purge(store, Date.now() + 61 * 60_000);
  assert.ok(done.tickets >= 1);
  assert.equal(await store.isActive(id, 10), false);
  assert.equal(existsSync(statusFile), false);
  assert.equal(existsSync(store.callFile(id, 10)), false);

  const [day] = (await call('GET', '/lot/stats', undefined, lot.authToken)).days;
  assert.equal(day.scan, 1);
  assert.equal(day.sub_wa, 1);
  assert.equal(day.call, 1);
  assert.equal(day.seen, 1);
  assert.equal(day.send_wa, 1);
  assert.equal(day.waits, 1);
});

test('file d’attente : position et attente estimée, calculées sur le rythme des appels', async () => {
  const lot = await newLot();
  const id = lot.res.lot;
  const sixth = lot.res.tickets[5];
  assert.equal((await call('GET', `/t/${sixth.c}`)).queue, null); // aucun appel : pas d'estimation

  for (const n of [1, 2, 3]) await call('POST', '/call', { n }, lot.authToken);
  const now = Date.now();
  for (const [n, minutesAgo] of [[1, 6], [2, 3], [3, 0]]) {
    const at = new Date(now - minutesAgo * 60_000);
    utimesSync(store.callFile(id, n), at, at);
  }
  store.forgetQueue(id);

  const info = await call('GET', `/t/${sixth.c}`);
  assert.deepEqual(info.queue, { position: 3, last: '003', waitMin: 9 });
  assert.equal((await call('GET', `/t/${lot.res.tickets[1].c}`)).queue, null); // déjà appelé

  const screen = await call('GET', '/lot/queue', undefined, lot.authToken);
  assert.equal(screen.last, '003');
  assert.deepEqual(screen.recent.map((c) => c.label), ['003', '002', '001']);
  assert.equal(screen.avgMs, 180_000);
  assert.equal((await call('GET', '/lot/queue')).status, 401);
});

test('sécurité : requêtes malformées, essais de clés au hasard, relais verrouillé', async () => {
  for (const bad of ['/t/%E0%A4%A', '/t/../../etc/passwd', '/events/..%2F..%2Fx', '/%00']) {
    const res = await fetch(base + bad);
    assert.ok(res.status >= 400 && res.status < 500, `${bad} → ${res.status}`);
  }
  const raw = await fetch(`${base}/sub`, { method: 'POST', body: '{"t":' });
  assert.equal(raw.status, 400);
  const big = await fetch(`${base}/sub`, { method: 'POST', body: JSON.stringify({ blob: 'x'.repeat(70_000) }) });
  assert.equal(big.status, 413);

  let status = 0;
  for (let i = 0; i < 70 && status !== 429; i++) status = (await call('GET', '/lot', undefined, wc.b64u.encode(wc.randomBytes(32)))).status;
  assert.equal(status, 429);
  assert.equal((await call('GET', '/info')).ok, true); // le serveur tient
});

test('adresse du visiteur : seul l’en-tête réécrit par le frontal compte, les autres se falsifient', async () => {
  // Mesuré sur o2switch : X-Real-IP est toujours remplacé par la vraie adresse, CF-Connecting-IP passe tel quel.
  const tryKey = (realIp) => fetch(`${base}/lot`, { headers: { Authorization: `Lot ${wc.b64u.encode(wc.randomBytes(32))}`, 'X-Real-IP': realIp, 'CF-Connecting-IP': `198.51.100.${Math.floor(Math.random() * 255)}`, 'X-Forwarded-For': `192.0.2.${Math.floor(Math.random() * 255)}` } });
  let status = 0;
  for (let i = 0; i < 70 && status !== 429; i++) status = (await tryKey('203.0.113.7')).status;
  assert.equal(status, 429); // changer de fausse adresse à chaque essai ne contourne plus la limite
  assert.equal((await tryKey('203.0.113.8')).status, 401); // une autre vraie adresse a sa propre limite
  const req = (headers) => ({ headers, socket: { remoteAddress: '127.0.0.1' } });
  assert.equal(clientIp(req({ 'cf-connecting-ip': '198.51.100.1' })), '127.0.0.1');
  assert.equal(clientIp(req({ 'cf-connecting-ip': '198.51.100.1' }), 'cf-connecting-ip'), '198.51.100.1'); // derrière le proxy Cloudflare
  assert.equal(clientIp(req({ 'x-real-ip': '203.0.113.7' }), ''), '127.0.0.1'); // sans frontal
});

test('listes, groupes, message personnalisé et écran public', async () => {
  const lot = await newLot();
  const settings = await call(
    'POST',
    '/lot/settings',
    {
      name: 'Tournoi U11',
      channels: ['push', 'sms'],
      template: '{groupe} : attendus au {Terrain} !',
      lists: [{ name: 'Terrain', options: ['Terrain 1', 'Terrain 2', 'Terrain 3'] }, { name: 'Équipe', options: ['U11 > Rouge', 'U11 > Bleu'] }],
      groups: [{ name: 'U11 Rouge', numbers: '12-14, 20' }],
    },
    lot.authToken,
  );
  assert.equal(settings.status, 200);
  assert.equal(settings.lists[1].options[0], 'U11 > Rouge');
  assert.match(settings.screen, /^[A-Z2-7]{23}$/);
  assert.equal(lot.res.screen, settings.screen); // déjà connu à la création : imprimé sur la page clé
  for (const bad of [{ lists: [{ name: '<script>', options: [] }] }, { groups: [{ name: 'x', numbers: '1-5000' }] }, { groups: [{ name: 'x', numbers: 'abc' }] }]) {
    assert.equal((await call('POST', '/lot/settings', { name: 'x', channels: [], ...bad }, lot.authToken)).status, 400);
  }

  // La souche connaît les variables et le groupe de son ticket ; le ticket client, non.
  const twelve = (await call('POST', '/lot/tickets', { from: 12, to: 12 }, lot.authToken)).tickets[0];
  const stub = await call('GET', `/t/${twelve.s}`);
  assert.equal(stub.group, 'U11 Rouge');
  assert.equal(stub.template, '{groupe} : attendus au {Terrain} !');
  assert.equal('lists' in (await call('GET', `/t/${twelve.c}`)), false);

  // Appel du groupe entier avec le message choisi au moment de l'envoi.
  const group = await call('POST', '/call', { numbers: '12-14, 20', message: 'U11 Rouge : attendus au Terrain 3 !', tag: 'U11 Rouge · Terrain 3' }, lot.authToken);
  assert.deepEqual(group.calls.map((c) => c.label), ['012', '013', '014', '020']);
  const client = await call('GET', `/t/${twelve.c}`);
  assert.equal(client.called, true);
  assert.equal(client.message, 'U11 Rouge : attendus au Terrain 3 !');
  assert.equal((await call('POST', '/call', { numbers: '1-500' }, lot.authToken)).status, 400);

  // Écran public : numéros et repères seulement, lien révocable.
  const screen = await call('GET', `/screen/${settings.screen}`);
  assert.equal(screen.name, 'Tournoi U11');
  assert.equal(screen.recent[0].tag, 'U11 Rouge · Terrain 3');
  assert.equal(screen.recent.length, 4);
  assert.ok(screen.recent.every((c) => c.batch && c.batch === screen.recent[0].batch)); // un seul appel de groupe
  assert.ok(!JSON.stringify(screen).includes('pubEcdh'));
  const forged = settings.screen.slice(0, 22) + (settings.screen[22] === 'A' ? 'B' : 'A');
  assert.equal((await call('GET', `/screen/${forged}`)).status, 404);
  const reset = await call('POST', '/lot/screen/reset', {}, lot.authToken);
  assert.notEqual(reset.screen, settings.screen);
  assert.equal((await call('GET', `/screen/${settings.screen}`)).status, 404);
  assert.equal((await call('GET', `/screen/${reset.screen}`)).ok, true);
});

test('statistiques anonymes du mois', async () => {
  const info = await call('GET', '/info');
  assert.ok(info.stats.lots >= 1);
  assert.ok(info.stats.tickets >= 20);
  assert.equal(info.brand, 'WeCall.You');
  assert.equal(info.live.max, 2000); // pages en direct au plus (sur un hébergement limité : la moitié de ses connexions)
});

test('affiche : un numéro unique tiré au hasard par scan, ordre d’arrivée gardé, jamais imprimable, lien révocable', async () => {
  const lot = await newLot(); // tickets imprimés 1 à 20
  const auth = lot.authToken;
  const { poster } = await call('GET', '/lot', undefined, auth);
  assert.match(poster, /^[A-Z2-7]{23}$/);

  // Numéros de l'affiche : au hasard, au-delà des tickets imprimés (021 à 999), jamais deux fois.
  const first = await call('POST', `/poster/${poster}`, {});
  await new Promise((resolve) => setTimeout(resolve, 5)); // deux arrivées distinctes dans le temps
  const second = await call('POST', `/poster/${poster}`, {});
  for (const scan of [first, second]) assert.ok(/^\d{3}$/.test(scan.label) && Number(scan.label) >= 21, scan.label);
  assert.notEqual(first.label, second.label);
  const page = await call('GET', `/t/${first.code}`);
  assert.equal(page.label, first.label);
  assert.equal(page.role, 'client');
  const drawn = [first.label, second.label];
  for (let i = 0; i < 10; i++) drawn.push((await call('POST', `/poster/${poster}`, {})).label); // sous la limite de 30 scans par adresse (pour tout le fichier)
  assert.equal(new Set(drawn).size, 12); // 12 scans, 12 numéros différents
  assert.ok(drawn.some((l, i) => i > 0 && Number(l) < Number(drawn[i - 1]))); // aucun ordre croissant imposé

  // File d'arrivée : dans l'ordre des scans ; les numéros de l'affiche ne s'impriment pas.
  const state = await call('GET', '/lot', undefined, auth);
  assert.deepEqual(state.arrivals.slice(0, 2).map((a) => a.label), [first.label, second.label]);
  assert.equal(state.printTo, 20);
  assert.equal((await call('POST', '/lot/tickets', { from: 15, to: 25 }, auth)).status, 409);
  assert.equal((await call('POST', '/lot/tickets', { from: 1, to: 20 }, auth)).tickets.length, 20);

  // Un appel retire le ticket de la file d'arrivée.
  assert.equal((await call('POST', '/call', { n: Number(first.label) }, auth)).ok, true);
  assert.equal((await call('GET', '/lot', undefined, auth)).arrivals[0].label, second.label);

  // Lien falsifié refusé ; nouveau lien : l'ancien ne donne plus de numéro.
  const forged = poster.slice(0, 22) + (poster[22] === 'A' ? 'B' : 'A');
  assert.equal((await call('POST', `/poster/${forged}`, {})).status, 404);
  const reset = await call('POST', '/lot/poster/reset', {}, auth);
  assert.notEqual(reset.poster, poster);
  assert.equal((await call('POST', `/poster/${poster}`, {})).status, 404);
  assert.ok(!drawn.includes((await call('POST', `/poster/${reset.poster}`, {})).label));

  // Lot « affiche seule » : numéros à 3 chiffres dès 001, rien d'imprimable, plus de « reprise » (aucun ordre).
  const only = await wc.createLot();
  await call('POST', '/lots', { name: 'Fournil', channels: ['sms'], from: 1, to: 99, poster: 'only', ...only.request });
  const onlyPoster = (await call('GET', '/lot', undefined, only.authToken)).poster;
  assert.match((await call('POST', `/poster/${onlyPoster}`, {})).label, /^\d{3}$/);
  assert.equal((await call('POST', '/lot/tickets', { from: 1, to: 10 }, only.authToken)).status, 409);
  assert.equal((await call('POST', '/lot/poster/restart', {}, only.authToken)).status, 404);
});

test('numéros mélangés (« les deux », affiche seule) : tickets imprimés compris, uniques, sans ordre, affiche à part', async () => {
  const lot = await wc.createLot();
  const created = await call('POST', '/lots', { name: 'Snack mélangé', channels: ['sms'], from: 1, to: 40, numbering: 'random', ...lot.request });
  assert.equal(created.numbering, 'random');
  assert.equal(created.span, 999); // 3 chiffres : de la place pour les tickets et l'affiche
  const printed = (await call('POST', '/lot/tickets', { from: 1, to: 40 }, lot.authToken)).tickets;
  const numbers = printed.map((t) => t.n);
  assert.equal(new Set(numbers).size, 40);
  assert.ok(numbers.every((n) => n >= 1 && n <= 999));
  assert.ok(numbers.some((n, i) => i > 0 && n < numbers[i - 1])); // aucun ordre
  assert.notDeepEqual(numbers, Array.from({ length: 40 }, (_, i) => i + 1));
  // Le même ticket garde son numéro (réimpression) ; la page du client affiche ce numéro.
  assert.deepEqual((await call('POST', '/lot/tickets', { from: 5, to: 6 }, lot.authToken)).tickets.map((t) => t.n), numbers.slice(4, 6));
  assert.equal((await call('GET', `/t/${printed[0].c}`)).label, printed[0].label);
  // Au-delà des tickets prévus, ce sont les numéros de l'affiche : pas d'impression.
  assert.equal((await call('POST', '/lot/tickets', { from: 30, to: 41 }, lot.authToken)).status, 409);
  // L'affiche ne redonne jamais un numéro imprimé.
  const { poster } = await call('GET', '/lot', undefined, lot.authToken);
  const scans = [];
  for (let i = 0; i < 6; i++) scans.push((await call('POST', `/poster/${poster}`, {})).label);
  assert.equal(new Set(scans).size, 6);
  assert.ok(scans.every((l) => !printed.some((t) => t.label === l)));
  // Appel par le numéro imprimé, comme pour un lot ordinaire.
  assert.equal((await call('POST', '/call', { n: printed[3].n }, lot.authToken)).label, printed[3].label);

  // Affiche seule : numéros mélangés dès le premier scan.
  const only = await wc.createLot();
  const solo = await call('POST', '/lots', { name: 'Fournil mélangé', channels: ['sms'], from: 1, to: 1, poster: 'only', numbering: 'random', ...only.request });
  assert.equal(solo.to, 0); // aucun ticket à imprimer
  const soloPoster = (await call('GET', '/lot', undefined, only.authToken)).poster;
  const first = await call('POST', `/poster/${soloPoster}`, {});
  assert.match(first.label, /^\d{3}$/);
});

test('« Votez pour la suite » : compte obligatoire, trois voix, idées ouvertes seulement, voix effacées avec le compte', async () => {
  const account = await wc.createAccount('votante', 'mot-de-passe-long');
  assert.equal((await call('POST', '/account', account.request)).status, 200);
  const vote = async (idea, on = true, token = account.session.token) => {
    const res = await fetch(`${base}/votes`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Account ${token}` }, body: JSON.stringify({ idea, on }) });
    return { status: res.status, ...(await res.json()) };
  };
  // Sans compte : on lit les voix, on ne vote pas.
  assert.equal((await call('GET', '/votes')).mine, null);
  assert.equal((await call('POST', '/votes', { idea: 'termine', on: true })).ok, false);
  for (const idea of ['termine', 'bientot', 'pause']) assert.equal((await vote(idea)).ok, true);
  const full = await vote('stats');
  assert.equal(full.error, 'votes_full'); // trois voix par compte
  const back = await vote('pause', false);
  assert.deepEqual(back.mine, ['termine', 'bientot']);
  assert.equal(back.counts.termine, 1);
  assert.equal((await vote('stats')).ok, true);
  assert.equal((await vote('ajout-file')).error, 'idea'); // déjà livrée : plus de vote
  assert.equal((await vote('nimporte-quoi')).error, 'idea');
  // Le compte supprimé : ses voix aussi.
  await fetch(`${base}/account/delete`, { method: 'POST', headers: { Authorization: `Account ${account.session.token}` } });
  assert.equal((await call('GET', '/votes')).counts.termine, undefined);
});

test('le commerçant fait entrer un ticket dans la file : numéro tapé ou QR client scanné', async () => {
  const lot = await newLot();
  const [one, two, three] = lot.res.tickets;
  // Numéro tapé : le ticket s'active et entre dans la file d'arrivée, une seule fois.
  const added = await call('POST', '/lot/arrive', { n: 2 }, lot.authToken);
  assert.deepEqual([added.added, added.label], [true, '002']);
  assert.equal((await call('POST', '/lot/arrive', { n: 2 }, lot.authToken)).added, false);
  // QR client scanné (par le client ou le commerçant) : la page dit si ce scan l'a fait entrer.
  assert.equal((await call('GET', `/t/${three.c}`)).activated, true);
  assert.equal((await call('GET', `/t/${three.c}`)).activated, false);
  assert.equal((await call('GET', `/t/${one.s}`)).activated, false); // une souche n'active rien
  const { arrivals } = await call('GET', '/lot', undefined, lot.authToken);
  assert.deepEqual(arrivals.map((a) => a.n), [two.n, three.n]);
  // Déjà appelé : il ne revient pas dans la file.
  await call('POST', '/call', { n: 2 }, lot.authToken);
  assert.equal((await call('POST', '/lot/arrive', { n: 2 }, lot.authToken)).called, true);
  // Seulement les tickets de cette file, et seulement pour son commerçant.
  assert.equal((await call('POST', '/lot/arrive', { n: 21 }, lot.authToken)).error, 'not_issued');
  assert.notEqual((await call('POST', '/lot/arrive', { n: 3 })).ok, true); // 401, ou 429 si trop d'essais

  // Numéros mélangés : un numéro imprimé entre, un numéro jamais imprimé est refusé.
  const mixed = await wc.createLot();
  await call('POST', '/lots', { name: 'Snack mélangé', channels: ['sms'], from: 1, to: 10, numbering: 'random', ...mixed.request });
  const printed = (await call('POST', '/lot/tickets', { from: 1, to: 10 }, mixed.authToken)).tickets.map((t) => t.n);
  assert.equal((await call('POST', '/lot/arrive', { n: printed[7] }, mixed.authToken)).added, true);
  const stranger = Array.from({ length: 999 }, (_, i) => i + 1).find((n) => !printed.includes(n));
  assert.equal((await call('POST', '/lot/arrive', { n: stranger }, mixed.authToken)).error, 'not_issued');
});

test('bulletin de santé : files actives, clients du mois, direct plein compté, rien de personnel', async () => {
  const before = (await health.month()).full;
  const max = events.maxClients;
  events.maxClients = 0; // plus aucune place en direct
  const res = await fetch(`${base}/events/${'a'.repeat(32)}`);
  assert.equal(res.status, 503);
  await res.body?.cancel();
  events.maxClients = max;
  assert.equal((await health.month()).full, before + 1);
  const view = await call('GET', '/health');
  assert.equal(view.ok, true);
  assert.equal(view.month, new Date().toISOString().slice(0, 7));
  assert.ok(view.queues >= 1); // les files des tests précédents
  assert.ok(view.tickets >= 1);
  assert.equal(view.host, null); // sans hébergeur cPanel, pas de mesure de charge
  assert.equal(view.load, null);
  assert.deepEqual(Object.keys(view).filter((key) => key !== 'status').sort(), ['busyHours', 'calls', 'full', 'host', 'limits', 'live', 'load', 'month', 'ok', 'pages', 'pagesQueues', 'priority', 'queues', 'tickets', 'wait']);
});
