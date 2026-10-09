// Page d'accueil : création d'un lot de tickets, entièrement dans le navigateur.
// À gauche les réglages, à droite l'aperçu A4 en direct (studio d'impression).
// Les options Pro sont visibles par tous, grisées tant que le compte connecté n'est pas Pro.
import { h, t, LANG, api, render, translatePage, errorText, lots, local, icon } from './common.js';
import { createLot, secretToText, b64u, randomBytes } from './crypto.js';
import { printPlan, printOptions } from './print.js';
import { contentOf } from './sheets.js';
import { designControls, livePreview } from './studio.js';
import { supportCard, nudgeAfterPrint, loadSupport } from './donate.js';
import { session, sync } from './account.js';
import { PRO_LIFETIMES, themeFields, proLock } from './protools.js';

const LIFETIMES = [1, 3, 6, 12, 24, 48];
const DEFAULT_LIFETIME = 6;
const MAX_FREE_LIFETIME = 48;
const DRAFT = 'wcy:design-draft'; // derniers réglages d'impression, repris à la prochaine création

translatePage();

const form = document.getElementById('create-form');
const errorBox = document.getElementById('create-error');
const created = document.getElementById('created');
const { ttl: ttlSelect, count, first, password, password2 } = form.elements;
for (const hours of LIFETIMES) {
  ttlSelect.append(h('option', { value: hours, selected: hours === DEFAULT_LIFETIME }, t('ttl_option', { h: hours })));
}
const proLifetimes = PRO_LIFETIMES.map((hours) => h('option', { value: hours }, t('ttl_days', { d: hours / 24 })));
ttlSelect.append(...proLifetimes);

const [info, support] = await Promise.all([api('/info'), loadSupport()]);
const domain = info.domain ?? location.host;
const brand = info.brand ?? 'WeCallYou';
const monthlyCost = support ? support.costs.reduce((sum, c) => sum + c.month, 0) : 20;

/* ------------------------------------------------------------ options Pro */

// Statut connu sur ce téléphone, puis confirmé par le serveur. Installation indépendante « allPro » : tout est ouvert.
let pro = Boolean(info.allPro || session.get()?.pro);
const whiteLabel = h('input', { type: 'checkbox', id: 'c-wl' });
const theme = themeFields({ enabled: pro });
const lock = proLock(!session.get());
const proCard = document.getElementById('pro-tools');
document.getElementById('pro-slot').append(h('div', { class: 'stack' }, lock, h('label', { class: 'check', for: 'c-wl' }, whiteLabel, ' ', t('s_whitelabel')), theme.element));

function setPro(on) {
  pro = on;
  for (const option of proLifetimes) option.disabled = !on;
  if (!on && PRO_LIFETIMES.includes(Number(ttlSelect.value))) ttlSelect.value = String(DEFAULT_LIFETIME);
  whiteLabel.disabled = !on;
  if (!on) whiteLabel.checked = false;
  theme.setEnabled(on);
  lock.hidden = on;
  proCard.classList.toggle('locked', !on);
}
setPro(pro);
if (session.get() && !info.allPro) sync().then((account) => account && setPro(Boolean(account.pro)));

/* ------------------------------------------------- studio : réglages + aperçu */

const preview = livePreview();
const sampleSecret = randomBytes(16); // page clé d'exemple : la vraie clé est créée avec le lot
const draft = () => {
  const from = Number(first.value) || 1;
  const total = Math.max(1, Number(count.value) || 1);
  return { name: form.elements.name.value.trim(), from, total, to: from + total - 1 };
};
let printable = true;
const refresh = () => {
  const { name, from, total, to } = draft();
  theme.setName(name);
  printable = preview.update({
    design: design.get(),
    lang: LANG,
    domain,
    name,
    from,
    count: total,
    whiteLabel: pro && whiteLabel.checked,
    key: { lang: LANG, domain, brand, lot: '…', name: name || '…', secret: sampleSecret, from, to, monthlyCost, password: Boolean(password.value), pro },
  });
};
// Ce qui tient sur le papier dépend du nom et du plus grand numéro du lot.
const contentFor = (value) => contentOf(value, { lang: LANG, domain, name: draft().name, last: draft().to, whiteLabel: pro && whiteLabel.checked });
const design = designControls(
  local.get(DRAFT, {}),
  (value) => {
    local.set(DRAFT, value);
    refresh();
  },
  contentFor,
);
document.getElementById('design-layout').append(design.layout);
document.getElementById('design-colors').append(design.colors);
document.getElementById('preview-slot').replaceWith(preview.element);
document.body.append(preview.fab);
// Sur téléphone, le bouton « Aperçu » n'apparaît qu'une fois arrivé au studio.
new IntersectionObserver(([entry]) => preview.fab.classList.toggle('near', entry.isIntersecting)).observe(document.getElementById('creer'));
for (const el of [form.elements.name, count, first, whiteLabel]) {
  el.addEventListener('input', () => {
    design.refresh();
    refresh();
  });
}
password.addEventListener('input', refresh);
refresh();

password.addEventListener('input', () => {
  document.getElementById('password2-field').hidden = password.value === '';
});

/* ------------------------------------------------------------------ création */

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
  const ttl = Number(ttlSelect.value);
  if (!name) return showError('name');
  if (!Number.isInteger(total) || !Number.isInteger(from) || total < 1 || from < 1 || to > 999_999) return showError('range');
  if (link && !/^https:\/\//i.test(link)) return showError('link');
  if (password.value && password.value.length < 8) return showError('password_short');
  if (password.value !== password2.value && password.value) return showError('password_match');
  if (!printable) return showError('qr_small');

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
    // Un lot neuf n'a pas encore de compte : il naît avec une durée gratuite, les options Pro
    // s'appliquent une fois qu'il a rejoint le compte Pro.
    const proTtl = PRO_LIFETIMES.includes(ttl);
    const res = await api('/lots', { body: { name, from, to, ttl: proTtl && !info.allPro ? MAX_FREE_LIFETIME : ttl, channels, promo, link, ...lot.request } });
    if (!res.ok) return showError(res.error);
    lots.save(res.lot, { key: secretToText(lot.secret), material: b64u.encode(lot.material), name, password: Boolean(password.value) });
    if (session.get()) await sync(); // connecté : le lot rejoint le compte
    let result = res;
    let proError = null;
    const colors = pro ? theme.value() : undefined;
    if (pro && (proTtl || whiteLabel.checked || colors)) {
      const applied = await api('/lot/settings', { body: { name, promo, link, channels, ttl, whiteLabel: whiteLabel.checked, theme: colors ?? undefined }, auth: lot.authToken });
      if (applied.ok) result = { ...res, whiteLabel: applied.whiteLabel };
      else proError = applied.error;
    }
    printOptions.set(res.lot, design.get());
    password.value = password2.value = '';
    await showCreated({ res: result, lot, options: design.get(), hasPassword: lot.material.length > 16, proError });
  } finally {
    button.disabled = false;
    button.textContent = t('create_btn');
  }
});

async function showCreated({ res, lot, options, hasPassword, proError }) {
  const key = { lang: LANG, domain, brand, lot: res.lot, name: res.name, secret: lot.secret, from: res.from, to: res.to, monthlyCost, password: hasPassword, pro: pro && !proError };
  const donation = await supportCard({ context: 'create', count: res.to - res.from + 1, brand });
  nudgeAfterPrint(donation);
  render(
    created,
    h(
      'div',
      { class: 'card stack' },
      h('h2', { class: 'row' }, icon('check-circle', 'i ok'), t('created_title', { count: (res.to - res.from + 1).toLocaleString() })),
      h('p', {}, t('created_text')),
      hasPassword && h('p', { class: 'banner-warn' }, icon('lock-key'), t('created_password')),
      proError && h('p', { class: 'banner-warn' }, icon('warning'), t('pro_apply_failed', { error: errorText(proError) })),
      printPlan({ lot: res, auth: lot.authToken, from: res.from, to: res.to, options, domain, lang: LANG, key }),
      h('a', { class: 'btn btn-ghost btn-block', href: '/m' }, t('open_space')),
    ),
    donation,
  );
  created.hidden = false;
  form.closest('section').hidden = true;
  preview.fab.remove();
  created.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
