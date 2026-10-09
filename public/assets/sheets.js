// Pages imprimables : page 1 « clé du lot » + pages de tickets, sur tout papier (A4, Letter,
// format libre, rouleau d'imprimante à tickets, étiquettes…). La mise en page vient de layout.js.
import { h, tl, qrSvg, ticketUrl, inkOn } from './common.js';
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
  const { stub } = ctx.fit;
  if (stub === 'none') return tickets.map((t) => h('div', { class: `pair stub-none${cutClass(ctx)}` }, clientPart(t, ctx)));
  if (stub !== 'cell') return tickets.map((t) => h('div', { class: `pair stub-${stub}${cutClass(ctx)}` }, clientPart(t, ctx), stubPart(t, ctx)));
  // Souche sur la case voisine (étiquettes) : côte à côte si les colonnes sont paires,
  // l'une sous l'autre si les lignes le sont, sinon à la suite.
  const { cols, rows } = ctx.design;
  const grid = Array.from({ length: rows }, () => Array(cols).fill(null));
  const one = (part) => h('div', { class: `pair stub-cell${cutClass(ctx)}` }, part);
  tickets.forEach((t, i) => {
    let a;
    let b;
    if (cols % 2 === 0) {
      a = [Math.floor(i / (cols / 2)), (i % (cols / 2)) * 2];
      b = [a[0], a[1] + 1];
    } else if (rows % 2 === 0) {
      a = [Math.floor(i / cols) * 2, i % cols];
      b = [a[0] + 1, a[1]];
    } else {
      a = [Math.floor((2 * i) / cols), (2 * i) % cols];
      b = [Math.floor((2 * i + 1) / cols), (2 * i + 1) % cols];
    }
    grid[a[0]][a[1]] = one(clientPart(t, ctx));
    grid[b[0]][b[1]] = one(stubPart(t, ctx));
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
    const page = h('section', { class: `sheet sheet-tickets${design.mono ? ' mono' : ''}` });
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

/** Page 1 : la clé du lot (QR vers l'espace commerçant), le mode d'emploi et l'appel aux dons. */
export function keySheet({ lang, domain, brand, lot, name, secret, from, to, monthlyCost, password = false, pro = false, design = {} }) {
  const key = secretToText(secret);
  // « ! » final : l'espace commerçant demandera directement le mot de passe du lot.
  const spaceUrl = `https://${domain}/m#${key}${password ? '!' : ''}`;
  const page = keyPage(design);
  const sheet = h(
    'section',
    { class: 'sheet sheet-key' },
    h(
      'div',
      { class: 'k-head' },
      h('div', {}, h('h1', {}, name), h('div', {}, tl(lang, 'k_range', { from, to }))),
      h('div', { class: 'small' }, brand, ' · ', tl(lang, 'k_lot', { id: lot })),
    ),
    h(
      'div',
      { class: 'k-box' },
      qrSvg(spaceUrl, 'M'),
      h(
        'div',
        {},
        h('h2', {}, tl(lang, 'k_title')),
        h('p', {}, h('b', {}, tl(lang, 'k_keep'))),
        h('p', {}, tl(lang, 'k_scan')),
        h('p', {}, tl(lang, 'k_code')),
        h('div', { class: 'k-code' }, secretToText(secret, true)),
        password && h('p', {}, h('b', {}, tl(lang, 'k_password'))),
      ),
    ),
    h('div', { class: 'k-warn' }, tl(lang, 'k_warn')),
    h(
      'div',
      {},
      h('h2', {}, tl(lang, 'k_how')),
      h('ol', {}, h('li', {}, tl(lang, 'k_how_1')), h('li', {}, tl(lang, 'k_how_2')), h('li', {}, tl(lang, 'k_how_3'))),
    ),
    h('div', {}, tl(lang, 'k_privacy')),
    // Abonnés Pro : pas d'appel au don sur leur page clé.
    !pro && h(
      'div',
      { class: 'k-donate' },
      h('div', {}, h('h2', {}, tl(lang, 'k_donate_title')), h('div', {}, tl(lang, 'k_donate_text', { brand, cost: monthlyCost }))),
      qrSvg(`HTTPS://${domain.toUpperCase()}/SOUTENIR`, 'M'),
    ),
    h('div', { class: 'k-foot' }, tl(lang, 'k_foot', { date: new Date().toLocaleDateString(lang) }), ` · https://${domain}`),
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
