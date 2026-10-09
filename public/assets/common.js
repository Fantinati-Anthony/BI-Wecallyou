// Outils partagés par toutes les pages : langue, textes, éléments HTML, appels à l'API, stockage local.
import { TEXTS } from './i18n.js';
import { icon } from './icons.js';

export { icon };

export const LANG = (navigator.language || 'en').toLowerCase().startsWith('fr') ? 'fr' : 'en';
document.documentElement.lang = LANG;

/** Texte traduit, avec remplacement des {variables}. */
export function tl(lang, key, vars = {}) {
  let s = TEXTS[lang]?.[key] ?? TEXTS.en[key] ?? key;
  for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
  return s;
}
export const t = (key, vars) => tl(LANG, key, vars);

/** Rang en toutes lettres : 1er / 2e … ou 1st / 2nd / 3rd … */
export function ordinal(n, lang = LANG) {
  if (lang === 'fr') return n === 1 ? '1er' : `${n}e`;
  const s = n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th';
  return `${n}${s}`;
}

/** Fabrique un élément sans jamais interpréter de HTML (les noms affichés viennent des utilisateurs). */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === false || v == null) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

/** Remplace le contenu d'un conteneur. */
export function render(container, ...children) {
  container.replaceChildren(...children.flat(Infinity).filter(Boolean));
}

/** Applique les traductions aux éléments marqués data-i18n, et pose les icônes data-icon, dans les pages HTML. */
export function translatePage(vars = {}) {
  for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n, vars);
  for (const el of document.querySelectorAll('[data-i18n-placeholder]')) el.placeholder = t(el.dataset.i18nPlaceholder, vars);
  for (const el of document.querySelectorAll('[data-lang]')) el.hidden = el.dataset.lang !== LANG;
  for (const el of document.querySelectorAll('[data-icon]')) el.replaceChildren(icon(el.dataset.icon));
}

export async function api(path, { body, auth } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  // Jeton seul = accès à un lot ; sinon en-tête complet (« Account … », « Recovery … »).
  if (auth) headers.Authorization = auth.includes(' ') ? auth : `Lot ${auth}`;
  try {
    const res = await fetch(`/api${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
    });
    const data = await res.json().catch(() => ({ ok: false, error: res.status >= 500 ? 'server' : 'default' }));
    return { status: res.status, ...data };
  } catch {
    return { ok: false, status: 0, error: 'network' };
  }
}

export const errorText = (code) => t(`err_${code}`) === `err_${code}` ? t('err_default') : t(`err_${code}`);

/* ------------------------------------------------------- stockage local */

export const local = {
  get(key, fallback = null) {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* navigation privée : on continue sans mémoire */
    }
  },
  remove(key) {
    try {
      localStorage.removeItem(key);
    } catch {
      /* idem */
    }
  },
};

/**
 * Lots connectés sur ce téléphone : { [id]: { key, material, name, password } }.
 * « material » = clé du lot déjà renforcée par son mot de passe : le mot de passe lui-même
 * n'est jamais gardé. Rien de tout cela ne quitte l'appareil.
 */
export const lots = {
  all: () => local.get('wcy:lots', {}),
  get: (id) => lots.all()[id] ?? null,
  save(id, entry) {
    const all = lots.all();
    all[id] = { ...all[id], ...entry };
    local.set('wcy:lots', all);
    local.set('wcy:current', id);
  },
  forget(id) {
    const all = lots.all();
    delete all[id];
    local.set('wcy:lots', all);
    if (local.get('wcy:current') === id) local.remove('wcy:current');
  },
};

/* ------------------------------------------------------------ plateformes */

export const isIOS = () => /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
export const isStandalone = () => navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
export const fmtTime = (ms) => new Date(ms).toLocaleTimeString(LANG, { hour: '2-digit', minute: '2-digit' });

/* ----------------------------------------------------------------- couleurs */

/** Texte lisible sur un fond : noir sur clair, blanc sur foncé (luminance relative WCAG). */
export function inkOn(background) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(background.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.4 ? '#111111' : '#ffffff';
}

/** Couleurs personnalisées (option Pro) : { '--variable': '#rrggbb' | null } ; null rend la couleur d'origine. */
export function setColors(vars) {
  for (const [name, value] of Object.entries(vars)) {
    if (value) document.documentElement.style.setProperty(name, value);
    else document.documentElement.style.removeProperty(name);
  }
}

/* ----------------------------------------------------------------- QR codes */

/** QR code en SVG. Les adresses en majuscules utilisent le mode « alphanumérique », plus compact. */
export function qrSvg(text, level = 'Q') {
  const qr = globalThis.qrcode(0, level);
  qr.addData(text, /^[0-9A-Z $%*+\-./:]+$/.test(text) ? 'Alphanumeric' : 'Byte');
  qr.make();
  const box = document.createElement('div');
  box.className = 'p-qr';
  box.innerHTML = qr.createSvgTag({ cellSize: 1, margin: 0, scalable: true });
  return box;
}

/** Adresse d'un ticket telle qu'imprimée dans le QR (majuscules = QR plus petit). */
export const ticketUrl = (domain, token) => `HTTPS://${domain.toUpperCase()}/${token}`;
