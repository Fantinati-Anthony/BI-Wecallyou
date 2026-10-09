// Espace commerçant : connexion par la page 1 du PDF (et le mot de passe du lot s'il y en a un),
// appels, suivi des tickets, statistiques, impression, réglages et écran d'affichage.
import { h, t, LANG, api, render, translatePage, errorText, lots, local, fmtTime, qrSvg, icon } from './common.js';
import { textToSecret, secretToText, lotMaterial, authTokenOf, openLot, b64u, openFromClient } from './crypto.js';
import { unlock, callTickets } from './call.js';
import { composer, needsComposer, groupOf, parseNumbers, variableChips, builtinNames } from './message.js';
import { keySheet, fillPrintRoot, contentOf, keyPage, setPrintPage } from './sheets.js';
import { printPlan, printOptions } from './print.js';
import { designControls, livePreview } from './studio.js';
import { PRO_LIFETIMES, themeFields, proLock } from './protools.js';
import { loadActivities, activityPicker, presetOf } from './activities.js';
import { supportCard, loadSupport } from './donate.js';
import { session, sync, removeLot } from './account.js';

/** Ligne du compte en haut de l'espace commerçant : Pro, gratuit, ou invitation (facultative). */
function accountLine(lot) {
  const account = session.get();
  if (!account) return h('p', { class: 'small' }, h('a', { href: '/compte' }, t('acc_login_link')));
  const pro = account.premiumUntil && account.premiumUntil > Date.now();
  return h(
    'div',
    { class: 'pro-line small' },
    h('a', { href: '/compte', class: 'row' }, icon('user-circle'), account.ident),
    pro || lot.pro
      ? h('span', { class: 'badge' }, t('m_account_pro', { date: new Date(account.premiumUntil).toLocaleDateString(LANG) }))
      : h('a', { href: '/pro' }, t('m_account_free')),
  );
}

translatePage();

const app = document.getElementById('app');
const CHANNELS = ['push', 'sms', 'wa', 'mail'];
const ICON = { push: 'bell-ringing', sms: 'chat-circle-text', wa: 'whatsapp-logo', mail: 'envelope-simple' };
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
    if (session.get()) await sync(); // le lot rejoint aussi le compte
    dashboard(lot.lot);
  });
  const others = Object.entries(lots.all());
  render(
    app,
    form,
    others.length > 0 && h('p', { class: 'center' }, h('button', { type: 'button', class: 'btn btn-ghost', onclick: lotsView }, icon('squares-four'), t('lots_back'))),
    !session.get() && h('p', { class: 'center' }, h('a', { href: '/compte' }, t('acc_login_link'))),
    h('p', { class: 'center' }, h('a', { href: '/creer' }, t('m_new_lot'))),
  );
  (needsPassword && key ? pwInput : keyInput).focus();
}

const labelOf = (n) => String(n ?? '').padStart(3, '0');

/** Résumé d'un lot pour sa carte : plage de numéros, Pro, dernier appel (lus avec la clé du lot). */
async function lotSummary(id) {
  const login = await unlock(id);
  if (!login) return null;
  const [lot, queue] = await Promise.all([api('/lot', { auth: login.auth }), api('/lot/queue', { auth: login.auth })]);
  return lot.ok ? { lot, queue: queue.ok ? queue : null } : { error: lot.error, status: lot.status };
}

/** Passer d'un lot à l'autre en un appui : option Pro (compte Pro, lot Pro, ou installation « allPro »). */
let lotIsPro = false;
const multiLots = () => Boolean(info?.allPro || lotIsPro || (session.get()?.pro && (session.get()?.premiumUntil ?? 0) > Date.now()));

/**
 * Mes lots : tous les lots de ce téléphone (et du compte). En Pro, d'un appui on passe de l'un à
 * l'autre ; sans Pro, la liste reste visible mais un autre lot s'ouvre avec sa page clé.
 */
async function lotsView() {
  clearInterval(refreshTimer);
  app.classList.remove('wrap-studio');
  info ??= await api('/info');
  const multi = multiLots();
  const current = String(local.get('wcy:current') ?? '');
  const cards = Object.entries(lots.all()).map(([id, saved]) => {
    const open = multi || id === current;
    const info = h('span', { class: 'lot-info' }, t('loading'));
    const badges = h('span', { class: 'pills' });
    lotSummary(Number(id)).then((summary) => {
      if (!summary || summary.error) {
        info.textContent = t(summary?.status === 401 ? 'lots_locked' : 'lots_unreachable');
        return;
      }
      const { lot, queue } = summary;
      info.textContent = t('lots_range', { from: labelOf(lot.from), to: labelOf(lot.to) });
      render(
        badges,
        lot.pro && h('span', { class: 'badge pro-badge' }, icon('star'), 'Pro'),
        saved.password && h('span', { class: 'badge' }, icon('lock-key'), t('lots_password')),
        h('span', { class: 'badge' }, queue?.last ? t('lots_last', { n: queue.last, time: fmtTime(queue.lastAt) }) : t('lots_no_call')),
      );
    });
    return h(
      open ? 'button' : 'div',
      { type: open ? 'button' : false, class: `lot-card${id === current ? ' current' : ''}${open ? '' : ' locked'}`, onclick: open ? () => dashboard(Number(id)) : false, 'aria-disabled': open ? false : 'true' },
      h('span', { class: 'lot-name' }, saved.name || `#${id}`),
      h('span', { class: 'lot-info' }, t('lot_number', { id })),
      info,
      badges,
    );
  });
  render(
    app,
    h('h1', {}, t('lots_title')),
    h('p', { class: 'muted' }, t(session.get() ? 'lots_synced' : 'lots_device')),
    !multi && proLock(!session.get(), 'lots_pro_lock'),
    h(
      'div',
      { class: 'lot-grid' },
      cards,
      h('a', { class: 'lot-card add', href: '/creer' }, icon('plus'), h('span', { class: 'lot-name' }, t('m_new_lot'))),
      h('button', { type: 'button', class: 'lot-card add', onclick: () => connectView() }, icon('key'), h('span', { class: 'lot-name' }, t(multi ? 'lots_add_existing' : 'lots_open_key'))),
    ),
    !session.get() && h('p', { class: 'small' }, h('a', { href: '/compte' }, t('acc_login_link'))),
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
  lotIsPro = Boolean(lot.pro);

  const panel = h('div');
  const tabs = h('div', { class: 'tabs', role: 'tablist' });
  const TABS = { call: 'm_tab_call', history: 'm_tab_history', stats: 'm_tab_stats', print: 'm_tab_print', settings: 'm_tab_settings' };
  const show = (name) => {
    clearInterval(refreshTimer);
    app.classList.toggle('wrap-studio', name === 'print'); // le studio d'impression a besoin de largeur
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
  const head = h(
    'div',
    { class: 'lot-head' },
    h('div', {}, h('p', { class: 'lot-meta small muted' }, t('lot_number', { id: lot.lot }), ' · ', t('lots_range', { from: labelOf(lot.from), to: labelOf(lot.to) })), h('h1', {}, lot.name)),
    h('button', { type: 'button', class: 'btn btn-ghost', id: 'my-lots', onclick: lotsView }, icon(multiLots() ? 'squares-four' : 'lock-key'), t('lots_mine', { n: Object.keys(lots.all()).length })),
  );
  render(app, head, accountLine(lot), tabs, panel, donation);
  show('call');
}

/* ------------------------------------------------------------------ appels */

async function waitingItems(lot, access, onCall, onlyGroup = '') {
  const items = [];
  for (const w of lot.waiting) {
    const group = groupOf(lot, w.n);
    if (onlyGroup && group !== onlyGroup) continue;
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
        h(
          'span',
          { class: 'grow' },
          group && h('span', { class: 'badge' }, group),
          ' ',
          h('span', { class: 'kinds', title: kinds.map((k) => t(`ch_${k}`)).join(', '), 'aria-label': kinds.map((k) => t(`ch_${k}`)).join(', ') }, kinds.map((k) => icon(ICON[k] ?? 'question'))),
          ' ',
          h('span', { class: 'small muted' }, w.calledAt ? t('m_called_at', { time: fmtTime(w.calledAt) }) : t('m_since', { time: fmtTime(w.subs[0].at) })),
        ),
        h('button', { type: 'button', class: 'btn btn-soft', onclick: () => onCall(w.n) }, t('m_call_btn')),
      ),
    );
  }
  return items;
}

function statsRow(queue) {
  const rate = queue.avgMs ? t('m_rate_value', { min: Math.max(1, Math.round(queue.avgMs / 60000)) }) : '-';
  return h(
    'div',
    { class: 'stats card' },
    h('div', {}, h('strong', {}, queue.last ?? '-'), h('span', { class: 'small muted' }, t('m_stats_last'))),
    h('div', {}, h('strong', {}, rate), h('span', { class: 'small muted' }, t('m_stats_rate'))),
    h('div', {}, h('strong', {}, queue.waiting ?? 0), h('span', { class: 'small muted' }, t('m_stats_waiting'))),
  );
}

/** Écran public : lien secret à ouvrir sur une tablette ou une TV (QR à scanner), révocable. */
function screenCard(lot, access) {
  let token = lot.screen;
  const url = () => `https://${info.domain}/ecran/${token}`;
  const qr = h('div', { class: 'screen-qr' });
  const link = h('p', { class: 'small muted screen-link' });
  const open = h('a', { class: 'btn btn-block', target: '_blank', rel: 'noopener' }, t('sc_open'));
  const copy = h('button', { type: 'button', class: 'btn btn-soft btn-block' }, t('sc_copy'));
  const reset = h('button', { type: 'button', class: 'linklike small' }, t('sc_reset'));
  const draw = () => {
    render(qr, qrSvg(`HTTPS://${info.domain.toUpperCase()}/ECRAN/${token}`, 'M'));
    link.textContent = url();
    open.setAttribute('href', url());
  };
  copy.addEventListener('click', async () => {
    await navigator.clipboard?.writeText(url()).catch(() => {});
    copy.textContent = t('sc_copied');
  });
  reset.addEventListener('click', async () => {
    if (!confirm(t('sc_reset_confirm'))) return;
    const res = await api('/lot/screen/reset', { body: {}, auth: access.auth });
    if (res.ok) {
      token = res.screen;
      draw();
    }
  });
  draw();
  return h(
    'details',
    { class: 'card' },
    h('summary', {}, t('sc_title')),
    h('div', { class: 'stack' }, h('p', {}, t('sc_text')), h('p', { class: 'small' }, t('sc_scan')), qr, link, open, copy, reset),
  );
}

async function callTab(panel, { lot, access, reload }) {
  const result = h('div');
  // Modèle ou listes définis : on choisit les variables et on peut retoucher le message avant l'envoi.
  // Aperçu sur un ticket parlant : le premier d'un groupe s'il y en a, pour que {groupe} se voie.
  const example = parseNumbers(lot.groups[0]?.numbers ?? '')?.[0] ?? lot.from ?? 1;
  const box = needsComposer(lot) ? composer(lot, { label: String(example).padStart(3, '0'), group: groupOf(lot, example) }) : null;
  const show = (out) => {
    render(result, out.ok ? h('div', { class: 'card' }, out.element) : h('p', { class: 'banner-warn' }, errorText(out.error)));
    result.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    refresh();
  };
  const send = (target, group = '', groupName = '') =>
    callTickets({ lot, access, target, brand: info.brand, contact: info.contact, message: box?.message() ?? '', tag: box ? box.tag(group) : group, groupName });

  const number = h('input', { id: 'n', type: 'number', min: 1, max: 999999, inputmode: 'numeric', placeholder: t('m_number') });
  const doCall = async (n) => {
    render(result, h('p', { class: 'muted' }, t('calling', { n: String(n).padStart(3, '0') })));
    show(await send({ n }, groupOf(lot, n)));
  };
  const form = h('form', { class: 'row' }, h('div', { class: 'grow' }, number), h('button', { class: 'btn', type: 'submit' }, t('m_call_btn')));
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const n = Number(number.value);
    if (Number.isInteger(n) && n >= 1) doCall(n);
  });

  // Appel d'un groupe entier (équipe, catégorie…) avec le même message.
  let groupSection = null;
  if (lot.groups.length) {
    const select = h('select', { class: 'select', id: 'grp' }, lot.groups.map((g, i) => h('option', { value: i }, `${g.name} · ${g.numbers}`)));
    const go = h('button', { type: 'button', class: 'btn btn-block' });
    const label = () => {
      go.replaceChildren(icon('megaphone'), t('g_call', { count: parseNumbers(lot.groups[select.value].numbers)?.length ?? 0 }));
    };
    select.addEventListener('change', label);
    go.addEventListener('click', async () => {
      const g = lot.groups[select.value];
      render(result, h('p', { class: 'muted' }, t('calling', { n: g.name })));
      show(await send({ numbers: g.numbers }, g.name, g.name));
    });
    label();
    groupSection = h('section', { class: 'card stack' }, h('h2', {}, t('g_title')), h('label', { for: 'grp' }, t('g_choose')), select, go);
  }

  // Inscrits en attente, filtrables par groupe.
  const filter = lot.groups.length
    ? h('select', { class: 'select' }, h('option', { value: '' }, t('filter_all')), lot.groups.map((g) => h('option', { value: g.name }, g.name)))
    : null;
  const stats = h('div');
  const list = h('ul', { class: 'waiting-list' });
  let current = lot;
  const drawList = async () => {
    const items = await waitingItems(current, access, doCall, filter?.value ?? '');
    render(list, items.length ? items : h('li', { class: 'muted' }, t('m_none')));
  };
  filter?.addEventListener('change', drawList);
  const refresh = async () => {
    const fresh = await reload();
    if (!fresh.ok) return;
    current = fresh;
    render(stats, statsRow(fresh.queue));
    await drawList();
  };

  render(
    panel,
    stats,
    screenCard(lot, access),
    h('section', { class: 'card stack' }, h('h2', {}, t('m_call_title')), h('p', { class: 'small muted' }, t('m_call_hint')), box?.element, form),
    groupSection,
    result,
    h('section', { class: 'card stack' }, h('h2', {}, t('m_waiting')), filter, list),
  );
  render(stats, statsRow(lot.queue));
  render(list, h('li', { class: 'muted' }, t('loading')));
  await drawList();
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
  // Combien de fois chaque ticket a été notifié (appels et rappels), en tête de sa ligne.
  const items = (res.tickets ?? []).map((ticket) => {
    const calls = ticket.events.filter(([, type]) => type === 'call' || type === 'recall').length;
    const count = calls
      ? h('span', { class: 'badge notif-count' }, icon('megaphone'), t(calls === 1 ? 'h_notified_one' : 'h_notified', { n: calls }))
      : h('span', { class: 'badge notif-none' }, t('h_not_notified'));
    return h('li', {}, h('span', { class: 'num' }, ticket.label), h('div', { class: 'grow stack' }, h('div', {}, count), h('div', { class: 'pills' }, ticket.events.map(eventText))));
  });
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
  const percent = (a, b) => (b ? `${Math.round((a / b) * 100)} %` : '-');
  const wait = s.waits ? `${Math.max(1, Math.round(s.wait_ms / s.waits / 60000))} min` : '-';
  const card = (value, label) => h('div', {}, h('strong', {}, value), h('span', { class: 'small muted' }, label));
  return h(
    'div',
    { class: 'stack' },
    h('div', { class: 'stats' }, card(s.scan ?? 0, t('st_scans')), card(subs, t('st_subs')), card(calls, t('st_calls'))),
    h('div', { class: 'stats' }, card(percent(s.push_ok ?? 0, pushes), t('st_delivery')), card(percent(s.seen ?? 0, calls), t('st_seen')), card(wait, t('st_wait'))),
    h('p', { class: 'pills' }, CHANNELS.map((c) => h('span', { class: 'badge', title: t(`ch_${c}`) }, icon(ICON[c]), String(s[`sub_${c}`] ?? 0)))),
  );
}

/** Export tableur (CSV) des statistiques jour par jour : option Pro. */
function exportCsv(lot, days) {
  const columns = ['day', 'scan', ...CHANNELS.map((c) => `sub_${c}`), 'unsub', 'call', 'recall', 'push_ok', 'push_fail', 'push_gone', 'seen', 'send_sms', 'send_wa', 'send_mail'];
  const lines = [[...columns, 'wait_min'].join(';')];
  for (const d of days) {
    const wait = d.waits ? Math.round(d.wait_ms / d.waits / 60000) : '';
    lines.push([...columns.map((c) => d[c] ?? (c === 'day' ? '' : 0)), wait].join(';'));
  }
  const link = h('a', { href: URL.createObjectURL(new Blob([`﻿${lines.join('\n')}\n`], { type: 'text/csv;charset=utf-8' })), download: `wecallyou-stats-${lot.lot}.csv` });
  document.body.append(link);
  link.click();
  link.remove();
}

async function statsTab(panel, { lot, access }) {
  render(panel, h('p', { class: 'muted' }, t('loading')));
  const res = await api(`/lot/stats?days=${lot.pro ? 365 : 30}`, { auth: access.auth });
  const days = res.days ?? [];
  if (days.length === 0) return render(panel, h('section', { class: 'card' }, h('h2', {}, t('st_title')), h('p', {}, t('st_none'))));
  const within = (n) => days.filter((d) => Date.now() - Date.parse(d.day) < n * 86_400_000);
  const rows = days.slice(0, 14).map((d) => h('tr', {}, h('td', {}, new Date(d.day).toLocaleDateString(LANG)), h('td', {}, d.scan ?? 0), h('td', {}, CHANNELS.reduce((s, c) => s + (d[`sub_${c}`] ?? 0), 0)), h('td', {}, d.call ?? 0)));
  render(
    panel,
    h(
      'section',
      { class: 'card stack' },
      h('h2', {}, t('st_title')),
      h('h3', {}, t('st_7')),
      statCards(sumDays(within(7))),
      h('h3', {}, t('st_30')),
      statCards(sumDays(within(30))),
      lot.pro && h('h3', {}, t('st_year')),
      lot.pro && statCards(sumDays(days)),
      lot.pro
        ? h('button', { type: 'button', class: 'btn btn-soft btn-block', onclick: () => exportCsv(lot, days) }, t('st_export'))
        : h('p', { class: 'small' }, h('a', { href: '/pro' }, t('st_pro_more'))),
      h('p', { class: 'small muted' }, t('st_hint')),
    ),
    h(
      'section',
      { class: 'card' },
      h('table', { class: 'cost-table' }, h('tr', {}, h('th', {}, t('st_day')), h('th', {}, t('st_scans')), h('th', {}, t('st_subs')), h('th', {}, t('st_calls'))), rows),
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
  const plan = h('div');
  const preview = livePreview();
  preview.fab.classList.add('near');
  const secret = textToSecret(saved.key);
  const keyCtx = { lang: LANG, domain: info.domain, brand: info.brand, lot: lot.lot, name: lot.name, secret, from: lot.from, to: lot.to, monthlyCost, password: saved.password, pro: lot.pro };

  const range = () => [Number(from.value), Number(to.value)];
  const draw = () => {
    const [a, b] = range();
    const valid = Number.isInteger(a) && Number.isInteger(b) && a >= 1 && b >= a && b <= 999_999;
    const ok = preview.update({ design: controls.get(), lang: LANG, domain: info.domain, name: lot.name, from: valid ? a : lot.from, count: valid ? b - a + 1 : 1, whiteLabel: Boolean(lot.whiteLabel), key: keyCtx });
    if (!valid) return render(plan, h('p', { class: 'error' }, t('err_range')));
    render(plan, ok && printPlan({ lot, auth: access.auth, from: a, to: b, options: controls.get(), domain: info.domain, lang: LANG }));
  };
  // Mise en page commune à tout le lot : calculée pour son plus grand numéro.
  const contentFor = (design) => contentOf(design, { lang: LANG, domain: info.domain, name: lot.name, whiteLabel: Boolean(lot.whiteLabel), last: lot.to });
  const controls = designControls(
    options,
    (design) => {
      printOptions.set(lot.lot, design);
      draw();
    },
    contentFor,
  );
  for (const el of [from, to]) el.addEventListener('input', draw);

  const reprintKey = h('button', { type: 'button', class: 'linklike small' }, t('plan_key_only'));
  reprintKey.addEventListener('click', () => {
    setPrintPage(keyPage(controls.get()));
    fillPrintRoot([keySheet({ ...keyCtx, design: controls.get() })]);
    window.print();
  });

  render(
    panel,
    h(
      'div',
      { class: 'studio' },
      h(
        'div',
        { class: 'studio-form' },
        h(
          'section',
          { class: 'card stack' },
          h('h2', {}, t('m_print_title')),
          h('p', { class: 'small muted' }, t('m_print_hint')),
          h('div', { class: 'inline-fields' }, h('div', {}, h('label', { for: 'pf' }, t('create_first')), from), h('div', {}, h('label', { for: 'pt' }, t('create_to')), to)),
        ),
        h('details', { class: 'card', open: true }, h('summary', {}, t('m_print_layout')), controls.layout),
        h('details', { class: 'card' }, h('summary', {}, t('m_print_colors')), controls.colors),
        h('section', { class: 'card stack' }, plan, reprintKey),
      ),
      preview.element,
    ),
    preview.fab,
  );
  draw();
}

/* ----------------------------------------------------------------- réglages */

const listsToText = (lists) => lists.map((l) => `${l.name} : ${l.options.join(', ')}`).join('\n');
const groupsToText = (groups) => groups.map((g) => `${g.name} : ${g.numbers}`).join('\n');

/** « Nom : a, b, c » par ligne → [{ name, options }]. */
const textToLists = (text) =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [name, ...rest] = line.split(':');
      return { name: name.trim(), options: rest.join(':').split(',').map((o) => o.trim()).filter(Boolean) };
    });

/** « Nom : 12-18, 25 » par ligne → [{ name, numbers }]. */
const textToGroups = (text) =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const at = line.lastIndexOf(':');
      return { name: line.slice(0, at).trim(), numbers: line.slice(at + 1).trim() };
    });

function settingsTab(panel, { lot, access, reload }) {
  const name = h('input', { id: 'sn', type: 'text', maxlength: 60, value: lot.name });
  const promo = h('input', { id: 'sp', type: 'text', maxlength: 140, value: lot.promo, placeholder: t('create_promo_ph') });
  const link = h('input', { id: 'sl', type: 'url', maxlength: 200, value: lot.link, placeholder: t('create_link_ph') });
  // Durées de plusieurs jours et marque masquée : options Pro (grisées sinon, avec le lien vers l'offre).
  const ttl = h(
    'select',
    { id: 'st', class: 'select' },
    LIFETIMES.map((hours) => h('option', { value: hours, selected: hours === lot.ttl }, t('ttl_option', { h: hours }))),
    PRO_LIFETIMES.map((hours) => h('option', { value: hours, selected: hours === lot.ttl, disabled: !lot.pro && hours !== lot.ttl }, t('ttl_days', { d: hours / 24 }))),
  );
  const whiteLabel = h('input', { type: 'checkbox', id: 'swl', checked: lot.whiteLabelSetting, disabled: !lot.pro && !lot.whiteLabelSetting });
  // Couleurs de l'écran public et de la page client (Pro) : les retirer reste toujours possible.
  const theme = themeFields({ initial: lot.themeSetting, enabled: lot.pro, canReset: lot.pro || Boolean(lot.themeSetting), name: lot.name });
  const proSection = h(
    'section',
    { class: 'card stack' },
    h('h2', { class: 'row' }, icon('star'), t('s_pro_options')),
    h('label', { class: 'check', for: 'swl' }, whiteLabel, ' ', t('s_whitelabel')),
    theme.element,
    !lot.pro && proLock(!lot.owned),
  );
  const checks = CHANNELS.map((c) => h('label', { class: 'check' }, h('input', { type: 'checkbox', value: c, checked: lot.channels.includes(c) }), icon(ICON[c]), t(`ch_${c}`)));
  const template = h('textarea', { id: 'stp', class: 'textarea', rows: 3, maxlength: 280, placeholder: t('s_template_ph') });
  template.value = lot.template;
  const lists = h('textarea', { id: 'sli', class: 'textarea', rows: 3, placeholder: t('s_lists_ph') });
  const groups = h('textarea', { id: 'sgr', class: 'textarea', rows: 3, placeholder: t('s_groups_ph') });
  lists.value = listsToText(lot.lists);
  groups.value = groupsToText(lot.groups);

  // Insertion d'une variable dans le modèle d'un simple appui (les listes saisies apparaissent aussitôt).
  const vars = variableChips(template, () => [...builtinNames(), ...textToLists(lists.value).map((l) => l.name)].filter(Boolean));
  const chips = vars.element;
  const drawChips = vars.refresh;
  lists.addEventListener('input', drawChips);
  drawChips();

  // Partir d'un modèle d'activité : message et listes adaptés au métier, puis retouches libres.
  const models = h('div');
  loadActivities().then((activities) => {
    const picker = activityPicker({
      activities,
      name: () => name.value.trim(),
      onPick(activity) {
        const preset = presetOf(activity);
        const mine = template.value.trim() || lists.value.trim();
        if (mine && (template.value !== preset.template || lists.value !== listsToText(preset.lists)) && !confirm(t('act_replace_confirm'))) return;
        template.value = preset.template;
        lists.value = listsToText(preset.lists);
        drawChips();
      },
    });
    name.addEventListener('input', picker.refresh);
    models.append(h('label', {}, t('act_from_model')), picker.element);
  });

  const status = h('p', { role: 'status' });
  const form = h(
    'form',
    { class: 'stack' },
    h(
      'section',
      { class: 'card stack' },
      h('h2', {}, t('m_settings_title')),
      h('label', { for: 'sn' }, t('create_name')),
      name,
      h('label', {}, t('create_channels')),
      h('div', { class: 'checks' }, checks),
      h('label', { for: 'st' }, t('create_ttl')),
      ttl,
      h('p', { class: 'small muted' }, t('ttl_hint'), ' ', t('ttl_pro_hint')),
      lot.ttlApplied !== lot.ttl && h('p', { class: 'small error' }, t('ttl_applied', { h: lot.ttlApplied })),
      h('label', { for: 'sp' }, t('create_promo')),
      promo,
      h('label', { for: 'sl' }, t('create_link')),
      link,
      h('p', { class: 'small muted' }, t('promo_hint')),
    ),
    proSection,
    h(
      'section',
      { class: 'card stack' },
      h('h2', {}, t('s_message')),
      models,
      h('label', { for: 'sli' }, t('s_lists')),
      lists,
      h('p', { class: 'small muted' }, t('s_lists_hint')),
      h('label', { for: 'stp' }, t('s_template')),
      template,
      chips,
      h('p', { class: 'small muted' }, t('s_template_hint')),
      h('label', { for: 'sgr' }, t('s_groups')),
      groups,
      h('p', { class: 'small muted' }, t('s_groups_hint')),
    ),
    status,
    h('button', { class: 'btn btn-big btn-block', type: 'submit' }, t('m_save')),
  );
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const res = await api('/lot/settings', {
      body: {
        name: name.value,
        promo: promo.value,
        link: link.value,
        ttl: Number(ttl.value),
        whiteLabel: whiteLabel.checked,
        theme: theme.value(),
        channels: checks.map((c) => c.querySelector('input')).filter((i) => i.checked).map((i) => i.value),
        template: template.value,
        lists: textToLists(lists.value),
        groups: textToGroups(groups.value),
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
  forget.addEventListener('click', async () => {
    if (!confirm(t('m_forget_confirm'))) return;
    await removeLot(lot.lot);
    if (Object.keys(lots.all()).length) lotsView();
    else connectView();
  });

  render(
    panel,
    form,
    h('section', { class: 'card stack' }, h('h2', {}, t('m_device')), h('p', {}, t('m_add_phone')), forget),
    h('p', { class: 'center' }, h('a', { href: '/creer' }, t('m_new_lot'))),
  );
}

/* ------------------------------------------------------------------ départ */

// Compte connecté : les lots du compte arrivent sur ce téléphone (et inversement).
if (session.get()) await sync();

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
  const all = Object.keys(lots.all());
  if (current && lots.get(current)) await dashboard(current);
  else if (all.length === 1) await dashboard(Number(all[0]));
  else if (all.length > 1) await lotsView();
  else connectView();
}
