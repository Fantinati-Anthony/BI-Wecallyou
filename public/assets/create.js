// Page d'accueil : création d'un lot de tickets, entièrement dans le navigateur.
import { h, t, LANG, api, render, translatePage, errorText, lots } from './common.js';
import { createLot, secretToText, b64u } from './crypto.js';
import { LAYOUTS, DEFAULT_LAYOUT, ticketSheets } from './sheets.js';
import { printPlan, printOptions, readLogo, pagesFor } from './print.js';
import { supportCard, nudgeAfterPrint, loadSupport } from './donate.js';

const LIFETIMES = [1, 3, 6, 12, 24, 48];
const DEFAULT_LIFETIME = 6;

translatePage();

const form = document.getElementById('create-form');
const errorBox = document.getElementById('create-error');
const created = document.getElementById('created');
const summary = document.getElementById('summary');
const { perPage: layoutSelect, ttl: ttlSelect, count, first, password, password2 } = form.elements;

for (const n of Object.keys(LAYOUTS).map(Number)) {
  layoutSelect.append(h('option', { value: n, selected: n === DEFAULT_LAYOUT }, t(n === DEFAULT_LAYOUT ? 'layout_reco' : 'layout_option', { n })));
}
for (const hours of LIFETIMES) {
  ttlSelect.append(h('option', { value: hours, selected: hours === DEFAULT_LIFETIME }, t('ttl_option', { h: hours })));
}

function updateSummary() {
  const total = Math.max(0, Number(count.value) || 0);
  const per = Number(layoutSelect.value);
  summary.textContent = t('create_summary', { count: total.toLocaleString(), pages: pagesFor(total, per).toLocaleString(), per });
}
for (const el of [count, layoutSelect]) el.addEventListener('input', updateSummary);
updateSummary();

password.addEventListener('input', () => {
  document.getElementById('password2-field').hidden = password.value === '';
});

function showError(code) {
  errorBox.textContent = errorText(code);
  errorBox.hidden = false;
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  errorBox.hidden = true;
  const name = form.elements.name.value.trim();
  const total = Number(count.value);
  const from = Number(first.value);
  const to = from + total - 1;
  const channels = [...form.querySelectorAll('input[name=channels]:checked')].map((c) => c.value);
  const promo = form.elements.promo.value.trim();
  const link = form.elements.link.value.trim();
  if (!name) return showError('name');
  if (!Number.isInteger(total) || !Number.isInteger(from) || total < 1 || from < 1 || to > 999_999) return showError('range');
  if (link && !/^https:\/\//i.test(link)) return showError('link');
  if (password.value && password.value.length < 8) return showError('password_short');
  if (password.value !== password2.value && password.value) return showError('password_match');

  const button = form.querySelector('button[type=submit]');
  button.disabled = true;
  button.textContent = t('creating');
  try {
    let lot;
    try {
      lot = await createLot({ password: password.value });
    } catch {
      return showError('crypto');
    }
    const res = await api('/lots', { body: { name, from, to, ttl: Number(ttlSelect.value), channels, promo, link, ...lot.request } });
    if (!res.ok) return showError(res.error);
    lots.save(res.lot, { key: secretToText(lot.secret), material: b64u.encode(lot.material), name, password: Boolean(password.value) });
    const options = {
      perPage: Number(layoutSelect.value),
      showNumber: form.elements.showNumber.checked,
      logo: await readLogo(form.elements.logo.files[0]).catch(() => null),
    };
    printOptions.set(res.lot, options);
    password.value = password2.value = '';
    await showCreated({ res, lot, options, hasPassword: lot.material.length > 16 });
  } finally {
    button.disabled = false;
    button.textContent = t('create_btn');
  }
});

async function showCreated({ res, lot, options, hasPassword }) {
  const [info, support] = await Promise.all([api('/info'), loadSupport()]);
  const domain = info.domain ?? location.host;
  const brand = info.brand ?? 'WeCallYou';
  const monthlyCost = support ? support.costs.reduce((sum, c) => sum + c.month, 0) : 20;
  const key = { lang: LANG, domain, brand, lot: res.lot, name: res.name, secret: lot.secret, from: res.from, to: res.to, monthlyCost, password: hasPassword };
  const donation = await supportCard({ context: 'create', count: res.to - res.from + 1, brand });
  nudgeAfterPrint(donation);

  // Aperçu d'une page de tickets (exemple calculé localement, sans appel au serveur).
  const sample = Array.from({ length: Math.min(options.perPage, res.to - res.from + 1) }, (_, i) => {
    const label = String(res.from + i).padStart(3, '0');
    return { label, c: 'A'.repeat(26), s: 'B'.repeat(26) };
  });
  const preview = h('div', { class: 'preview' }, h('div', { class: 'preview-box' }, ticketSheets(sample, { ...options, lang: LANG, domain, name: res.name })[0]));

  render(
    created,
    h(
      'div',
      { class: 'card stack' },
      h('h2', {}, '✅ ', t('created_title', { count: (res.to - res.from + 1).toLocaleString() })),
      h('p', {}, t('created_text')),
      hasPassword && h('p', { class: 'banner-warn' }, t('created_password')),
      printPlan({ lot: res, auth: lot.authToken, from: res.from, to: res.to, options, domain, lang: LANG, key }),
      h('a', { class: 'btn btn-ghost btn-block', href: '/m' }, t('open_space')),
    ),
    donation,
    h('details', { class: 'card' }, h('summary', {}, t('preview')), preview),
  );
  created.hidden = false;
  form.closest('section').hidden = true;
  created.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
