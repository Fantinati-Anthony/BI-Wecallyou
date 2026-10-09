// Toute la cryptographie tourne dans les navigateurs (WebCrypto), jamais sur le serveur.
//
//  - Clé de lot : 16 octets aléatoires, imprimés en page 1 du PDF. Le serveur ne la voit jamais.
//    Elle sert à déverrouiller les clés privées du lot et à s'identifier (par une empreinte).
//  - Le client chiffre ses coordonnées pour la clé publique du lot (ECDH P-256 + AES-GCM).
//  - Le commerçant fabrique lui-même les notifications (RFC 8291 + VAPID RFC 8292) ;
//    le serveur ne fait que les relayer.
//
// Module utilisable tel quel dans le navigateur et dans Node (tests).

const subtle = globalThis.crypto.subtle;
const text = new TextEncoder();
const EMPTY = new Uint8Array(0);
const P256_ECDH = { name: 'ECDH', namedCurve: 'P-256' };
const P256_ECDSA = { name: 'ECDSA', namedCurve: 'P-256' };

/* --------------------------------------------------------------- encodages */

export const b64u = {
  encode(bytes) {
    let bin = '';
    for (const b of new Uint8Array(bytes)) bin += String.fromCharCode(b);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  },
  decode(str) {
    const bin = atob(str.replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  },
};

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export const base32 = {
  encode(bytes) {
    let bits = 0;
    let value = 0;
    let out = '';
    for (const byte of bytes) {
      value = (value << 8) | byte;
      bits += 8;
      while (bits >= 5) {
        out += BASE32[(value >>> (bits - 5)) & 31];
        bits -= 5;
      }
    }
    if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
    return out;
  },
  decode(str) {
    let bits = 0;
    let value = 0;
    const out = [];
    for (const ch of str.toUpperCase()) {
      const v = BASE32.indexOf(ch);
      if (v < 0) return null;
      value = (value << 5) | v;
      bits += 5;
      if (bits >= 8) {
        out.push((value >>> (bits - 8)) & 255);
        bits -= 8;
      }
    }
    return Uint8Array.from(out);
  },
};

export function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

export const randomBytes = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));

const hex = (bytes) => Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');

async function hkdf(ikm, salt, info, length) {
  const key = await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8));
}

const aesKey = (raw, usages = ['encrypt', 'decrypt']) => subtle.importKey('raw', raw, 'AES-GCM', false, usages);

/* ------------------------------------------------------------ clé de lot */

/** Texte imprimé (26 caractères, par groupes de 4) ↔ 16 octets. Renvoie null si le texte est invalide. */
export function secretToText(secret, grouped = false) {
  const plain = base32.encode(secret);
  return grouped ? plain.match(/.{1,4}/g).join('-') : plain;
}

export function textToSecret(value) {
  const clean = String(value).toUpperCase().replace(/[^A-Z2-7]/g, '');
  const bytes = clean.length === 26 ? base32.decode(clean) : null;
  return bytes && bytes.length === 16 ? bytes : null;
}

export const PASSWORD_ITERATIONS = 600_000;

/**
 * « Matière » du lot : la clé imprimée, renforcée par le mot de passe du lot s'il y en a un.
 * Le mot de passe est étiré (PBKDF2, 600 000 tours) : la page 1 seule ne suffit plus,
 * et deviner le mot de passe coûte cher, même avec la page en main.
 */
export async function lotMaterial(secret, password = '') {
  if (!password) return secret;
  const pw = await subtle.importKey('raw', text.encode(password.normalize('NFKC')), 'PBKDF2', false, ['deriveBits']);
  const salt = concat(text.encode('wecallyou/lot/password'), secret);
  const stretched = await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PASSWORD_ITERATIONS }, pw, 256);
  return concat(secret, new Uint8Array(stretched));
}

/** Ce que la matière du lot permet d'obtenir : le jeton d'accès et la clé qui protège les clés privées. */
async function lotAccess(material) {
  const wrapKey = await aesKey(await hkdf(material, EMPTY, text.encode('wecallyou/lot/wrap'), 32));
  const authToken = b64u.encode(await hkdf(material, EMPTY, text.encode('wecallyou/lot/auth'), 32));
  return { wrapKey, authToken };
}

export async function authTokenOf(material) {
  return (await lotAccess(material)).authToken;
}

/** Empreinte du jeton d'accès : c'est tout ce que le serveur conserve pour reconnaître le lot. */
export async function verifierOf(authToken) {
  return hex(await subtle.digest('SHA-256', text.encode(authToken)));
}

/** Création d'un lot : nouvelle clé de lot, paires de clés, clés privées chiffrées. */
export async function createLot({ password = '' } = {}) {
  const secret = randomBytes(16);
  const material = await lotMaterial(secret, password);
  const { wrapKey, authToken } = await lotAccess(material);
  const ecdh = await subtle.generateKey(P256_ECDH, true, ['deriveBits']);
  const vapid = await subtle.generateKey(P256_ECDSA, true, ['sign', 'verify']);
  const privateKeys = JSON.stringify({
    ecdh: await subtle.exportKey('jwk', ecdh.privateKey),
    vapid: await subtle.exportKey('jwk', vapid.privateKey),
  });
  const iv = randomBytes(12);
  const wrapped = concat(iv, new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, wrapKey, text.encode(privateKeys))));
  return {
    secret,
    material,
    authToken,
    request: {
      pubEcdh: b64u.encode(await subtle.exportKey('raw', ecdh.publicKey)),
      pubVapid: b64u.encode(await subtle.exportKey('raw', vapid.publicKey)),
      wrapped: b64u.encode(wrapped),
      verifier: await verifierOf(authToken),
    },
  };
}

/** Déverrouille les clés privées d'un lot avec sa matière (téléphone du commerçant uniquement). */
export async function openLot(material, wrapped) {
  const { wrapKey } = await lotAccess(material);
  const bytes = b64u.decode(wrapped);
  const plain = await subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12) }, wrapKey, bytes.slice(12));
  const jwk = JSON.parse(new TextDecoder().decode(plain));
  return {
    ecdh: await subtle.importKey('jwk', jwk.ecdh, P256_ECDH, false, ['deriveBits']),
    vapid: await subtle.importKey('jwk', jwk.vapid, P256_ECDSA, false, ['sign']),
  };
}

/* ------------------------------------------------- comptes (facultatifs) */
//
// Le mot de passe (étiré par PBKDF2) et la clé de secours (imprimée sur la fiche) ouvrent chacun la
// même « clé du coffre ». Le coffre, chiffré avec elle, contient les clés des lots du compte.
// Le serveur ne reçoit que des empreintes et des blocs chiffrés : sans mot de passe ni fiche de
// secours, personne (pas même nous) ne peut ouvrir un compte.

export const normalizeIdent = (ident) => String(ident).trim().toLowerCase();

async function sealBytes(key, bytes) {
  const iv = randomBytes(12);
  return b64u.encode(concat(iv, new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes))));
}

async function openBytes(key, sealed) {
  const bytes = b64u.decode(sealed);
  return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12) }, key, bytes.slice(12)));
}

async function accessFrom(seed, label) {
  return {
    token: b64u.encode(await hkdf(seed, EMPTY, text.encode(`wecallyou/account/${label}/auth`), 32)),
    wrapKey: await aesKey(await hkdf(seed, EMPTY, text.encode(`wecallyou/account/${label}/wrap`), 32)),
  };
}

/** Accès dérivé de l'identifiant et du mot de passe (lent exprès : 600 000 tours). */
export async function loginKeys(ident, password) {
  const pw = await subtle.importKey('raw', text.encode(password.normalize('NFKC')), 'PBKDF2', false, ['deriveBits']);
  const salt = text.encode(`wecallyou/account/${normalizeIdent(ident)}`);
  const seed = new Uint8Array(await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PASSWORD_ITERATIONS }, pw, 256));
  return accessFrom(seed, 'password');
}

/** Accès dérivé de la clé de secours (16 octets aléatoires, imprimés sur la fiche). */
export const recoveryKeys = (recovery) => accessFrom(recovery, 'recovery');

export async function openVaultKey(wrapKey, wrapped) {
  return b64u.encode(await openBytes(wrapKey, wrapped));
}

export async function readVault(vaultKey, vault) {
  const plain = await openBytes(await aesKey(b64u.decode(vaultKey)), vault);
  return JSON.parse(new TextDecoder().decode(plain));
}

export async function writeVault(vaultKey, data) {
  return sealBytes(await aesKey(b64u.decode(vaultKey)), text.encode(JSON.stringify(data)));
}

/** Nouveau compte : clé du coffre, clé de secours, et tout ce que le serveur doit garder. */
export async function createAccount(ident, password) {
  const vaultKey = randomBytes(32);
  const recovery = randomBytes(16);
  const pw = await loginKeys(ident, password);
  const rec = await recoveryKeys(recovery);
  const session = { token: pw.token, vaultKey: b64u.encode(vaultKey) };
  return {
    recovery,
    session,
    recoveryToken: rec.token,
    request: {
      ident: normalizeIdent(ident),
      verifier: await verifierOf(pw.token),
      recoveryVerifier: await verifierOf(rec.token),
      wrapPw: await sealBytes(pw.wrapKey, vaultKey),
      wrapRec: await sealBytes(rec.wrapKey, vaultKey),
      vault: await writeVault(session.vaultKey, { lots: {}, recovery: secretToText(recovery) }),
    },
  };
}

/** Nouveau mot de passe (connecté, ou après la fiche de secours) : le coffre ne change pas. */
export async function newPassword(ident, password, vaultKey) {
  const pw = await loginKeys(ident, password);
  return { token: pw.token, request: { verifier: await verifierOf(pw.token), wrapPw: await sealBytes(pw.wrapKey, b64u.decode(vaultKey)) } };
}

/** Nouvelle clé de secours (l'ancienne fiche ne sert plus à rien). */
export async function newRecovery(vaultKey) {
  const recovery = randomBytes(16);
  const rec = await recoveryKeys(recovery);
  return { recovery, request: { recoveryVerifier: await verifierOf(rec.token), wrapRec: await sealBytes(rec.wrapKey, b64u.decode(vaultKey)) } };
}

/* ------------------------------------- coordonnées : client → commerçant */

async function contactKey(sharedSecret, ephemeralPublic) {
  return aesKey(await hkdf(sharedSecret, ephemeralPublic, text.encode('wecallyou/contact'), 32));
}

/** Chiffre un objet pour le lot. Seul le détenteur de la clé de lot pourra le lire. */
export async function sealForLot(lotPublicKey, data) {
  const lotKey = await subtle.importKey('raw', b64u.decode(lotPublicKey), P256_ECDH, false, []);
  const ephemeral = await subtle.generateKey(P256_ECDH, true, ['deriveBits']);
  const ephemeralPublic = new Uint8Array(await subtle.exportKey('raw', ephemeral.publicKey));
  const shared = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: lotKey }, ephemeral.privateKey, 256));
  const iv = randomBytes(12);
  const key = await contactKey(shared, ephemeralPublic);
  const sealed = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, key, text.encode(JSON.stringify(data))));
  return b64u.encode(concat(ephemeralPublic, iv, sealed));
}

export async function openFromClient(lotPrivateKey, blob) {
  const bytes = b64u.decode(blob);
  const ephemeralPublic = bytes.slice(0, 65);
  const peer = await subtle.importKey('raw', ephemeralPublic, P256_ECDH, false, []);
  const shared = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: peer }, lotPrivateKey, 256));
  const key = await contactKey(shared, ephemeralPublic);
  const plain = await subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(65, 77) }, key, bytes.slice(77));
  return JSON.parse(new TextDecoder().decode(plain));
}

/* ------------------------------------------- notifications (Web Push) */

/**
 * Prépare une notification prête à être relayée : contenu chiffré pour le téléphone du client
 * (RFC 8291, aes128gcm) et en-tête VAPID signé avec la clé du lot (RFC 8292).
 */
export async function buildPush({ subscription, payload, vapidKey, vapidPublic, subject, ttl = 900 }) {
  const uaPublic = b64u.decode(subscription.keys.p256dh);
  const authSecret = b64u.decode(subscription.keys.auth);
  const ua = await subtle.importKey('raw', uaPublic, P256_ECDH, false, []);
  const local = await subtle.generateKey(P256_ECDH, true, ['deriveBits']);
  const asPublic = new Uint8Array(await subtle.exportKey('raw', local.publicKey));
  const shared = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: ua }, local.privateKey, 256));

  const ikm = await hkdf(shared, authSecret, concat(text.encode('WebPush: info\0'), uaPublic, asPublic), 32);
  const salt = randomBytes(16);
  const cek = await hkdf(ikm, salt, text.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(ikm, salt, text.encode('Content-Encoding: nonce\0'), 12);
  const plaintext = concat(text.encode(JSON.stringify(payload)), Uint8Array.of(2)); // 2 = dernier enregistrement
  const encrypted = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: nonce }, await aesKey(cek, ['encrypt']), plaintext));
  const header = concat(salt, Uint8Array.of(0, 0, 16, 0), Uint8Array.of(65), asPublic); // taille d'enregistrement 4096

  const jwtHeader = b64u.encode(text.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u.encode(
    text.encode(JSON.stringify({ aud: new URL(subscription.endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject })),
  );
  const signature = await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, vapidKey, text.encode(`${jwtHeader}.${claims}`));

  return {
    endpoint: subscription.endpoint,
    body: b64u.encode(concat(header, encrypted)),
    authorization: `vapid t=${jwtHeader}.${claims}.${b64u.encode(signature)}, k=${vapidPublic}`,
    ttl,
  };
}
