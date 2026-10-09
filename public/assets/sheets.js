// Pages imprimables : page 1 « clé du lot » + pages de tickets, sur tout papier (A4, Letter,
// format libre, rouleau d'imprimante à tickets, étiquettes…). La mise en page vient de layout.js.
import { h, tl, qrSvg, ticketUrl, inkOn, icon } from './common.js';
import { secretToText } from './crypto.js';
import { normalizeDesign, fitDesign, headSize, pageOf } from './layout.js';

/** Numéro tel qu'imprimé : au moins trois chiffres. */
export const labelOf = (n) => String(n).padStart(3, '0');

/** Ce que porte chaque ticket, pour la mise en page (layout.js ne regarde que les longueurs). */
export function contentOf(design, { lang, domain, name = '', whiteLabel = false, last = 999 }) {
  return {
    head: design.logo ? 'logo' : name ? 'name' : null,
    name,
    logoRatio: design.logoRatio,
    showNumber: design.showNumber,
    label: labelOf(last),
    scan: tl(lang, 'ticket_scan'),
    scanSub: tl(lang, 'ticket_scan_en'),
    domain: whiteLabel ? '' : domain,
    tag: tl(lang, 'stub_tag'),
    hint: tl(lang, 'stub_hint'),
  };
}

/** Mise en page d'un lot avec ces réglages (pour l'aperçu, les avertissements et l'impression). */
export function layoutFor(options) {
  const design = normalizeDesign(options);
  return { design, fit: fitDesign(design, contentOf(design, options)) };
}

const mm = (v) => `${Math.max(0, v).toFixed(2)}mm`;

/** Variables CSS d'une partie (client « c » ou souche « s ») : tailles calculées par layout.js. */
function partVars(prefix, part, content) {
  const head = headSize(content, part.t, part.textW);
  return {
    [`--${prefix}-pad`]: mm(part.pad),
    [`--${prefix}-t`]: mm(part.t),
    [`--${prefix}-n`]: mm(part.n),
    [`--${prefix}-q`]: mm(part.q),
    [`--${prefix}-qp`]: mm(Math.max(0.8, part.q * 0.05)),
    [`--${prefix}-gap`]: mm(part.gap),
    [`--${prefix}-gaph`]: mm(part.gapH),
    [`--${prefix}-head`]: mm(head),
  };
}

function clientPart(t, ctx) {
  const items = new Set(ctx.fit.client.items);
  const { content, domain, design } = ctx;
  return h(
    'div',
    { class: `part client ${ctx.fit.client.mode}` },
    qrSvg(ticketUrl(domain, t.c)),
    h(
      'div',
      { class: 'p-text' },
      items.has('head') && (content.head === 'logo' ? h('img', { class: 'p-logo', src: design.logo, alt: '' }) : h('div', { class: 'p-name' }, content.name)),
      items.has('number') && h('div', { class: 'p-num' }, t.label),
      h('div', { class: 'p-scan' }, content.scan),
      items.has('scanSub') && h('div', { class: 'p-sub' }, content.scanSub),
      items.has('domain') && h('div', { class: 'p-domain' }, content.domain),
    ),
  );
}

function stubPart(t, ctx) {
  const items = new Set(ctx.fit.stubPart.items);
  return h(
    'div',
    { class: `part stub ${ctx.fit.stubPart.mode}` },
    qrSvg(ticketUrl(ctx.domain, t.s)),
    h(
      'div',
      { class: 'p-text' },
      items.has('tag') && h('div', { class: 'p-tag' }, ctx.content.tag),
      h('div', { class: 'p-num' }, t.label),
      items.has('hint') && h('div', { class: 'p-hint' }, ctx.content.hint),
    ),
  );
}

const cutClass = (ctx) => (ctx.design.cut ? ' cut' : '');

/** Cases d'une page, dans l'ordre de lecture de la grille. */
function cellsOf(tickets, ctx) {
  const { stub, stubs } = ctx.fit;
  if (stub === 'none') return tickets.map((t) => h('div', { class: `pair stub-none${cutClass(ctx)}` }, clientPart(t, ctx)));
  // Une ou plusieurs souches, à droite ou en dessous du ticket (elles appellent toutes le même ticket).
  if (stub !== 'cell') return tickets.map((t) => h('div', { class: `pair stub-${stub}${cutClass(ctx)}` }, clientPart(t, ctx), Array.from({ length: stubs }, () => stubPart(t, ctx))));
  // Souches sur les cases voisines (étiquettes) : le ticket puis ses souches, côte à côte si les
  // colonnes le permettent, l'une sous l'autre si les lignes le permettent, sinon à la suite.
  const size = stubs + 1;
  const { cols, rows } = ctx.design;
  const grid = Array.from({ length: rows }, () => Array(cols).fill(null));
  const one = (part) => h('div', { class: `pair stub-cell${cutClass(ctx)}` }, part);
  tickets.forEach((t, i) => {
    let cells;
    if (cols % size === 0) {
      const row = Math.floor(i / (cols / size));
      const col = (i % (cols / size)) * size;
      cells = Array.from({ length: size }, (_, k) => [row, col + k]);
    } else if (rows % size === 0) {
      const row = Math.floor(i / cols) * size;
      cells = Array.from({ length: size }, (_, k) => [row + k, i % cols]);
    } else {
      cells = Array.from({ length: size }, (_, k) => [Math.floor((i * size + k) / cols), (i * size + k) % cols]);
    }
    cells.forEach(([r, c], k) => {
      grid[r][c] = one(k === 0 ? clientPart(t, ctx) : stubPart(t, ctx));
    });
  });
  return grid.flat().map((cell) => cell ?? h('div', { class: 'pair empty' }));
}

/**
 * Pages de tickets selon les réglages. options : réglages + { lang, domain, name, whiteLabel,
 * last } (last = dernier numéro du lot : tous les cahiers gardent la même mise en page).
 * Renvoie [] si la grille ne tient pas sur le papier (l'interface l'empêche avant).
 */
export function ticketSheets(tickets, options) {
  const design = normalizeDesign(options);
  const last = options.last ?? Math.max(0, ...tickets.map((t) => Number(t.label) || 0));
  const content = contentOf(design, { ...options, last });
  const fit = fitDesign(design, content);
  if (!fit.ok) return [];
  const ctx = { design, fit, content, domain: options.domain };
  const [mt, , , ml] = design.margins;
  const ink = design.mono ? '#000000' : inkOn(design.ticketBg);
  const vars = {
    '--page-w': mm(fit.page.w),
    '--page-h': mm(fit.page.h),
    '--m-top': mm(mt),
    '--m-left': mm(ml),
    '--cols': design.cols,
    '--rows': design.rows,
    '--cell-w': mm(fit.cell.w),
    '--cell-h': mm(fit.cell.h),
    '--gap-x': mm(design.gapX),
    '--gap-y': mm(design.gapY),
    '--stubs': Math.max(1, fit.stubs),
    '--client-w': mm(fit.stub === 'right' ? fit.cell.w * fit.split : fit.cell.w),
    '--client-h': mm(fit.stub === 'bottom' ? fit.cell.h * fit.split : fit.cell.h),
    ...partVars('c', fit.client, content),
    ...(fit.stubPart ? partVars('s', fit.stubPart, content) : {}),
    // Couleurs : texte lisible sur chaque fond, accent gardé seulement s'il reste lisible.
    '--t-bg': design.mono ? '#ffffff' : design.ticketBg,
    '--t-ink': ink,
    '--t-accent': design.mono || inkOn(design.accent) === ink ? ink : design.accent,
    '--s-bg': design.mono ? '#ffffff' : design.stubBg,
    '--s-ink': design.mono ? '#000000' : inkOn(design.stubBg),
  };
  const pages = [];
  for (let i = 0; i < tickets.length; i += fit.perPage) {
    const page = h('section', { class: `sheet sheet-tickets align-${design.align}${design.mono ? ' mono' : ''}` });
    for (const [k, v] of Object.entries(vars)) page.style.setProperty(k, v);
    page.append(...cellsOf(tickets.slice(i, i + fit.perPage), ctx));
    pages.push(page);
  }
  return pages;
}

/** Format de la page clé : A4, ou Letter si les tickets sont imprimés sur du Letter. */
export const keyPage = (design) => (normalizeDesign(design).paper === 'letter' ? pageOf({ paper: 'letter' }) : pageOf({ paper: 'a4' }));

/** La page clé peut-elle partir dans la même impression que les tickets (même papier) ? */
export function keyShares(design) {
  const page = pageOf(normalizeDesign(design));
  const key = keyPage(design);
  return Math.abs(page.w - key.w) < 0.5 && Math.abs(page.h - key.h) < 0.5;
}

/* ----------------------------------------------- documents : page clé, fiche de secours */

// Logo WeCall.You dessiné dans la page (et non chargé comme image) : il s'imprime à coup sûr.
const LOGO = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" aria-hidden="true"><rect width="64" height="64" rx="14" fill="#e8572a"/><path d="M12 19H52V28A4 4 0 0 0 52 36V45H12V36A4 4 0 0 0 12 28Z" fill="#fff"/><path d="M41 21V43" stroke="#e8572a" stroke-width="1.6" stroke-dasharray="2.4 2.4"/><circle cx="22" cy="32" r="3.6" fill="#e8572a"/><path d="M26.9 27.1A7 7 0 0 1 26.9 36.9M29.8 24.2A11 11 0 0 1 29.8 39.8" fill="none" stroke="#e8572a" stroke-width="2.6" stroke-linecap="round"/></svg>';

export function brandMark(cls = 'doc-logo') {
  const box = h('span', { class: cls });
  box.innerHTML = LOGO;
  return box;
}

/** Bandeau du document : logo, marque et nature du document à gauche, repère à droite. */
export function docBand({ brand, kind, aside = '' }) {
  return h('header', { class: 'doc-band' }, brandMark(), h('div', { class: 'grow' }, h('div', { class: 'doc-brand' }, brand), h('div', { class: 'doc-kind' }, kind)), aside && h('div', { class: 'doc-aside' }, aside));
}

/** Pied du document : date, adresse du service. */
export const docFoot = (lang, domain) => h('footer', { class: 'doc-foot' }, brandMark('doc-logo small'), h('span', {}, tl(lang, 'k_foot', { date: new Date().toLocaleDateString(lang) })), h('span', {}, `https://${domain}`));

/** Page 1 : la clé du lot (QR vers l'espace commerçant), le mode d'emploi et l'appel aux dons. */
export function keySheet({ lang, domain, brand, lot, name, secret, from, to, monthlyCost, password = false, pro = false, design = {}, screen = null }) {
  const key = secretToText(secret);
  // « ! » final : l'espace commerçant demandera directement le mot de passe du lot.
  const spaceUrl = `https://${domain}/m#${key}${password ? '!' : ''}`;
  const page = keyPage(design);
  const merchantLogo = normalizeDesign(design).logo;
  const steps = [
    ['ticket', 'k_how_t1', 'k_how_1'],
    ['qr-code', 'k_how_t2', 'k_how_2'],
    ['megaphone', 'k_how_t3', 'k_how_3'],
  ];
  const sheet = h(
    'section',
    { class: 'sheet sheet-key sheet-doc' },
    docBand({ brand, kind: tl(lang, 'k_doc'), aside: tl(lang, 'k_lot', { id: lot }) }),
    h(
      'div',
      { class: 'doc-title' },
      // Nom long : plus petit, pour que la page tienne toujours sur une feuille.
      h('div', { class: 'grow' }, h('h1', { class: name.length > 40 ? 'long' : name.length > 24 ? 'mid' : null }, name), h('p', {}, tl(lang, 'k_range', { from: labelOf(from), to: labelOf(to) }))),
      merchantLogo && h('img', { class: 'doc-merchant', src: merchantLogo, alt: '' }),
    ),
    h(
      'div',
      { class: 'k-box' },
      h('div', { class: 'k-qr' }, qrSvg(spaceUrl, 'M')),
      h(
        'div',
        { class: 'k-text' },
        h('h2', {}, icon('key'), tl(lang, 'k_title')),
        h('p', { class: 'k-keep' }, tl(lang, 'k_keep')),
        h('p', {}, tl(lang, 'k_scan')),
        h('p', { class: 'k-label' }, tl(lang, 'k_code')),
        h('div', { class: 'k-code' }, secretToText(secret, true)),
        password && h('p', { class: 'k-pass' }, icon('lock-key'), tl(lang, 'k_password')),
      ),
    ),
    h('div', { class: 'k-warn' }, icon('warning'), h('span', {}, tl(lang, 'k_warn'))),
    h(
      'div',
      { class: 'k-how' },
      h('h2', {}, tl(lang, 'k_how')),
      h(
        'ol',
        { class: 'k-steps' },
        steps.map(([glyph, title, text], i) => h('li', {}, h('div', { class: 'k-step-head' }, h('span', { class: 'k-num' }, String(i + 1)), icon(glyph), h('b', {}, tl(lang, title))), h('p', {}, tl(lang, text)))),
      ),
    ),
    h('p', { class: 'k-privacy' }, icon('lock-key'), h('span', {}, tl(lang, 'k_privacy'))),
    // En bas, côte à côte : l'écran d'affichage (la tablette ou la TV du comptoir scanne ce QR) et,
    // sans Pro, l'appel au don. Seul, un bloc prend toute la largeur.
    h(
      'div',
      { class: 'k-extras' },
      screen &&
        h(
          'div',
          { class: 'k-screen' },
          h('h2', {}, icon('monitor-play'), tl(lang, 'k_screen_title')),
          h('p', {}, tl(lang, 'k_screen_text')),
          h('div', { class: 'k-qr small' }, qrSvg(screenUrl(domain, screen), 'M')),
        ),
      !pro &&
        h(
          'div',
          { class: 'k-donate' },
          h('h2', {}, icon('hand-heart'), tl(lang, 'k_donate_title')),
          h('p', {}, tl(lang, 'k_donate_text', { brand, cost: monthlyCost })),
          h('div', { class: 'k-qr small' }, qrSvg(`HTTPS://${domain.toUpperCase()}/SOUTENIR`, 'M')),
        ),
    ),
    docFoot(lang, domain),
  );
  sheet.style.setProperty('--page-w', mm(page.w));
  sheet.style.setProperty('--page-h', mm(page.h));
  return sheet;
}

/** Adresse imprimée dans le QR de l'affiche (majuscules : QR plus compact). */
export const posterUrl = (domain, token) => `HTTPS://${domain.toUpperCase()}/A/${token}`;

/** Adresse de l'écran public (majuscules : QR plus compact ; la page accepte les deux). */
export const screenUrl = (domain, token) => `HTTPS://${domain.toUpperCase()}/ECRAN/${token}`;

/**
 * Affiche à poser au comptoir : chaque client qui la scanne reçoit le numéro suivant.
 * whiteLabel (Pro) : seul le nom du commerce apparaît.
 */
export function posterSheet({ lang, domain, brand, name, token, logo = null, whiteLabel = false, design = {} }) {
  const page = keyPage(design);
  const other = lang === 'fr' ? 'en' : 'fr';
  const steps = [
    ['qr-code', 'poster_s1'],
    ['bell-ringing', 'poster_s2'],
    ['megaphone', 'poster_s3'],
  ];
  const sheet = h(
    'section',
    { class: 'sheet sheet-key sheet-doc sheet-poster' },
    whiteLabel ? h('header', { class: 'doc-band' }, h('div', { class: 'doc-brand grow' }, name)) : docBand({ brand, kind: tl(lang, 'poster_kind'), aside: name }),
    h(
      'div',
      { class: 'poster-main' },
      logo && h('img', { class: 'poster-logo', src: logo, alt: '' }),
      h('h1', {}, tl(lang, 'poster_title')),
      h('p', { class: 'poster-other' }, tl(other, 'poster_title')),
      h('div', { class: 'poster-qr' }, qrSvg(posterUrl(domain, token), 'M')),
      h('p', { class: 'poster-cta' }, tl(lang, 'poster_cta')),
    ),
    h(
      'ol',
      { class: 'k-steps' },
      steps.map(([glyph, text], i) => h('li', {}, h('div', { class: 'k-step-head' }, h('span', { class: 'k-num' }, String(i + 1)), icon(glyph), h('b', {}, tl(lang, `${text}_t`))), h('p', {}, tl(lang, text)))),
    ),
    h('p', { class: 'k-privacy' }, icon('lock-key'), h('span', {}, tl(lang, 'poster_privacy'))),
    !whiteLabel && docFoot(lang, domain),
  );
  sheet.style.setProperty('--page-w', mm(page.w));
  sheet.style.setProperty('--page-h', mm(page.h));
  return sheet;
}

/** Remplit la zone d'impression (invisible à l'écran) et renvoie ses pages. */
export function fillPrintRoot(pages) {
  let root = document.querySelector('.print-root');
  if (!root) {
    root = h('div', { class: 'print-root' });
    document.body.append(root);
  }
  root.replaceChildren(...pages);
  return root;
}

/** Format de papier de la prochaine impression (règle @page créée à la volée : la CSP l'autorise). */
let pageRule = null;
export function setPrintPage({ w, h: height }) {
  const css = `@page { size: ${w}mm ${height}mm; margin: 0; }`;
  try {
    if (!pageRule) {
      pageRule = new CSSStyleSheet();
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, pageRule];
    }
    pageRule.replaceSync(css);
  } catch {
    // Navigateurs plus anciens : la règle s'ajoute à la feuille de style du site.
    const sheet = [...document.styleSheets].find((s) => s.href?.endsWith('/assets/style.css'));
    if (!sheet) return;
    if (pageRule?.index !== undefined) sheet.deleteRule(pageRule.index);
    pageRule = { index: sheet.insertRule(css, sheet.cssRules.length) };
  }
}
