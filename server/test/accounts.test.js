// Comptes « zéro connaissance », fiche de secours, statut Pro par Stripe et priorité en affluence.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHmac, randomBytes } from 'node:crypto';
import { createServer } from '../lib/server.js';
import { Gate } from '../lib/priority.js';
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

test('Pro : chaque don active un mois, le don mensuel prolonge jusqu’à la fin de la période', async () => {
  const created = await wc.createAccount('boulangerie', 'mot de passe du four');
  const { id } = await call('POST', '/account', created.request);
  const auth = `Account ${created.session.token}`;

  // Un lot rattaché au compte profite de son statut.
  const lot = await wc.createLot();
  const made = await call('POST', '/lots', { name: 'Boulangerie', channels: ['sms'], from: 1, to: 10, ...lot.request });
  assert.equal((await call('POST', '/account/link', { lotAuth: lot.authToken }, auth)).ok, true);
  assert.equal((await call('POST', '/account/link', { lotAuth: 'x'.repeat(43) }, auth)).status, 404);
  let state = await call('GET', '/lot', undefined, `Lot ${lot.authToken}`);
  assert.equal(state.lot, made.lot);
  assert.equal(state.owned, true);
  assert.equal(state.pro, false);

  // Signature fausse ou absente : refusée.
  const session = { id: 'evt_1', type: 'checkout.session.completed', data: { object: { client_reference_id: id, mode: 'payment', customer: null } } };
  assert.equal((await stripe(session, 'whsec_autre')).status, 400);

  // Don ponctuel : un mois de Pro ; le même événement reçu deux fois ne compte qu'une fois.
  assert.equal((await stripe(session)).result, 'pro');
  assert.equal((await stripe(session)).duplicate, true);
  const me = await call('GET', '/account', undefined, auth);
  assert.equal(me.pro, true);
  const month = me.premiumUntil - Date.now();
  assert.ok(month > 30 * 86_400_000 && month < 32 * 86_400_000);
  state = await call('GET', '/lot', undefined, `Lot ${lot.authToken}`);
  assert.equal(state.pro, true);

  // Don mensuel : le premier paiement lie le client Stripe, les factures prolongent.
  await stripe({ id: 'evt_2', type: 'checkout.session.completed', data: { object: { client_reference_id: id, mode: 'subscription', customer: 'cus_ABC' } } });
  const periodEnd = Math.floor(Date.now() / 1000) + 90 * 86_400;
  assert.equal((await stripe({ id: 'evt_3', type: 'invoice.paid', data: { object: { customer: 'cus_ABC', lines: { data: [{ period: { end: periodEnd } }] } } } })).result, 'pro');
  const later = await call('GET', '/account', undefined, auth);
  assert.ok(later.premiumUntil >= periodEnd * 1000);
  assert.equal((await stripe({ id: 'evt_4', type: 'invoice.paid', data: { object: { customer: 'cus_INCONNU', lines: { data: [] } } } })).result, 'unknown_customer');

  // Fin du Pro : le compte repasse en gratuit tout seul, sans rien supprimer.
  const account = await accounts.get(id);
  account.premiumUntil = Date.now() - 1000;
  await accounts.save(account);
  assert.equal((await call('GET', '/account', undefined, auth)).pro, false);
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
