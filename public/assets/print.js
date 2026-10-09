// Impression d'un lot, cahier par cahier, pour qu'un lot de plusieurs milliers de tickets
// s'imprime sans faire tomber le navigateur. Tout papier : A4, rouleau, étiquettes…
import { h, t, api, local, icon } from './common.js';
import { keySheet, ticketSheets, fillPrintRoot, layoutFor, keyShares, keyPage, setPrintPage } from './sheets.js';
import { normalizeDesign, PAPERS } from './layout.js';

const MAX_TICKETS_PER_REQUEST = 1200; // limite du serveur pour un cahier
const A4_AREA = 210 * 297;

/** Réglages d'impression mémorisés sur ce téléphone pour chaque lot (papier, grille, couleurs, logo). */
export const printOptions = {
  get: (lotId) => normalizeDesign(local.get(`wcy:print:${lotId}`, {})),
  set: (lotId, options) => local.set(`wcy:print:${lotId}`, normalizeDesign({ ...printOptions.get(lotId), ...options })),
};

/** Réduit un logo à 240 px maximum (PNG) : léger, net à l'impression, gardé sur ce téléphone. */
export async function readLogo(file) {
  if (!file) return null;
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 240 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return { url: canvas.toDataURL('image/png'), ratio: canvas.width / canvas.height };
}

export const pagesFor = (count, perPage) => Math.ceil(count / perPage);

function printPages(pages, page) {
  setPrintPage(page);
  fillPrintRoot(pages);
  window.print();
}

/**
 * Plan d'impression : un bouton par cahier. Avec `key` (juste après la création du lot), la page
 * clé part avec le premier cahier si elle est sur le même papier, sinon elle s'imprime à part.
 */
export function printPlan({ lot, auth, from, to, options, domain, lang, key = null, onPrint }) {
  const ctx = { ...options, lang, domain, name: lot.name, whiteLabel: Boolean(lot.whiteLabel), last: lot.to ?? to };
  const { design, fit } = layoutFor(ctx);
  const box = h('div', { class: 'stack' });
  if (!fit.ok) {
    box.append(h('p', { class: 'error' }, t('pv_impossible')));
    return box;
  }
  const { perPage, page } = fit;
  // Des pages entières par cahier : environ 50 pages A4 (davantage pour de petits formats), dans la limite du serveur.
  const pageBudget = Math.min(300, Math.max(50, Math.round((50 * A4_AREA) / (page.w * page.h))));
  const pagesPerBatch = Math.max(1, Math.min(pageBudget, Math.floor(MAX_TICKETS_PER_REQUEST / perPage)));
  const batchSize = perPage * pagesPerBatch;
  const count = to - from + 1;
  const batches = Math.ceil(count / batchSize);
  // Recto-verso : chaque page a son dos ; la page clé part à part (elle décalerait les dos).
  const sides = design.verso ? 2 : 1;
  const withKey = Boolean(key) && keyShares(design) && !design.verso;
  const keyOnly = () => printPages([keySheet({ ...key, design })], keyPage(design));

  // Page clé sur un autre papier (rouleau, étiquettes…) : on l'imprime d'abord, en A4.
  if (key && !withKey) {
    const keyFirst = h('button', { type: 'button', class: 'btn btn-block btn-big' }, icon('key'), t('plan_key_a4'));
    keyFirst.addEventListener('click', () => {
      keyOnly();
      keyFirst.classList.add('done');
    });
    box.append(h('p', { class: 'small' }, t('plan_key_first')), keyFirst);
  }
  box.append(h('p', { class: 'lead' }, t('plan_summary', { count: count.toLocaleString(lang), pages: (pagesFor(count, perPage) * sides).toLocaleString(lang), batches })));
  if (batches > 1) box.append(h('p', { class: 'small muted' }, t('plan_hint', { pages: pagesPerBatch })));

  for (let i = 0; i < batches; i++) {
    const n1 = from + i * batchSize;
    const n2 = Math.min(to, n1 + batchSize - 1);
    const p1 = i * pagesPerBatch * sides + 1;
    const p2 = p1 + pagesFor(n2 - n1 + 1, perPage) * sides - 1;
    const first = withKey && i === 0;
    const label = t(batches === 1 ? 'print_btn' : 'plan_batch', { i: i + 1, p1, p2, n1, n2 });
    const button = h('button', { type: 'button', class: `btn btn-block ${i === 0 && !(key && !withKey) ? 'btn-big' : 'btn-soft'}` }, icon('printer'), label, first && ` ${t('plan_with_key')}`);
    button.addEventListener('click', async () => {
      button.disabled = true;
      const original = [...button.childNodes];
      button.replaceChildren(t('plan_preparing'));
      const res = await api('/lot/tickets', { body: { from: n1, to: n2 }, auth });
      button.disabled = false;
      button.replaceChildren(...original);
      if (!res.ok) return;
      const pages = ticketSheets(res.tickets, ctx);
      printPages(first ? [keySheet({ ...key, design }), ...pages] : pages, page);
      onPrint?.();
      button.classList.add('done');
    });
    box.append(button);
  }

  box.append(h('p', { class: 'small muted' }, PAPERS[design.paper].roll ? t('plan_tip_roll', { w: PAPERS[design.paper].w }) : t('plan_tip')));
  if (design.verso) box.append(h('p', { class: 'banner-warn' }, icon('printer'), t('plan_tip_verso')));
  if (key && withKey) {
    const only = h('button', { type: 'button', class: 'linklike small' }, t('plan_key_only'));
    only.addEventListener('click', keyOnly);
    box.append(only);
  }
  return box;
}
