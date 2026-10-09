// Comptes « zéro connaissance », fiche de secours, statut Pro par Stripe et priorité en affluence.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHmac, randomBytes } from 'node:crypto';
import { createServer } from '../lib/server.js';
import { Gate } from '../lib/priority.js';
import { applyEvent } from '../lib/stripe.js';
import * as wc from '../../public/assets/crypto.js';

const SECRET = 'whsec_test_secret';
let base;
let server;
let accounts;
let tmp;

before(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), 'wecallyou-acc-'));
  ({ server, accounts } = await createServer({
    domain: 'wecall.you',
    brand: 'WeCallYou',
    contact: 'mailto:contact@wecall.you',
    dataDir: path.join(tmp, 'data'),
    publicDir: path.join(tmp, 'public'),
    serveStatic: false,
    basePath: '/api',
    tokenKey: randomBytes(16),
    statusKey: randomBytes(32),
    stripeWebhookSecret: SECRET,
    capacity: 40,
  }));
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${server.address().port}/api`;
});

after(() => {
  server.closeAllConnections();
  server.close();
  rmSync(tmp, { recursive: true, force: true });
});

async function call(method, route, body, auth) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth) headers.Authorization = auth;
  const res = await fetch(base + route, { method, headers, body: body && JSON.stringify(body) });
  return { status: res.status, ...(await res.json()) };
}

async function stripe(event, secret = SECRET) {
  const raw = JSON.stringify(event);
  const t = Math.floor(Date.now() / 1000);
  const sig = createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex');
  const res = await fetch(`${base}/stripe/webhook`, { method: 'POST', headers: { 'Stripe-Signature': `t=${t},v1=${sig}` }, body: raw });
  return { status: res.status, ...(await res.json()) };
}

test('compte : création, connexion, coffre chiffré, conflit entre deux téléphones', async () => {
  const created = await wc.createAccount('Snack.Tony', 'un mot de passe solide');
  const res = await call('POST', '/account', created.request);
  assert.equal(res.status, 200);
  assert.equal((await call('POST', '/account', (await wc.createAccount('snack.tony', 'autre mot de passe!')).request)).status, 409);
  assert.equal((await call('POST', '/account', { ...created.request, ident: 'no' })).status, 400);

  // Le serveur ne garde ni l'identifiant ni rien de lisible.
  const stored = readFileSync(path.join(tmp, 'data', 'accounts', `${res.id}.json`), 'utf8');
  assert.ok(!stored.toLowerCase().includes('snack.tony'));
  assert.ok(!readdirSync(path.join(tmp, 'data', 'keys')).some((f) => f.includes('snack')));

  // Connexion depuis un autre appareil : identifiant + mot de passe suffisent.
  const keys = await wc.loginKeys(' SNACK.tony ', 'un mot de passe solide');
  const me = await call('GET', '/account', undefined, `Account ${keys.token}`);
  assert.equal(me.id, res.id);
  const vaultKey = await wc.openVaultKey(keys.wrapKey, me.wrapPw);
  const vault = await wc.readVault(vaultKey, me.vault);
  assert.deepEqual(vault.lots, {});
  assert.equal(vault.recovery, wc.secretToText(created.recovery));
  assert.equal((await call('GET', '/account', undefined, `Account ${(await wc.loginKeys('snack.tony', 'mauvais')).token}`)).status, 401);

  const sealed = await wc.writeVault(vaultKey, { ...vault, lots: { 42: { key: 'X' } } });
  assert.equal((await call('POST', '/account/vault', { vault: sealed, version: me.version }, `Account ${keys.token}`)).version, me.version + 1);
  assert.equal((await call('POST', '/account/vault', { vault: sealed, version: me.version }, `Account ${keys.token}`)).status, 409);
});

test('fiche de secours : nouveau mot de passe sans rien perdre, ancienne fiche révocable', async () => {
  const created = await wc.createAccount('club-u11', 'mot de passe oublié bientôt');
  await call('POST', '/account', created.request);
  await call('POST', '/account/vault', { vault: await wc.writeVault(created.session.vaultKey, { lots: { 7: { key: 'K' } }, recovery: 'R' }), version: 1 }, `Account ${created.session.token}`);

  // Mot de passe oublié : la clé de secours de la fiche ouvre le coffre.
  const typed = wc.textToSecret(wc.secretToText(created.recovery, true).toLowerCase());
  const rec = await wc.recoveryKeys(typed);
  const recovered = await call('GET', '/account/recover', undefined, `Recovery ${rec.token}`);
  const vaultKey = await wc.openVaultKey(rec.wrapKey, recovered.wrapRec);
  assert.deepEqual((await wc.readVault(vaultKey, recovered.vault)).lots, { 7: { key: 'K' } });

  const fresh = await wc.newPassword('club-u11', 'nouveau mot de passe', vaultKey);
  assert.equal((await call('POST', '/account/password', { ...fresh.request, ident: 'club-u12' }, `Recovery ${rec.token}`)).status, 400);
  assert.equal((await call('POST', '/account/password', { ...fresh.request, ident: 'Club-U11' }, `Recovery ${rec.token}`)).ok, true);
  assert.equal((await call('GET', '/account', undefined, `Account ${created.session.token}`)).status, 401);
  assert.equal((await call('GET', '/account', undefined, `Account ${fresh.token}`)).ok, true);

  // Nouvelle fiche : l'ancienne ne marche plus.
  const rotated = await wc.newRecovery(vaultKey);
  assert.equal((await call('POST', '/account/recovery', rotated.request, `Account ${fresh.token}`)).ok, true);
  assert.equal((await call('GET', '/account/recover', undefined, `Recovery ${rec.token}`)).status, 401);
  const rec2 = await wc.recoveryKeys(rotated.recovery);
  assert.equal((await call('GET', '/account/recover', undefined, `Recovery ${rec2.token}`)).ok, true);
});

test('don pur : aucune contrepartie ; abonnement Pro : durée selon le montant et l’usage', async () => {
  const created = await wc.createAccount('boulangerie', 'mot de passe du four');
  const { id } = await call('POST', '/account', created.request);
  const auth = `Account ${created.session.token}`;

  // Un lot rattaché au compte profite de son statut.
  const lot = await wc.createLot();
  const made = await call('POST', '/lots', { name: 'Boulangerie', channels: ['sms'], from: 1, to: 10, ...lot.request });
  assert.equal((await call('POST', '/lots', { name: 'x', channels: [], from: 1, to: 2, ttl: 720, ...(await wc.createLot()).request })).status, 403);
  assert.equal((await call('POST', '/account/link', { lotAuth: lot.authToken }, auth)).ok, true);
  assert.equal((await call('POST', '/account/link', { lotAuth: 'x'.repeat(43) }, auth)).status, 404);
  // Compte gratuit : un seul lot ; plusieurs lots sur le compte, c'est le Pro.
  const other = await wc.createLot();
  const otherLot = await call('POST', '/lots', { name: 'Fournil du marché', channels: ['sms'], from: 1, to: 5, ...other.request });
  assert.equal((await call('POST', '/account/link', { lotAuth: other.authToken }, auth)).status, 403);
  assert.equal((await call('POST', '/account/link', { lotAuth: lot.authToken }, auth)).ok, true); // le sien : toujours permis
  const lotAuth = `Lot ${lot.authToken}`;
  let state = await call('GET', '/lot', undefined, lotAuth);
  assert.equal(state.lot, made.lot);
  assert.equal(state.owned, true);
  assert.equal(state.pro, false);

  // Options Pro refusées tant que le lot n'est pas Pro.
  const settings = (extra) => call('POST', '/lot/settings', { name: 'Boulangerie', channels: ['sms'], ...extra }, lotAuth);
  assert.equal((await settings({ ttl: 720 })).status, 403);
  assert.equal((await settings({ whiteLabel: true })).status, 403);
  assert.equal((await settings({ theme: { screenBg: '#102030' } })).status, 403);
  assert.equal((await settings({ theme: null })).status, 200); // les couleurs d'origine, toujours permises
  assert.equal((await call('GET', '/lot/stats?days=365', undefined, lotAuth)).max, 90);

  // Usage et prix conseillé : peu de tickets actifs → palier à 1 €.
  const me0 = await call('GET', '/account', undefined, auth);
  assert.deepEqual(me0.usage, { active: 0, suggested: 1 });

  // Don pur (lien sans compte) : rien n'est activé. Signature fausse : refusée.
  assert.equal((await stripe({ id: 'evt_don', type: 'checkout.session.completed', data: { object: { mode: 'payment', amount_total: 2000 } } })).result, 'no_account');
  const pro = { id: 'evt_1', type: 'checkout.session.completed', data: { object: { client_reference_id: id, mode: 'payment', amount_total: 300, customer: null } } };
  assert.equal((await stripe(pro, 'whsec_autre')).status, 400);

  // Pro en paiement unique : 3 € pour un usage conseillé à 1 €/mois = 3 mois ; jamais compté deux fois.
  assert.equal((await stripe(pro)).result, 'pro');
  assert.equal((await stripe(pro)).duplicate, true);
  const me = await call('GET', '/account', undefined, auth);
  assert.equal(me.pro, true);
  const days = (me.premiumUntil - Date.now()) / 86_400_000;
  assert.ok(days > 92 && days < 94, `${days} jours`);

  // En Pro, plusieurs lots sur le compte ; détacher un lot libère sa place.
  assert.equal((await call('POST', '/account/link', { lotAuth: other.authToken }, auth)).ok, true);
  assert.equal((await call('POST', '/account/unlink', { lot: otherLot.lot }, auth)).ok, true);
  assert.equal((await call('POST', '/account/unlink', { lot: otherLot.lot }, auth)).status, 404);

  // Les options Pro s'ouvrent.
  const opened = await settings({ ttl: 720, whiteLabel: true });
  assert.equal(opened.ttl, 720);
  assert.equal(opened.ttlApplied, 720);
  assert.equal(opened.whiteLabel, true);
  assert.equal((await call('GET', '/lot/stats?days=365', undefined, lotAuth)).max, 365);
  const ticket = (await call('POST', '/lot/tickets', { from: 1, to: 1 }, lotAuth)).tickets[0];
  assert.equal((await call('GET', `/t/${ticket.c}`)).whiteLabel, true);

  // Couleurs personnalisées : seules des couleurs valides sont gardées, écran public et page client les reçoivent.
  const themed = await settings({ theme: { screenBg: '#102030', screenNumber: '#FFCC00', accent: 'red', script: '#000000' } });
  const theme = { screenBg: '#102030', screenNumber: '#ffcc00' };
  assert.deepEqual(themed.themeSetting, theme);
  assert.deepEqual((await call('GET', `/t/${ticket.c}`)).theme, theme);
  assert.deepEqual((await call('GET', `/screen/${themed.screen}`)).theme, theme);
  assert.deepEqual((await settings({})).themeSetting, theme); // réglages enregistrés sans toucher aux couleurs

  // Abonnement mensuel : le 1er paiement lie le client Stripe, chaque facture prolonge.
  await stripe({ id: 'evt_2', type: 'checkout.session.completed', data: { object: { client_reference_id: id, mode: 'subscription', amount_total: 100, customer: 'cus_ABC' } } });
  const periodEnd = Math.floor(Date.now() / 1000) + 200 * 86_400;
  const invoice = { id: 'evt_3', type: 'invoice.paid', data: { object: { customer: 'cus_ABC', amount_paid: 100, lines: { data: [{ period: { end: periodEnd } }] } } } };
  assert.equal((await stripe(invoice)).result, 'pro');
  assert.ok((await call('GET', '/account', undefined, auth)).premiumUntil >= periodEnd * 1000);
  assert.equal((await stripe({ id: 'evt_4', type: 'invoice.paid', data: { object: { customer: 'cus_INCONNU', lines: { data: [] } } } })).result, 'unknown_customer');

  // Fin du Pro : gratuit à nouveau ; les tickets longue durée gardent 30 jours de marge, puis 48 h.
  const account = await accounts.get(id);
  account.premiumUntil = Date.now() - 1000;
  await accounts.save(account);
  assert.equal((await call('GET', '/account', undefined, auth)).pro, false);
  state = await call('GET', '/lot', undefined, lotAuth);
  assert.equal(state.ttlApplied, 720);
  assert.equal(state.whiteLabel, false);
  // Couleurs gardées mais plus appliquées ; les changer redemande le Pro, les retirer reste possible.
  assert.equal(state.theme, null);
  assert.deepEqual(state.themeSetting, theme);
  assert.equal((await call('GET', `/screen/${state.screen}`)).theme, null);
  assert.equal((await settings({ theme: { screenBg: '#000000' } })).status, 403);
  assert.equal((await settings({ theme: null })).themeSetting, null);
  account.premiumUntil = Date.now() - 31 * 86_400_000;
  await accounts.save(account);
  assert.equal((await call('GET', '/lot', undefined, lotAuth)).ttlApplied, 48);
});

test('prix proportionnel : payer sous le conseillé raccourcit le Pro ; liens Pro distincts des dons', async () => {
  const fake = new Map([['A', { premiumUntil: 0 }]]);
  const store = {
    get: async (id) => fake.get(id) ?? null,
    extendPro: async (id, until) => fake.set(id, { ...fake.get(id), premiumUntil: Math.max(fake.get(id)?.premiumUntil ?? 0, until) }),
    linkCustomer: async () => {},
    accountOfCustomer: async () => 'A',
  };
  const now = Date.now();
  const pricing = { suggested: async () => 3, proLinks: ['plink_pro'] };
  // Un paiement par un autre lien (un don) n'active rien, même avec un compte.
  const don = { type: 'checkout.session.completed', data: { object: { client_reference_id: 'A', payment_link: 'plink_don', amount_total: 900 } } };
  assert.equal(await applyEvent(don, store, pricing, now), 'not_pro');
  // 1 € pour un usage conseillé à 3 €/mois : un tiers de mois.
  const small = { type: 'checkout.session.completed', data: { object: { client_reference_id: 'A', payment_link: 'plink_pro', mode: 'payment', amount_total: 100 } } };
  await applyEvent(small, store, pricing, now);
  const days = (fake.get('A').premiumUntil - now) / 86_400_000;
  assert.ok(days > 10 && days < 11, `${days} jours`);
});

test('suppression d’un compte', async () => {
  const created = await wc.createAccount('a-supprimer', 'mot de passe éphémère');
  await call('POST', '/account', created.request);
  assert.equal((await call('POST', '/account/delete', {}, `Account ${created.session.token}`)).ok, true);
  assert.equal((await call('GET', '/account', undefined, `Account ${created.session.token}`)).status, 401);
  assert.equal((await call('POST', '/account', created.request)).status, 200); // identifiant libéré
});

test('priorité : seulement en affluence, le Pro passe devant, le gratuit attend son tour', async () => {
  const gate = new Gate({ capacity: 1, maxWait: 500 });
  assert.equal(await gate.enter(false), true);
  assert.equal(gate.saturated, true);
  const order = [];
  const waiting = gate.enter(false).then((ok) => order.push(`gratuit:${ok}`));
  assert.equal(await gate.enter(true), true); // Pro : passe tout de suite malgré l'affluence
  order.push('pro');
  gate.leave();
  gate.leave(); // une place se libère : le gratuit en attente passe
  await waiting;
  assert.deepEqual(order, ['pro', 'gratuit:true']);
  gate.leave();
  assert.equal(gate.active, 0);

  const full = new Gate({ capacity: 1, maxWait: 50 });
  await full.enter(false);
  assert.equal(await full.enter(false), false); // trop attendu : refus propre (la page réessaiera)
});
