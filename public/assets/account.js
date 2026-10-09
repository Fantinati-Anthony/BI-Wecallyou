// Compte facultatif : retrouver tous ses lots sur n'importe quel téléphone, et profiter du statut Pro
// activé par les dons. Tout est chiffré ici, dans le navigateur ; le serveur ne garde que des
// empreintes et un coffre illisible. Mot de passe oublié → fiche de secours (imprimée/téléchargée).
import { h, tl, api, local, lots, qrSvg, icon, LANG_KEY } from './common.js';
import {
  createAccount,
  loginKeys,
  recoveryKeys,
  openVaultKey,
  readVault,
  writeVault,
  newPassword,
  newRecovery,
  textToSecret,
  secretToText,
  authTokenOf,
  b64u,
  normalizeIdent,
} from './crypto.js';
import { fillPrintRoot, docBand, docFoot, keyPage, setPrintPage } from './sheets.js';
import { ACTIVITY_KEY } from './activities.js';

const KEY = 'wcy:account';

/** Session de ce téléphone : { id, ident, token, vaultKey, version, pro, premiumUntil }. */
export const session = {
  get: () => local.get(KEY),
  set: (value) => local.set(KEY, value),
  clear: () => local.remove(KEY),
};

const authOf = (s) => `Account ${s.token}`;
export const IDENT = /^[a-z0-9][a-z0-9._-]{2,31}$/;
export const MIN_PASSWORD = 10;

export async function signup(ident, password) {
  const created = await createAccount(ident, password);
  const res = await api('/account', { body: created.request });
  if (!res.ok) return { error: res.error };
  session.set({ id: res.id, ident: normalizeIdent(ident), ...created.session, version: res.version });
  await sync();
  return { recovery: created.recovery };
}

export async function login(ident, password) {
  const keys = await loginKeys(ident, password);
  const res = await api('/account', { auth: `Account ${keys.token}` });
  if (!res.ok) return { error: res.status === 401 ? 'account_login' : res.error };
  session.set({ id: res.id, ident: normalizeIdent(ident), token: keys.token, vaultKey: await openVaultKey(keys.wrapKey, res.wrapPw), version: res.version });
  await sync();
  return { ok: true };
}

/** Mot de passe oublié : la clé de secours ouvre le coffre, on choisit un nouveau mot de passe. */
export async function recover(ident, recoveryText, password) {
  const secret = textToSecret(recoveryText);
  if (!secret) return { error: 'recovery' };
  const rec = await recoveryKeys(secret);
  const res = await api('/account/recover', { auth: `Recovery ${rec.token}` });
  if (!res.ok) return { error: res.status === 401 ? 'recovery' : res.error };
  const vaultKey = await openVaultKey(rec.wrapKey, res.wrapRec);
  const fresh = await newPassword(ident, password, vaultKey);
  const set = await api('/account/password', { body: { ...fresh.request, ident: normalizeIdent(ident) }, auth: `Recovery ${rec.token}` });
  if (!set.ok) return { error: set.error === 'ident' ? 'recovery' : set.error };
  session.set({ id: res.id, ident: normalizeIdent(ident), token: fresh.token, vaultKey, version: res.version });
  await sync();
  return { ok: true };
}

export async function changePassword(password) {
  const s = session.get();
  const fresh = await newPassword(s.ident, password, s.vaultKey);
  const res = await api('/account/password', { body: fresh.request, auth: authOf(s) });
  if (res.ok) session.set({ ...s, token: fresh.token });
  return res;
}

/** Nouvelle fiche de secours : l'ancienne ne sert plus à rien. Renvoie la nouvelle clé. */
export async function rotateRecovery() {
  const s = session.get();
  const fresh = await newRecovery(s.vaultKey);
  const res = await api('/account/recovery', { body: fresh.request, auth: authOf(s) });
  if (!res.ok) return { error: res.error };
  await sync({ recovery: secretToText(fresh.recovery) });
  return { recovery: fresh.recovery };
}

export function logout() {
  session.clear();
}

export async function deleteAccount() {
  const s = session.get();
  const res = await api('/account/delete', { body: {}, auth: authOf(s) });
  if (res.ok) session.clear();
  return res;
}

/**
 * Synchronise le coffre et ce téléphone : les lots connectés ici rejoignent le compte, ceux du compte
 * arrivent ici, et chaque lot est rattaché au compte (pour profiter du Pro). `changes` permet de
 * modifier le coffre au passage (nouvelle clé de secours, lot retiré…).
 */
export async function sync(changes = {}, retry = true) {
  const s = session.get();
  if (!s) return null;
  const res = await api('/account', { auth: authOf(s) });
  if (!res.ok) {
    if (res.status === 401) session.clear();
    return null;
  }
  const vault = await readVault(s.vaultKey, res.vault);
  vault.lots ??= {};
  let dirty = false;
  if (changes.recovery) {
    vault.recovery = changes.recovery;
    dirty = true;
  }
  // Activité du commerce : gardée chiffrée dans le coffre, elle devient le choix par défaut sur chaque téléphone.
  if (changes.activity && changes.activity !== vault.activity) {
    vault.activity = changes.activity;
    dirty = true;
  }
  if (vault.activity && !local.get(ACTIVITY_KEY)) local.set(ACTIVITY_KEY, vault.activity);
  // Langue choisie (en-tête ou inscription) : la dernière choisie part au coffre, un nouveau téléphone la reprend.
  const lang = local.get(LANG_KEY);
  if (lang && lang !== vault.lang) {
    vault.lang = lang;
    dirty = true;
  } else if (!lang && vault.lang) local.set(LANG_KEY, vault.lang);
  for (const id of changes.removeLots ?? []) {
    if (vault.lots[id]) {
      delete vault.lots[id];
      dirty = true;
    }
  }
  const here = lots.all();
  for (const [id, entry] of Object.entries(here)) {
    if (!vault.lots[id] || vault.lots[id].material !== entry.material) {
      vault.lots[id] = { ...entry, linked: false };
      dirty = true;
    }
  }
  for (const [id, entry] of Object.entries(vault.lots)) {
    if (!entry.linked && entry.material) {
      const linked = await api('/account/link', { body: { lotAuth: await authTokenOf(b64u.decode(entry.material)) }, auth: authOf(s) });
      if (linked.ok) {
        entry.linked = true;
        dirty = true;
      } else if (linked.error === 'pro_required') break; // compte gratuit : un seul lot rattaché (réessayé une fois Pro)
    }
  }
  let version = res.version;
  if (dirty) {
    const saved = await api('/account/vault', { body: { vault: await writeVault(s.vaultKey, vault), version }, auth: authOf(s) });
    if (saved.status === 409 && retry) return sync(changes, false); // un autre téléphone a écrit entre-temps
    if (saved.ok) version = saved.version;
  }
  const merged = { ...Object.fromEntries(Object.entries(vault.lots).map(([id, { linked, ...entry }]) => [id, entry])), ...here };
  local.set('wcy:lots', merged);
  session.set({ ...s, version, pro: res.pro, premiumUntil: res.premiumUntil });
  return { ...res, vault };
}

/** Retire un lot du compte (en plus de ce téléphone). */
export async function removeLot(id) {
  lots.forget(id);
  const s = session.get();
  if (!s) return;
  await api('/account/unlink', { body: { lot: Number(id) }, auth: authOf(s) }); // libère sa place sur le compte
  await sync({ removeLots: [String(id)] });
}

/* ------------------------------------------------------- fiche de secours */

const recoveryUrl = (domain, ident, key) => `https://${domain}/compte#secours=${encodeURIComponent(ident)}:${key}`;

/** Page A4 à imprimer : identifiant, clé de secours en clair et en QR code, mode d'emploi. */
export function printKit({ lang, domain, brand, ident, recovery }) {
  const key = secretToText(recovery);
  setPrintPage(keyPage({})); // toujours en A4, même après une impression sur rouleau
  fillPrintRoot([
    h(
      'section',
      { class: 'sheet sheet-key sheet-doc' },
      docBand({ brand, kind: tl(lang, 'kit_sheet_title'), aside: new Date().toLocaleDateString(lang) }),
      h('div', { class: 'doc-title' }, h('div', { class: 'grow' }, h('h1', {}, tl(lang, 'kit_for', { ident })), h('p', {}, tl(lang, 'kit_sheet_keep')))),
      h(
        'div',
        { class: 'k-box' },
        h('div', { class: 'k-qr' }, qrSvg(recoveryUrl(domain, ident, key), 'M')),
        h(
          'div',
          { class: 'k-text' },
          h('h2', {}, icon('lifebuoy'), tl(lang, 'kit_key')),
          h('p', { class: 'k-label' }, tl(lang, 'acc_ident')),
          h('div', { class: 'k-code' }, ident),
          h('p', { class: 'k-label' }, tl(lang, 'kit_key')),
          h('div', { class: 'k-code' }, secretToText(recovery, true)),
        ),
      ),
      h(
        'div',
        { class: 'k-how' },
        h('h2', {}, tl(lang, 'rec_title')),
        h(
          'ol',
          { class: 'k-steps' },
          [
            ['user-circle', 'kit_s1_t', tl(lang, 'kit_s1', { url: `${domain}/compte` })],
            ['qr-code', 'kit_s2_t', tl(lang, 'kit_s2')],
            ['key', 'kit_s3_t', tl(lang, 'kit_s3')],
          ].map(([glyph, title, text], i) => h('li', {}, h('div', { class: 'k-step-head' }, h('span', { class: 'k-num' }, String(i + 1)), icon(glyph), h('b', {}, tl(lang, title))), h('p', {}, text))),
        ),
      ),
      h('div', { class: 'k-warn' }, icon('warning'), h('span', {}, tl(lang, 'kit_sheet_warn'))),
      docFoot(lang, domain, brand),
    ),
  ]);
  window.print();
}

/** La même fiche en simple fichier texte, à garder dans ses documents ou un gestionnaire de mots de passe. */
export function downloadKit({ lang, domain, brand, ident, recovery }) {
  const text = [
    `${brand} : ${tl(lang, 'kit_sheet_title')}`,
    '',
    `${tl(lang, 'acc_ident')} : ${ident}`,
    `${tl(lang, 'kit_key')} : ${secretToText(recovery, true)}`,
    '',
    tl(lang, 'kit_sheet_how', { url: recoveryUrl(domain, ident, secretToText(recovery)) }),
    '',
    tl(lang, 'kit_sheet_warn'),
    '',
  ].join('\n');
  const link = h('a', { href: URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' })), download: `${brand.toLowerCase().replace(/[^a-z0-9]+/g, '')}-secours-${ident}.txt` });
  document.body.append(link);
  link.click();
  link.remove();
}
