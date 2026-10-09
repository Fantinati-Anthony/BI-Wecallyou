// Espace commerçant : connexion par la page 1 du PDF (et le mot de passe du lot s'il y en a un),
// appels, suivi des tickets, statistiques, impression, réglages et écran d'affichage.
import { h, t, LANG, api, render, translatePage, errorText, lots, local, fmtTime } from './common.js';
import { textToSecret, secretToText, lotMaterial, authTokenOf, openLot, b64u, openFromClient } from './crypto.js';
import { unlock, callTicket } from './call.js';
import { LAYOUTS, keySheet, fillPrintRoot } from './sheets.js';
import { printPlan, printOptions, readLogo } from './print.js';
import { supportCard, loadSupport } from './donate.js';

translatePage();

const app = document.getElementById('app');
const CHANNELS = ['push', 'sms', 'wa', 'mail'];
const ICON = { push: '🔔', sms: '💬', wa: '🟢', mail: '✉️' };
const LIFETIMES = [1, 3, 6, 12, 24, 48];
let info = null;
let refreshTimer = null;

/* ---------------------------------------------------------------- connexion */

function connectView({ key = '', needsPassword = false, message = '' } = {}) {
  const keyInput = h('input', { id: 'key', type: 'text', value: key, autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false', placeholder: t('m_key_ph') });
  const pwInput = h('input', { id: 'pw', type: 'password', autocomplete: 'current-password' });
  const error = h('p', { class: 'error', role: 'alert', hidden: !message }, message);
  const submit = h('button', { class: 'btn btn-big btn-block', type: 'submit' }, t('m_connect_btn'));
  const form = h(
    'form',
    { class: 'card stack', novalidate: true },
    h('h2', {}, t('m_connect_title')),
    h('p', {}, t('m_connect_text')),
    h('label', { for: 'key' }, t('m_key_label')),
    keyInput,
    h('label', { for: 'pw' }, t('m_password_label')),
    pwInput,
    error,
    submit,
  );
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    error.hidden = true;
    const secret = textToSecret(keyInput.value);
    if (!secret) {
      error.textContent = t('m_bad_key');
      error.hidden = false;
      return;
    }
    submit.disabled = true;
    submit.textContent = t('m_connecting');
    const material = await lotMaterial(secret, pwInput.value);
    const lot = await api('/lot', { auth: await authTokenOf(material) });
    submit.disabled = false;
    submit.textContent = t('m_connect_btn');
    if (!lot.ok) {
      error.textContent = lot.status === 401 ? t(pwInput.value ? 'm_bad_password' : 'm_need_password') : errorText(lot.error);
      error.hidden = false;
      (lot.status === 401 && !pwInput.value ? pwInput : keyInput).focus();
      return;
    }
    await openLot(material, lot.wrapped); // vérifie que les clés privées s'ouvrent bien
    lots.save(lot.lot, { key: secretToText(secret), material: b64u.encode(material), name: lot.name, password: Boolean(pwInput.value) });
    dashboard(lot.lot);
  });
  const others = Object.entries(lots.all());
  render(
    app,
    form,
    others.length > 0 && lotSwitcher(),
    h('p', { class: 'center' }, h('a', { href: '/' }, t('m_new_lot'))),
  );
  (needsPassword && key ? pwInput : keyInput).focus();
}

function lotSwitcher(current = null) {
  const entries = Object.entries(lots.all());
  return h(
    'section',
    { class: 'card' },
    h('h3', {}, t('m_switch')),
    h(
      'div',
      { class: 'stack' },
      entries.map(([id, lot]) =>
        h('button', { type: 'button', class: `btn btn-block ${String(id) === String(current) ? '' : 'btn-soft'}`, onclick: () => dashboard(Number(id)) }, `${lot.name} · #${id}`),
      ),
    ),
  );
}

/* ------------------------------------------------------------- tableau de bord */

async function dashboard(lotId) {
  clearInterval(refreshTimer);
  local.set('wcy:current', lotId);
  const login = await unlock(lotId);
  if (!login) return connectView();
  let lot = await api('/lot', { auth: login.auth });
  if (!lot.ok) return connectView({ key: lots.get(lotId)?.key ?? '', message: errorText(lot.error) });
  const access = await unlock(lotId, lot.wrapped);
  info ??= await api('/info');

  const panel = h('div');
  const tabs = h('div', { class: 'tabs', role: 'tablist' });
  const TABS = { call: 'm_tab_call', history: 'm_tab_history', stats: 'm_tab_stats', print: 'm_tab_print', settings: 'm_tab_settings' };
  const show = (name) => {
    clearInterval(refreshTimer);
    for (const b of tabs.children) b.setAttribute('aria-pressed', String(b.dataset.tab === name));
    ({ call: callTab, history: historyTab, stats: statsTab, print: printTab, settings: settingsTab })[name](panel, { lot, access, reload });
  };
  const reload = async () => {
    lot = await api('/lot', { auth: access.auth });
    return lot;
  };
  for (const [name, key] of Object.entries(TABS)) {
    tabs.append(h('button', { type: 'button', class: 'btn btn-soft', 'data-tab': name, onclick: () => show(name) }, t(key)));
  }
  const donation = await supportCard({ context: 'dashboard', brand: info.brand });
  render(app, h('h1', {}, lot.name), tabs, panel, donation);
  show('call');
}

/* ------------------------------------------------------------------ appels */

async function waitingItems(lot, access, onCall) {
  const items = [];
  for (const w of lot.waiting) {
    const kinds = [];
    for (const sub of w.subs) {
      try {
        kinds.push((await openFromClient(access.keys.ecdh, sub.blob)).c);
      } catch {
        kinds.push('?');
      }
    }
    items.push(
      h(
        'li',
        { class: w.calledAt ? 'called' : '' },
        h('span', { class: 'num' }, w.label),
        h('span', { class: 'grow' }, kinds.map((k) => ICON[k] ?? '❔').join(' '), ' ', h('span', { class: 'small muted' }, w.calledAt ? t('m_called_at', { time: fmtTime(w.calledAt) }) : t('m_since', { time: fmtTime(w.subs[0].at) }))),
        h('button', { type: 'button', class: 'btn btn-soft', onclick: () => onCall(w.n) }, t('m_call_btn')),
      ),
    );
  }
  return items;
}

function statsRow(queue) {
  const rate = queue.avgMs ? t('m_rate_value', { min: Math.max(1, Math.round(queue.avgMs / 60000)) }) : '—';
  return h(
    'div',
    { class: 'stats card' },
    h('div', {}, h('strong', {}, queue.last ?? '—'), h('span', { class: 'small muted' }, t('m_stats_last'))),
    h('div', {}, h('strong', {}, rate), h('span', { class: 'small muted' }, t('m_stats_rate'))),
    h('div', {}, h('strong', {}, queue.waiting ?? 0), h('span', { class: 'small muted' }, t('m_stats_waiting'))),
  );
}

async function callTab(panel, { lot, access, reload }) {
  const result = h('div');
  const number = h('input', { id: 'n', type: 'number', min: 1, max: 999999, inputmode: 'numeric', placeholder: t('m_number') });
  const doCall = async (n) => {
    render(result, h('p', { class: 'muted' }, t('calling', { n: String(n).padStart(3, '0') })));
    const out = await callTicket({ lot, access, target: { n }, brand: info.brand, contact: info.contact });
    render(result, out.ok ? h('div', { class: 'card' }, out.element) : h('p', { class: 'banner-warn' }, errorText(out.error)));
    result.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    refresh();
  };
  const form = h('form', { class: 'row' }, h('div', { class: 'grow' }, number), h('button', { class: 'btn', type: 'submit' }, t('m_call_btn')));
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const n = Number(number.value);
    if (Number.isInteger(n) && n >= 1) doCall(n);
  });
  const stats = h('div');
  const list = h('ul', { class: 'waiting-list' });
  const refresh = async () => {
    const fresh = await reload();
    if (!fresh.ok) return;
    render(stats, statsRow(fresh.queue));
    const items = await waitingItems(fresh, access, doCall);
    render(list, items.length ? items : h('li', { class: 'muted' }, t('m_none')));
  };
  render(
    panel,
    stats,
    h('button', { type: 'button', class: 'btn btn-ghost btn-block', onclick: () => displayMode(access) }, t('m_display')),
    h('section', { class: 'card stack' }, h('h2', {}, t('m_call_title')), h('p', { class: 'small muted' }, t('m_call_hint')), form, result),
    h('section', { class: 'card' }, h('h2', {}, t('m_waiting')), list),
  );
  render(stats, statsRow(lot.queue));
  render(list, h('li', { class: 'muted' }, t('loading')));
  const items = await waitingItems(lot, access, doCall);
  render(list, items.length ? items : h('li', { class: 'muted' }, t('m_none')));
  refreshTimer = setInterval(() => !document.hidden && refresh(), 10_000);
}

/* ------------------------------------------------------------------- suivi */

function eventText([at, type, detail]) {
  const c = detail ? t(`c_${detail}`) : '';
  const text = {
    scan: t('ev_scan'),
    sub: t('ev_sub', { c }),
    unsub: t('ev_unsub'),
    call: t('ev_call'),
    recall: t('ev_recall'),
    push: t(`ev_push_${detail}`),
    send: t('ev_send', { c }),
    seen: t('ev_seen'),
  }[type] ?? type;
  return h('span', { class: 'badge' }, `${fmtTime(at)} · ${text}`);
}

async function historyTab(panel, { lot, access }) {
  render(panel, h('p', { class: 'muted' }, t('loading')));
  const res = await api('/lot/history', { auth: access.auth });
  const items = (res.tickets ?? []).map((ticket) => h('li', {}, h('span', { class: 'num' }, ticket.label), h('div', { class: 'pills grow' }, ticket.events.map(eventText))));
  render(
    panel,
    h(
      'section',
      { class: 'card' },
      h('h2', {}, t('h_title')),
      h('p', { class: 'small muted' }, t('h_hint', { h: lot.ttl })),
      h('ul', { class: 'waiting-list' }, items.length ? items : h('li', { class: 'muted' }, t('h_none'))),
    ),
  );
}

/* ------------------------------------------------------------------- stats */

function sumDays(days) {
  const total = {};
  for (const day of days) for (const [k, v] of Object.entries(day)) if (k !== 'day') total[k] = (total[k] ?? 0) + v;
  return total;
}

function statCards(s) {
  const subs = CHANNELS.reduce((sum, c) => sum + (s[`sub_${c}`] ?? 0), 0);
  const calls = s.call ?? 0;
  const pushes = (s.push_ok ?? 0) + (s.push_fail ?? 0) + (s.push_gone ?? 0);
  const percent = (a, b) => (b ? `${Math.round((a / b) * 100)} %` : '—');
  const wait = s.waits ? `${Math.max(1, Math.round(s.wait_ms / s.waits / 60000))} min` : '—';
  const card = (value, label) => h('div', {}, h('strong', {}, value), h('span', { class: 'small muted' }, label));
  return h(
    'div',
    { class: 'stack' },
    h('div', { class: 'stats' }, card(s.scan ?? 0, t('st_scans')), card(subs, t('st_subs')), card(calls, t('st_calls'))),
    h('div', { class: 'stats' }, card(percent(s.push_ok ?? 0, pushes), t('st_delivery')), card(percent(s.seen ?? 0, calls), t('st_seen')), card(wait, t('st_wait'))),
    h('p', { class: 'small muted center' }, CHANNELS.map((c) => `${ICON[c]} ${s[`sub_${c}`] ?? 0}`).join('   ')),
  );
}

async function statsTab(panel, { access }) {
  render(panel, h('p', { class: 'muted' }, t('loading')));
  const res = await api('/lot/stats', { auth: access.auth });
  const days = res.days ?? [];
  if (days.length === 0) return render(panel, h('section', { class: 'card' }, h('h2', {}, t('st_title')), h('p', {}, t('st_none'))));
  const week = days.filter((d) => Date.now() - Date.parse(d.day) < 7 * 86_400_000);
  const rows = days.slice(0, 14).map((d) => h('tr', {}, h('td', {}, new Date(d.day).toLocaleDateString(LANG)), h('td', {}, d.scan ?? 0), h('td', {}, CHANNELS.reduce((s, c) => s + (d[`sub_${c}`] ?? 0), 0)), h('td', {}, d.call ?? 0)));
  render(
    panel,
    h('section', { class: 'card stack' }, h('h2', {}, t('st_title')), h('h3', {}, t('st_7')), statCards(sumDays(week)), h('h3', {}, t('st_30')), statCards(sumDays(days)), h('p', { class: 'small muted' }, t('st_hint'))),
    h(
      'section',
      { class: 'card' },
      h('table', { class: 'cost-table' }, h('tr', {}, h('th', {}, t('st_day')), h('th', {}, '📱'), h('th', {}, '✍️'), h('th', {}, '📣')), rows),
    ),
  );
}

/* --------------------------------------------------------------- impression */

async function printTab(panel, { lot, access }) {
  const saved = lots.get(lot.lot);
  const options = printOptions.get(lot.lot);
  const support = await loadSupport();
  const monthlyCost = support ? support.costs.reduce((sum, c) => sum + c.month, 0) : 20;
  const from = h('input', { id: 'pf', type: 'number', min: 1, max: 999999, value: lot.from ?? 1 });
  const to = h('input', { id: 'pt', type: 'number', min: 1, max: 999999, value: lot.to ?? 120 });
  const perPage = h('select', { id: 'pp', class: 'select' }, Object.keys(LAYOUTS).map((n) => h('option', { value: n, selected: Number(n) === options.perPage }, t('layout_option', { n }))));
  const showNumber = h('input', { type: 'checkbox', checked: options.showNumber });
  const logo = h('input', { id: 'logo', type: 'file', accept: 'image/png,image/jpeg,image/webp,image/svg+xml' });
  const removeLogo = h('button', { type: 'button', class: 'linklike small', hidden: !options.logo }, '✕ logo');
  const plan = h('div');

  const drawPlan = () => {
    const a = Number(from.value);
    const b = Number(to.value);
    if (!Number.isInteger(a) || !Number.isInteger(b) || a < 1 || b < a || b > 999_999) return render(plan, h('p', { class: 'error' }, t('err_range')));
    render(plan, printPlan({ lot, auth: access.auth, from: a, to: b, options: printOptions.get(lot.lot), domain: info.domain, lang: LANG }));
  };
  const saveOptions = async () => {
    const changes = { perPage: Number(perPage.value), showNumber: showNumber.checked };
    if (logo.files[0]) changes.logo = await readLogo(logo.files[0]).catch(() => null);
    printOptions.set(lot.lot, changes);
    removeLogo.hidden = !printOptions.get(lot.lot).logo;
    drawPlan();
  };
  for (const el of [perPage, showNumber, logo]) el.addEventListener('change', saveOptions);
  for (const el of [from, to]) el.addEventListener('input', drawPlan);
  removeLogo.addEventListener('click', () => {
    printOptions.set(lot.lot, { logo: null });
    removeLogo.hidden = true;
    drawPlan();
  });

  const reprintKey = h('button', { type: 'button', class: 'linklike small' }, t('plan_key_only'));
  reprintKey.addEventListener('click', () => {
    const secret = textToSecret(saved.key);
    fillPrintRoot([keySheet({ lang: LANG, domain: info.domain, brand: info.brand, lot: lot.lot, name: lot.name, secret, from: lot.from, to: lot.to, monthlyCost, password: saved.password })]);
    window.print();
  });

  render(
    panel,
    h(
      'section',
      { class: 'card stack' },
      h('h2', {}, t('m_print_title')),
      h('p', { class: 'small muted' }, t('m_print_hint')),
      h('div', { class: 'inline-fields' }, h('div', {}, h('label', { for: 'pf' }, t('create_first')), from), h('div', {}, h('label', { for: 'pt' }, t('create_to')), to)),
      h('label', { for: 'pp' }, t('create_layout')),
      perPage,
      h('label', { class: 'check' }, showNumber, ' ', t('create_show_number')),
      h('label', { for: 'logo' }, t('create_logo')),
      logo,
      removeLogo,
      plan,
      reprintKey,
    ),
  );
  drawPlan();
}

/* ----------------------------------------------------------------- réglages */

function settingsTab(panel, { lot, access, reload }) {
  const name = h('input', { id: 'sn', type: 'text', maxlength: 60, value: lot.name });
  const promo = h('input', { id: 'sp', type: 'text', maxlength: 140, value: lot.promo, placeholder: t('create_promo_ph') });
  const link = h('input', { id: 'sl', type: 'url', maxlength: 200, value: lot.link, placeholder: t('create_link_ph') });
  const ttl = h('select', { id: 'st', class: 'select' }, LIFETIMES.map((hours) => h('option', { value: hours, selected: hours === lot.ttl }, t('ttl_option', { h: hours }))));
  const checks = CHANNELS.map((c) => h('label', { class: 'check' }, h('input', { type: 'checkbox', value: c, checked: lot.channels.includes(c) }), ` ${ICON[c]} `, t(`ch_${c}`)));
  const status = h('p', { role: 'status' });
  const form = h(
    'form',
    { class: 'card stack' },
    h('h2', {}, t('m_settings_title')),
    h('label', { for: 'sn' }, t('create_name')),
    name,
    h('label', {}, t('create_channels')),
    h('div', { class: 'checks' }, checks),
    h('label', { for: 'st' }, t('create_ttl')),
    ttl,
    h('p', { class: 'small muted' }, t('ttl_hint')),
    h('label', { for: 'sp' }, t('create_promo')),
    promo,
    h('label', { for: 'sl' }, t('create_link')),
    link,
    h('p', { class: 'small muted' }, t('promo_hint')),
    status,
    h('button', { class: 'btn btn-block', type: 'submit' }, t('m_save')),
  );
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const res = await api('/lot/settings', {
      body: {
        name: name.value,
        promo: promo.value,
        link: link.value,
        ttl: Number(ttl.value),
        channels: checks.map((c) => c.querySelector('input')).filter((i) => i.checked).map((i) => i.value),
      },
      auth: access.auth,
    });
    status.className = res.ok ? 'ok' : 'error';
    status.textContent = res.ok ? t('m_saved') : errorText(res.error);
    if (res.ok) {
      Object.assign(lot, res);
      lots.save(lot.lot, { name: res.name });
      await reload();
    }
  });

  const forget = h('button', { type: 'button', class: 'btn btn-ghost btn-block' }, t('m_forget'));
  forget.addEventListener('click', () => {
    if (!confirm(t('m_forget_confirm'))) return;
    lots.forget(lot.lot);
    const next = Object.keys(lots.all())[0];
    if (next) dashboard(Number(next));
    else connectView();
  });

  render(
    panel,
    form,
    h('section', { class: 'card stack' }, h('h2', {}, t('m_device')), h('p', {}, t('m_add_phone')), forget),
    Object.keys(lots.all()).length > 1 && lotSwitcher(lot.lot),
    h('p', { class: 'center' }, h('a', { href: '/' }, t('m_new_lot'))),
  );
}

/* ------------------------------------------------------- écran d'affichage */

async function displayMode(access) {
  const name = h('div', { class: 'd-name' });
  const number = h('div', { class: 'd-number' }, '—');
  const recent = h('div', { class: 'd-recent' });
  const pace = h('div');
  const close = h('button', { type: 'button', class: 'd-close' }, t('d_close'));
  const screen = h(
    'div',
    { class: 'display', role: 'dialog' },
    name,
    h('div', { class: 'd-main' }, h('div', { class: 'd-label' }, t('d_now')), number, recent),
    h('div', { class: 'd-foot' }, pace, h('div', {}, t('d_hint'))),
    close,
  );
  document.body.append(screen);
  let lock = null;
  try {
    await document.documentElement.requestFullscreen?.();
    lock = await navigator.wakeLock?.request('screen');
  } catch {
    /* plein écran ou veille non disponibles : l'écran fonctionne quand même */
  }
  let last = null;
  const update = async () => {
    const q = await api('/lot/queue', { auth: access.auth });
    if (!q.ok) return;
    name.textContent = q.name;
    if (q.last !== last) {
      number.textContent = q.last ?? '—';
      number.classList.remove('bump');
      void number.offsetWidth; // relance l'animation
      if (last !== null) number.classList.add('bump');
      last = q.last;
    }
    render(recent, q.recent.slice(1, 6).map((n) => h('span', {}, n)));
    pace.textContent = q.avgMs ? t('d_wait', { min: Math.max(1, Math.round(q.avgMs / 60000)) }) : '';
  };
  await update();
  const timer = setInterval(update, 3000);
  close.addEventListener('click', () => {
    clearInterval(timer);
    lock?.release?.();
    if (document.fullscreenElement) document.exitFullscreen?.();
    screen.remove();
  });
}

/* ------------------------------------------------------------------ départ */

const hash = decodeURIComponent(location.hash.slice(1));
if (hash) {
  // La clé ne reste pas dans la barre d'adresse ni dans l'historique.
  history.replaceState(null, '', '/m');
  const secret = textToSecret(hash.replace(/!$/, ''));
  const needsPassword = hash.endsWith('!');
  if (secret && !needsPassword) {
    const material = await lotMaterial(secret);
    const lot = await api('/lot', { auth: await authTokenOf(material) });
    if (lot.ok) {
      lots.save(lot.lot, { key: secretToText(secret), material: b64u.encode(material), name: lot.name, password: false });
      await dashboard(lot.lot);
    } else connectView({ key: secretToText(secret, true), message: lot.status === 401 ? t('m_need_password') : errorText(lot.error) });
  } else connectView({ key: secret ? secretToText(secret, true) : '', needsPassword });
} else {
  const current = local.get('wcy:current');
  if (current && lots.get(current)) await dashboard(current);
  else if (Object.keys(lots.all()).length) await dashboard(Number(Object.keys(lots.all())[0]));
  else connectView();
}
