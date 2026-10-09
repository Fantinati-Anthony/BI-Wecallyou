// Pages imprimables (A4) : page 1 « clé du lot » + pages de tickets avec leurs souches.
import { h, tl, qrSvg, ticketUrl } from './common.js';
import { secretToText } from './crypto.js';

/** Dispositions proposées : nombre de tickets par feuille → [colonnes, lignes]. */
export const LAYOUTS = { 4: [1, 4], 6: [2, 3], 8: [2, 4], 10: [2, 5], 12: [2, 6], 16: [2, 8], 21: [3, 7], 24: [3, 8] };
export const DEFAULT_LAYOUT = 12;

const PAGE_W = 194; // mm, A4 moins les marges d'impression
const PAGE_H = 281;

/** Tailles (mm) d'un ticket selon la disposition, pour que QR et numéros restent lisibles. */
function sizesFor(perPage) {
  const [cols, rows] = LAYOUTS[perPage] ?? LAYOUTS[DEFAULT_LAYOUT];
  const cellW = PAGE_W / cols;
  const cellH = PAGE_H / rows;
  const clientW = cellW * 0.59;
  const stubW = cellW - clientW;
  return {
    cols,
    rows,
    vars: {
      '--cell-w': `${cellW}mm`,
      '--cell-h': `${cellH}mm`,
      '--client-w': `${clientW}mm`,
      '--stub-w': `${stubW}mm`,
      // Proportions choisies pour que nom + numéro + QR + textes tiennent toujours dans la case.
      '--qr': `${Math.min(clientW * 0.6, cellH * 0.44, 40)}mm`,
      '--qr-stub': `${Math.min(stubW * 0.62, cellH * 0.42, 30)}mm`,
      '--num': `${Math.min(cellH * 0.155, 12)}mm`,
      '--txt': `${Math.min(Math.max(cellH * 0.05, 1.9), 3.2)}mm`,
    },
  };
}

function ticketPair(t, { lang, domain, name, logo = null, showNumber = true, whiteLabel = false }) {
  return h(
    'div',
    { class: 'pair' },
    h(
      'div',
      { class: 'part client' },
      logo ? h('img', { class: 'p-logo', src: logo, alt: '' }) : h('div', { class: 'p-name' }, name),
      showNumber && h('div', { class: 'p-num' }, t.label),
      qrSvg(ticketUrl(domain, t.c)),
      h('div', { class: 'p-hint' }, h('b', {}, tl(lang, 'ticket_scan')), tl(lang, 'ticket_scan_en')),
      !whiteLabel && h('div', { class: 'p-domain' }, domain),
    ),
    h(
      'div',
      { class: 'part stub' },
      h('div', { class: 'p-tag' }, tl(lang, 'stub_tag')),
      h('div', { class: 'p-num' }, t.label),
      qrSvg(ticketUrl(domain, t.s)),
      h('div', { class: 'p-hint' }, tl(lang, 'stub_hint')),
    ),
  );
}

export function ticketSheets(tickets, { perPage = DEFAULT_LAYOUT, ...ctx }) {
  const { rows, cols, vars } = sizesFor(perPage);
  const pages = [];
  for (let i = 0; i < tickets.length; i += rows * cols) {
    const page = h('section', { class: 'sheet sheet-tickets' });
    for (const [k, v] of Object.entries(vars)) page.style.setProperty(k, v);
    page.style.setProperty('--cols', cols);
    page.style.setProperty('--rows', rows);
    page.append(...tickets.slice(i, i + rows * cols).map((t) => ticketPair(t, ctx)));
    pages.push(page);
  }
  return pages;
}

/** Page 1 : la clé du lot (QR vers l'espace commerçant), le mode d'emploi et l'appel aux dons. */
export function keySheet({ lang, domain, brand, lot, name, secret, from, to, monthlyCost, password = false, pro = false }) {
  const key = secretToText(secret);
  // « ! » final : l'espace commerçant demandera directement le mot de passe du lot.
  const spaceUrl = `https://${domain}/m#${key}${password ? '!' : ''}`;
  return h(
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
        h('h2', {}, '🔑 ', tl(lang, 'k_title')),
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
