// Impression d'un lot, cahier par cahier : 50 pages A4 au plus à la fois, pour qu'un lot de
// plusieurs milliers de tickets s'imprime sans faire tomber le navigateur.
import { h, t, api, local } from './common.js';
import { keySheet, ticketSheets, fillPrintRoot } from './sheets.js';

export const PAGES_PER_BATCH = 50;

/** Options d'impression mémorisées sur ce téléphone pour chaque lot (logo, numéro, disposition). */
export const printOptions = {
  get: (lotId) => local.get(`wcy:print:${lotId}`, { perPage: 12, showNumber: true, logo: null }),
  set: (lotId, options) => local.set(`wcy:print:${lotId}`, { ...printOptions.get(lotId), ...options }),
};

/** Réduit un logo à 240 px maximum (PNG) : léger, net à l'impression, gardé sur ce téléphone. */
export async function readLogo(file) {
  if (!file) return null;
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 240 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/png');
}

export const pagesFor = (count, perPage) => Math.ceil(count / perPage);

/**
 * Plan d'impression : un bouton par cahier. Le premier cahier commence par la page clé
 * (si `key` est fourni, c'est-à-dire juste après la création du lot).
 */
export function printPlan({ lot, auth, from, to, options, domain, lang, key = null, onPrint }) {
  const perPage = options.perPage;
  const batchSize = perPage * PAGES_PER_BATCH;
  const count = to - from + 1;
  const batches = Math.ceil(count / batchSize);
  const box = h('div', { class: 'stack' });
  box.append(h('p', { class: 'lead' }, t('plan_summary', { count: count.toLocaleString(), pages: pagesFor(count, perPage).toLocaleString(), batches })));
  if (batches > 1) box.append(h('p', { class: 'small muted' }, t('plan_hint')));

  for (let i = 0; i < batches; i++) {
    const n1 = from + i * batchSize;
    const n2 = Math.min(to, n1 + batchSize - 1);
    const p1 = i * PAGES_PER_BATCH + 1;
    const p2 = p1 + pagesFor(n2 - n1 + 1, perPage) - 1;
    const withKey = key && i === 0;
    const label = t(batches === 1 ? 'print_btn' : 'plan_batch', { i: i + 1, p1, p2, n1, n2 });
    const button = h('button', { type: 'button', class: `btn btn-block ${i === 0 ? 'btn-big' : 'btn-soft'}` }, label, withKey && ` ${t('plan_with_key')}`);
    button.addEventListener('click', async () => {
      button.disabled = true;
      const original = button.textContent;
      button.textContent = t('plan_preparing');
      const res = await api('/lot/tickets', { body: { from: n1, to: n2 }, auth });
      button.disabled = false;
      button.textContent = original;
      if (!res.ok) return;
      const pages = ticketSheets(res.tickets, { ...options, lang, domain, name: lot.name });
      fillPrintRoot(withKey ? [keySheet(key), ...pages] : pages);
      onPrint?.();
      window.print();
      button.classList.add('done');
    });
    box.append(button);
  }

  if (key) {
    const keyOnly = h('button', { type: 'button', class: 'linklike small' }, t('plan_key_only'));
    keyOnly.addEventListener('click', () => {
      fillPrintRoot([keySheet(key)]);
      window.print();
    });
    box.append(keyOnly);
  }
  return box;
}
