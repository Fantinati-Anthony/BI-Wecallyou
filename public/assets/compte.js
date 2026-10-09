// Page « Mon compte » : connexion, création (avec fiche de secours), mot de passe oublié,
// et, une fois connecté, statut Pro, lots du compte et gestion de la sécurité.
import { h, t, LANG, api, render, translatePage, errorText, lots, local } from './common.js';
import { textToSecret, secretToText } from './crypto.js';
import { session, signup, login, recover, sync, changePassword, rotateRecovery, logout, deleteAccount, printKit, downloadKit, removeLot, IDENT, MIN_PASSWORD } from './account.js';

translatePage();

const app = document.getElementById('app');
const info = await api('/info');
const kitContext = (ident, recovery) => ({ lang: LANG, domain: info.domain ?? location.host, brand: info.brand ?? 'WeCallYou', ident, recovery });

/* -------------------------------------------------------------- formulaires */

function field(id, labelKey, attrs = {}, hintKey = null) {
  const input = h('input', { id, ...attrs });
  return { input, element: h('div', { class: 'field' }, h('label', { for: id }, t(labelKey)), input, hintKey && h('p', { class: 'small muted' }, t(hintKey))) };
}

function errorBox() {
  const box = h('p', { class: 'error', role: 'alert', hidden: true });
  box.show = (key) => {
    box.textContent = key.startsWith('err_') ? t(key) : errorText(key);
    box.hidden = false;
  };
  return box;
}

/** Envoi d'un formulaire avec bouton « en cours » (le chiffrement prend une seconde). */
function onSubmit(form, button, action) {
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const label = button.textContent;
    button.disabled = true;
    button.textContent = t('acc_working');
    try {
      await action();
    } finally {
      button.disabled = false;
      button.textContent = label;
    }
  });
}

function checkCredentials(ident, password, password2, error) {
  if (!IDENT.test(ident.trim().toLowerCase())) return error.show('err_ident'), false;
  if (password.length < MIN_PASSWORD) return error.show('err_account_short'), false;
  if (password2 !== undefined && password !== password2) return error.show('err_password_match'), false;
  return true;
}

function loginForm() {
  const ident = field('li', 'acc_ident', { type: 'text', autocomplete: 'username', autocapitalize: 'none', spellcheck: 'false' });
  const pw = field('lp', 'acc_password', { type: 'password', autocomplete: 'current-password' });
  const error = errorBox();
  const button = h('button', { class: 'btn btn-big btn-block', type: 'submit' }, t('acc_login_btn'));
  const form = h('form', { class: 'stack', novalidate: true }, ident.element, pw.element, error, button);
  onSubmit(form, button, async () => {
    const res = await login(ident.input.value, pw.input.value);
    if (res.error) return error.show(res.error === 'account_login' ? 'err_account_login' : res.error);
    location.href = '/m';
  });
  return form;
}

function signupForm() {
  const ident = field('si', 'acc_ident', { type: 'text', autocomplete: 'username', autocapitalize: 'none', spellcheck: 'false', maxlength: 32 }, 'acc_ident_hint');
  const pw = field('sp', 'acc_password', { type: 'password', autocomplete: 'new-password' }, 'acc_password_hint');
  const pw2 = field('sp2', 'acc_password2', { type: 'password', autocomplete: 'new-password' });
  const error = errorBox();
  const button = h('button', { class: 'btn btn-big btn-block', type: 'submit' }, t('acc_signup_btn'));
  const form = h('form', { class: 'stack', novalidate: true }, ident.element, pw.element, pw2.element, error, button);
  onSubmit(form, button, async () => {
    if (!checkCredentials(ident.input.value, pw.input.value, pw2.input.value, error)) return;
    const res = await signup(ident.input.value, pw.input.value);
    if (res.error) return error.show(res.error === 'ident_taken' ? 'err_ident_taken' : res.error);
    kitStep(session.get().ident, res.recovery);
  });
  return form;
}

function recoverForm(prefill = {}) {
  const ident = field('ri', 'acc_ident', { type: 'text', value: prefill.ident ?? '', autocomplete: 'username', autocapitalize: 'none', spellcheck: 'false' });
  const key = field('rk', 'rec_key', { type: 'text', value: prefill.key ?? '', autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false', placeholder: 'ABCD-EFGH-…' });
  const pw = field('rp', 'rec_new', { type: 'password', autocomplete: 'new-password' }, 'acc_password_hint');
  const pw2 = field('rp2', 'acc_password2', { type: 'password', autocomplete: 'new-password' });
  const error = errorBox();
  const button = h('button', { class: 'btn btn-big btn-block', type: 'submit' }, t('rec_btn'));
  const form = h('form', { class: 'stack', novalidate: true }, h('p', {}, t('rec_text')), ident.element, key.element, pw.element, pw2.element, error, button);
  onSubmit(form, button, async () => {
    if (!checkCredentials(ident.input.value, pw.input.value, pw2.input.value, error)) return;
    if (!textToSecret(key.input.value)) return error.show('err_recovery');
    const res = await recover(ident.input.value, key.input.value, pw.input.value);
    if (res.error) return error.show(res.error === 'recovery' ? 'err_recovery' : res.error);
    location.href = '/compte';
  });
  return form;
}

/* ------------------------------------------------------------ non connecté */

function guestView(tab = 'login', prefill = {}) {
  const forms = { login: loginForm, signup: signupForm, recover: () => recoverForm(prefill) };
  const tabs = h('div', { class: 'tabs', role: 'tablist' });
  const panel = h('div', { class: 'card' });
  const show = (name) => {
    for (const b of tabs.children) b.setAttribute('aria-pressed', String(b.dataset.tab === name));
    render(panel, forms[name]());
  };
  for (const [name, key] of [['login', 'acc_tab_login'], ['signup', 'acc_tab_signup'], ['recover', 'acc_tab_recover']]) {
    tabs.append(h('button', { type: 'button', class: 'btn btn-soft', 'data-tab': name, onclick: () => show(name) }, t(key)));
  }
  render(app, h('h1', {}, t('acc_title')), h('p', { class: 'muted' }, t('acc_intro')), tabs, panel);
  show(tab);
}

/** Étape obligatoire après la création : garder la fiche de secours (imprimée et/ou téléchargée). */
function kitStep(ident, recovery) {
  const confirm = h('input', { type: 'checkbox', id: 'kit-ok' });
  const next = h('button', { class: 'btn btn-big btn-block', type: 'button', disabled: true }, t('kit_continue'));
  confirm.addEventListener('change', () => {
    next.disabled = !confirm.checked;
  });
  next.addEventListener('click', () => {
    location.href = '/m';
  });
  render(
    app,
    h(
      'section',
      { class: 'card stack' },
      h('h1', {}, `🛟 ${t('kit_title')}`),
      h('p', {}, t('kit_text')),
      h('p', {}, `${t('acc_ident')} : `, h('strong', {}, ident)),
      h('div', { class: 'kit-key' }, secretToText(recovery, true)),
      h('button', { class: 'btn btn-block', type: 'button', onclick: () => printKit(kitContext(ident, recovery)) }, t('kit_print')),
      h('button', { class: 'btn btn-soft btn-block', type: 'button', onclick: () => downloadKit(kitContext(ident, recovery)) }, t('kit_download')),
      h('label', { class: 'check', for: 'kit-ok' }, confirm, ' ', t('kit_confirm')),
      next,
    ),
  );
}

/* ---------------------------------------------------------------- connecté */

async function accountView() {
  const synced = await sync();
  if (!synced) return guestView();
  const s = session.get();
  const status = synced.pro
    ? h('p', { class: 'banner-ok' }, t('acc_pro', { date: new Date(synced.premiumUntil).toLocaleDateString(LANG) }))
    : h('div', { class: 'notice stack' }, h('strong', {}, t('acc_free')), h('p', { class: 'small' }, t('acc_free_hint')), h('a', { class: 'btn btn-gold', href: '/pro' }, t('acc_become_pro')));

  const list = Object.entries(lots.all()).map(([id, lot]) =>
    h(
      'li',
      {},
      h('span', { class: 'grow' }, h('strong', {}, lot.name), h('span', { class: 'small muted' }, ` #${id}`)),
      h('a', { class: 'btn btn-soft', href: '/m', onclick: () => local.set('wcy:current', Number(id)) }, t('acc_open')),
      h('button', { type: 'button', class: 'linklike small', onclick: async () => confirm(t('acc_remove_lot_confirm')) && (await removeLot(id), accountView()) }, '✕'),
    ),
  );

  const pw = h('input', { type: 'password', id: 'np', autocomplete: 'new-password' });
  const pwStatus = h('p', { role: 'status' });
  const pwForm = h('form', { class: 'stack' }, h('label', { for: 'np' }, t('acc_change_pw')), pw, pwStatus, h('button', { class: 'btn btn-soft btn-block', type: 'submit' }, t('m_save')));
  pwForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (pw.value.length < MIN_PASSWORD) {
      pwStatus.className = 'error';
      pwStatus.textContent = t('err_account_short');
      return;
    }
    const res = await changePassword(pw.value);
    pwStatus.className = res.ok ? 'ok' : 'error';
    pwStatus.textContent = res.ok ? t('acc_saved') : errorText(res.error);
    pw.value = '';
  });

  const reprint = () => printKit(kitContext(s.ident, textToSecret(synced.vault.recovery)));
  const rotate = async () => {
    if (!confirm(t('acc_new_kit_confirm'))) return;
    const res = await rotateRecovery();
    if (res.recovery) kitStep(s.ident, res.recovery);
  };

  render(
    app,
    h('h1', {}, t('acc_title')),
    h('p', { class: 'muted' }, t('acc_hello', { ident: s.ident })),
    status,
    h('section', { class: 'card' }, h('h2', {}, t('acc_lots')), list.length ? h('ul', { class: 'waiting-list' }, list) : h('p', { class: 'muted' }, t('acc_lots_none')), h('a', { href: '/' }, t('m_new_lot'))),
    h(
      'section',
      { class: 'card stack' },
      h('h2', {}, t('acc_security')),
      synced.vault.recovery && h('button', { class: 'btn btn-soft btn-block', type: 'button', onclick: reprint }, t('acc_reprint')),
      h('button', { class: 'btn btn-soft btn-block', type: 'button', onclick: rotate }, t('acc_new_kit')),
      pwForm,
    ),
    h(
      'section',
      { class: 'card stack' },
      h('button', { class: 'btn btn-ghost btn-block', type: 'button', onclick: () => (logout(), guestView()) }, t('acc_logout')),
      h('button', { class: 'linklike small', type: 'button', onclick: async () => confirm(t('acc_delete_confirm')) && (await deleteAccount(), guestView()) }, t('acc_delete')),
    ),
  );
}

/* ------------------------------------------------------------------ départ */

const hash = decodeURIComponent(location.hash.slice(1));
if (hash.startsWith('secours=')) {
  // QR code de la fiche de secours : formulaire prérempli, puis la clé disparaît de l'adresse.
  history.replaceState(null, '', '/compte');
  const [ident, key] = hash.slice(8).split(':');
  guestView('recover', { ident, key });
} else if (session.get()) await accountView();
else guestView(hash === 'creer' ? 'signup' : 'login');
