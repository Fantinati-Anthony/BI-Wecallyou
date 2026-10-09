// Vérifie la cryptographie du navigateur (public/assets/crypto.js) avec une implémentation
// indépendante basée sur node:crypto : déchiffrement RFC 8291 et vérification VAPID.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createECDH, createDecipheriv, createPublicKey, hkdfSync, verify } from 'node:crypto';
import * as wc from '../../public/assets/crypto.js';

test('clé de lot : texte imprimé ↔ octets', () => {
  const secret = wc.randomBytes(16);
  const grouped = wc.secretToText(secret, true);
  assert.match(grouped, /^([A-Z2-7]{4}-){6}[A-Z2-7]{2}$/);
  assert.deepEqual(wc.textToSecret(grouped.toLowerCase()), secret);
  assert.equal(wc.textToSecret('trop court'), null);
});

test('lot : les clés privées ne s’ouvrent qu’avec la bonne clé de lot', async () => {
  const lot = await wc.createLot();
  assert.equal(lot.request.verifier, await wc.verifierOf(lot.authToken));
  assert.equal(await wc.authTokenOf(lot.secret), lot.authToken);
  const keys = await wc.openLot(lot.secret, lot.request.wrapped);
  assert.equal(keys.ecdh.type, 'private');
  await assert.rejects(wc.openLot(wc.randomBytes(16), lot.request.wrapped));
});

test('mot de passe du lot : sans lui, la page 1 ne vaut rien', async () => {
  const lot = await wc.createLot({ password: 'Tournoi-U11 2026' });
  assert.equal(lot.material.length, 48);
  await assert.rejects(wc.openLot(lot.secret, lot.request.wrapped));
  await assert.rejects(wc.openLot(await wc.lotMaterial(lot.secret, 'tournoi-u11 2026'), lot.request.wrapped));
  assert.notEqual(await wc.authTokenOf(lot.secret), lot.authToken);
  const material = await wc.lotMaterial(lot.secret, 'Tournoi-U11 2026');
  assert.deepEqual(material, lot.material);
  assert.equal(await wc.authTokenOf(material), lot.authToken);
  assert.equal((await wc.openLot(material, lot.request.wrapped)).vapid.type, 'private');
});

test('coordonnées : chiffrées par le client, lisibles par le seul lot', async () => {
  const lot = await wc.createLot();
  const other = await wc.createLot();
  const data = { c: 'sms', v: '+33612345678', l: 'fr' };
  const blob = await wc.sealForLot(lot.request.pubEcdh, data);
  assert.ok(!blob.includes('33612345678'));
  const keys = await wc.openLot(lot.secret, lot.request.wrapped);
  assert.deepEqual(await wc.openFromClient(keys.ecdh, blob), data);
  const otherKeys = await wc.openLot(other.secret, other.request.wrapped);
  await assert.rejects(wc.openFromClient(otherKeys.ecdh, blob));
});

/** Déchiffrement RFC 8291 côté « téléphone du client », écrit indépendamment avec node:crypto. */
function decryptPush(body, uaEcdh, authSecret) {
  const salt = body.subarray(0, 16);
  const rs = body.readUInt32BE(16);
  const idLen = body[20];
  const asPublic = body.subarray(21, 21 + idLen);
  const ciphertext = body.subarray(21 + idLen);
  const uaPublic = uaEcdh.getPublicKey();
  const shared = uaEcdh.computeSecret(asPublic);
  const info = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', shared, authSecret, info, 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(ciphertext.subarray(-16));
  const padded = Buffer.concat([decipher.update(ciphertext.subarray(0, -16)), decipher.final()]);
  assert.equal(rs, 4096);
  assert.equal(padded.at(-1), 2);
  return JSON.parse(padded.subarray(0, -1).toString('utf8'));
}

test('notification : lisible par le téléphone du client, signée par le lot', async () => {
  const lot = await wc.createLot();
  const keys = await wc.openLot(lot.secret, lot.request.wrapped);
  const ua = createECDH('prime256v1');
  ua.generateKeys();
  const authSecret = Buffer.from(wc.randomBytes(16));
  const subscription = {
    endpoint: 'https://fcm.googleapis.com/fcm/send/abc123',
    keys: { p256dh: wc.b64u.encode(ua.getPublicKey()), auth: wc.b64u.encode(authSecret) },
  };
  const payload = { title: 'Snack Tony', body: 'Ticket n°042 : c’est à vous !', url: '/ABC' };
  const msg = await wc.buildPush({
    subscription,
    payload,
    vapidKey: keys.vapid,
    vapidPublic: lot.request.pubVapid,
    subject: 'mailto:contact@wecall.you',
  });

  assert.deepEqual(decryptPush(Buffer.from(msg.body, 'base64url'), ua, authSecret), payload);

  const [, jwt, k] = /^vapid t=([^,]+), k=(.+)$/.exec(msg.authorization);
  assert.equal(k, lot.request.pubVapid);
  const [h, c, s] = jwt.split('.');
  const claims = JSON.parse(Buffer.from(c, 'base64url'));
  assert.equal(claims.aud, 'https://fcm.googleapis.com');
  assert.equal(claims.sub, 'mailto:contact@wecall.you');
  assert.ok(claims.exp > Date.now() / 1000 && claims.exp <= Date.now() / 1000 + 24 * 3600);
  const raw = Buffer.from(lot.request.pubVapid, 'base64url');
  const publicKey = createPublicKey({
    key: { kty: 'EC', crv: 'P-256', x: raw.subarray(1, 33).toString('base64url'), y: raw.subarray(33).toString('base64url') },
    format: 'jwk',
  });
  assert.ok(verify('sha256', Buffer.from(`${h}.${c}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url')));
});
