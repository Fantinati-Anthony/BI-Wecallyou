// Page d'accueil : création d'un lot de tickets, entièrement dans le navigateur.
// À gauche les réglages, à droite l'aperçu A4 en direct (studio d'impression).
// Les options Pro sont visibles par tous, grisées tant que le compte connecté n'est pas Pro.
import { h, t, LANG, api, render, translatePage, errorText, lots, local, icon, isPhone } from './common.js';
import { createLot, secretToText, b64u, randomBytes } from './crypto.js';
import { printPlan, printOptions } from './print.js';
import { contentOf, keySheet, posterSheet, fillPrintRoot, keyPage, setPrintPage } from './sheets.js';
import { designControls, livePreview, posterTextFields } from './studio.js';
import { supportCard, nudgeAfterPrint, loadSupport } from './donate.js';
import { session, sync } from './account.js';
import { PRO_LIFETIMES, themeFields, proLock } from './protools.js';
import { loadActivities, messageEditor, ACTIVITY_KEY } from './activities.js';
import { parseNumbers } from './message.js';

const LIFETIMES = [1, 3, 6, 12, 24, 48];
const DEFAULT_LIFETIME = 6;
const MAX_FREE_LIFETIME = 48;
const DRAFT = 'wcy:design-draft'; // derniers réglages d'impression, repris à la prochaine création
const MODE = 'wcy:mode'; // tickets imprimés, affiche à scanner, ou les deux
const SAMPLE_POSTER = 'A'.repeat(23); // aperçu : la vraie affiche reçoit son lien à la création
const SAMPLE_SCREEN = 'B'.repeat(23); // aperçu de la page clé : le vrai écran public a son lien à la création

translatePage();

// Moyens proposés : gratuits ; SMS et WhatsApp partent du téléphone du commerçant (précisé sur ordinateur).
document.getElementById('channels-hint').textContent = isPhone() ? t('channels_hint') : `${t('channels_hint')} ${t('channels_hint_pc')}`;

/* Réglages en trois onglets : Informations, Message, Apparence (clavier : flèches, Début, Fin). */
const tabs = [...document.querySelectorAll('#create-form [role=tab]')];
document.querySelector('#create-form [role=tablist]').setAttribute('aria-label', t('create_title'));
function showTab(tab, focus = false) {
  for (const other of tabs) {
    const on = other === tab;
    other.setAttribute('aria-selected', String(on));
    other.tabIndex = on ? 0 : -1;
    document.getElementById(other.getAttribute('aria-controls')).hidden = !on;
  }
  if (focus) tab.focus();
}
tabs.forEach((tab, i) => {
  tab.addEventListener('click', () => showTab(tab));
  tab.addEventListener('keydown', (event) => {
    const to = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[event.key];
    if (to === undefined) return;
    event.preventDefault();
    showTab(tabs[(to + tabs.length) % tabs.length], true);
  });
});

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
const brand = info.brand ?? 'WeCall.You';
const monthlyCost = support ? support.costs.reduce((sum, c) => sum + c.month, 0) : 20;

/* ------------------------------------------------------------ options Pro */

// Statut connu sur ce téléphone, puis confirmé par le serveur. Installation indépendante « allPro » : tout est ouvert.
let pro = Boolean(info.allPro || session.get()?.pro);
let design = null; // studio d'impression (plus bas) : son logo et ses couleurs suivent le statut Pro
let posterTextsBox = null; // textes de l'affiche et du verso (plus bas)
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
  design?.setPro(on);
}
setPro(pro);
if (session.get() && !info.allPro) sync().then((account) => account && setPro(Boolean(account.pro)));

/* ------------------------------------------------------- message et variables */

// Activité par défaut (choisie sur ce téléphone ou dans le compte), changée d'un bouton : elle donne
// le message, ses variables et la durée conseillée. Le lot reçoit le tout à sa création.
const activities = await loadActivities();
function suggestLifetime(activity) {
  const hours = PRO_LIFETIMES.includes(activity.ttl) && !pro ? MAX_FREE_LIFETIME : activity.ttl;
  if ([...ttlSelect.options].some((o) => Number(o.value) === hours && !o.disabled)) ttlSelect.value = String(hours);
}
const message = messageEditor({
  activities,
  selected: local.get(ACTIVITY_KEY) ?? 'autre',
  name: () => form.elements.name.value.trim(),
  ids: { template: 'ctp', lists: 'cli', groups: 'cgr', choose: 'c-act' },
  onActivity(activity) {
    local.set(ACTIVITY_KEY, activity.id);
    suggestLifetime(activity);
  },
});
document.getElementById('message-slot').append(message.element);
if (message.activity()) suggestLifetime(message.activity());
form.elements.name.addEventListener('input', message.refresh);

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
    poster: modeOf() === 'tickets' ? null : { token: SAMPLE_POSTER },
    key: { lang: LANG, domain, brand, lot: '…', name: name || '…', secret: sampleSecret, from, to, monthlyCost, password: Boolean(password.value), pro, screen: SAMPLE_SCREEN },
  });
};
// Ce qui tient sur le papier dépend du nom et du plus grand numéro du lot.
const contentFor = (value) => contentOf(value, { lang: LANG, domain, name: draft().name, last: draft().to, whiteLabel: pro && whiteLabel.checked });
design = designControls(
  local.get(DRAFT, {}),
  (value) => {
    local.set(DRAFT, value);
    showPosterTexts();
    refresh();
  },
  contentFor,
  { pro },
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

/* ---------------------------------------- comment les clients ont leur numéro */

// Tickets imprimés, affiche à scanner (numéro attribué à l'arrivée), ou les deux.
const modeInputs = [...form.querySelectorAll('input[name=mode]')];
function modeOf() {
  return modeInputs.find((input) => input.checked)?.value ?? 'tickets';
}
const savedMode = local.get(MODE);
if (savedMode) for (const input of modeInputs) input.checked = input.value === savedMode;
function applyMode() {
  const mode = modeOf();
  local.set(MODE, mode);
  document.getElementById('mode-hint').textContent = t(`mode_hint_${mode}`);
  document.getElementById('count-field').hidden = mode === 'poster';
  document.getElementById('layout-section').hidden = mode === 'poster';
  refresh();
  preview.setTab(mode === 'poster' ? 'poster' : 'tickets');
  showPosterTexts();
}
for (const input of modeInputs) input.addEventListener('change', applyMode);
// Textes de l'affiche et du verso des tickets (onglet Message) : utiles avec une affiche ou un verso.
posterTextsBox = h(
  'section',
  { class: 'panel-sec', id: 'poster-texts' },
  h('h3', {}, t('pt_title')),
  posterTextFields({ initial: design.get().posterText, onChange: (posterText) => design.patch({ posterText }) }).element,
);
document.getElementById('panel-message').append(posterTextsBox);
function showPosterTexts() {
  if (!posterTextsBox) return;
  posterTextsBox.hidden = modeOf() === 'tickets' && !design.get().verso;
}
applyMode();

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
  const mode = modeOf();
  const total = mode === 'poster' ? 1 : Number(count.value);
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
  if (!printable && mode !== 'poster') return showError('qr_small');
  // Message et variables : mêmes règles que le serveur, vérifiées avant de créer le lot.
  const msg = message.value();
  if (msg.lists.length > 5 || msg.lists.some((l) => l.name.length > 24 || !/^[\p{L}\p{N}][\p{L}\p{N} _-]*$/u.test(l.name))) return showError('lists');
  if (msg.groups.length > 100 || msg.groups.some((g) => !g.name || !parseNumbers(g.numbers))) return showError('groups');

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
    const res = await api('/lots', { body: { name, from, to, ttl: proTtl && !info.allPro ? MAX_FREE_LIFETIME : ttl, channels, promo, link, poster: mode === 'poster' ? 'only' : undefined, ...lot.request } });
    if (!res.ok) return showError(res.error);
    lots.save(res.lot, { key: secretToText(lot.secret), material: b64u.encode(lot.material), name, password: Boolean(password.value) });
    if (session.get()) await sync(); // connecté : le lot rejoint le compte
    // Réglages appliqués au lot neuf : message et variables (gratuits) et options Pro. Si le Pro est
    // refusé, le message est quand même appliqué.
    let result = res;
    let proError = null;
    const withMessage = Boolean(msg.template.trim() || msg.lists.length || msg.groups.length);
    const colors = pro ? theme.value() : undefined;
    const withPro = pro && (proTtl || whiteLabel.checked || Boolean(colors));
    if (withMessage || withPro) {
      const base = { name, promo, link, channels, ...(withMessage ? msg : {}) };
      let applied = await api('/lot/settings', { body: { ...base, ttl, whiteLabel: withPro && whiteLabel.checked, theme: withPro ? (colors ?? undefined) : undefined }, auth: lot.authToken });
      if (!applied.ok && withPro) {
        proError = applied.error;
        applied = withMessage ? await api('/lot/settings', { body: { ...base, ttl: proTtl ? MAX_FREE_LIFETIME : ttl }, auth: lot.authToken }) : applied;
      }
      if (applied.ok) result = { ...res, whiteLabel: applied.whiteLabel };
      else proError ??= applied.error;
    }
    printOptions.set(res.lot, design.get());
    password.value = password2.value = '';
    await showCreated({ res: result, lot, options: design.get(), hasPassword: lot.material.length > 16, proError, mode });
  } finally {
    button.disabled = false;
    button.textContent = t('create_btn');
  }
});

async function showCreated({ res, lot, options, hasPassword, proError, mode }) {
  const key = { lang: LANG, domain, brand, lot: res.lot, name: res.name, secret: lot.secret, from: res.from, to: res.to, monthlyCost, password: hasPassword, pro: pro && !proError, screen: res.screen };
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
      mode !== 'poster' && printPlan({ lot: res, auth: lot.authToken, from: res.from, to: res.to, options, domain, lang: LANG, key }),
      mode !== 'tickets' && (await posterButton({ res, lot, options, key, withKey: mode === 'poster' })),
      h('a', { class: 'btn btn-ghost btn-block', href: '/m' }, t('open_space')),
    ),
    donation,
  );
  created.hidden = false;
  form.closest('section').hidden = true;
  preview.fab.remove();
  created.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/** Impression de l'affiche (avec la page clé pour un lot « affiche seule », sur la même feuille A4). */
async function posterButton({ res, lot, options, key, withKey }) {
  const state = await api('/lot', { auth: lot.authToken });
  if (!state.ok) return null;
  const button = h('button', { type: 'button', class: `btn btn-block ${withKey ? 'btn-big' : 'btn-soft'}`, id: 'print-poster' }, icon('qr-code'), t(withKey ? 'poster_print_key' : 'poster_print'));
  button.addEventListener('click', () => {
    const poster = posterSheet({ lang: LANG, domain, brand, name: res.name, token: state.poster, logo: options.logo, whiteLabel: Boolean(state.whiteLabel), design: options });
    setPrintPage(keyPage(options));
    fillPrintRoot(withKey ? [keySheet({ ...key, design: options }), poster] : [poster]);
    window.print();
    button.classList.add('done');
  });
  return button;
}
