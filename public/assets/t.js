// Page d'un ticket. Ticket client : choisir comment être prévenu, voir sa place, être averti.
// Souche : si ce téléphone est connecté au lot, l'appel part tout de suite.
import { h, t, LANG, api, render, translatePage, errorText, local, isIOS, isStandalone, ordinal, setColors, inkOn, icon } from './common.js';
import { sealForLot, b64u } from './crypto.js';
import { unlock, callTickets } from './call.js';
import { composer, needsComposer, groupOf } from './message.js';

translatePage();

const app = document.getElementById('app');
const token = (location.pathname.split('/')[1] || '').toUpperCase();
const ICON = { push: 'bell-ringing', sms: 'chat-circle-text', wa: 'whatsapp-logo', mail: 'envelope-simple' };
const storageKey = `wcy:t:${token}`;

// Manifeste propre à ce ticket : l'icône ajoutée à l'écran d'accueil (iPhone) rouvre ce ticket.
document.head.append(h('link', { rel: 'manifest', href: `/${token}/manifest.webmanifest` }));

let data;
let audio = null;
let watching = false;
let refreshTimer = null;

/* ------------------------------------------------------------------ outils */

function unlockAudio() {
  try {
    audio ??= new (window.AudioContext || window.webkitAudioContext)();
    audio.resume();
  } catch {
    /* pas de son possible : l'affichage suffit */
  }
}

function ring() {
  navigator.vibrate?.([400, 150, 400, 150, 800]);
  if (!audio) return;
  const now = audio.currentTime;
  for (let i = 0; i < 3; i++) {
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.frequency.value = 880;
    osc.connect(gain).connect(audio.destination);
    gain.gain.setValueAtTime(0.0001, now + i * 0.45);
    gain.gain.exponentialRampToValueAtTime(0.4, now + i * 0.45 + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.45 + 0.35);
    osc.start(now + i * 0.45);
    osc.stop(now + i * 0.45 + 0.4);
  }
}

function header() {
  const box = h('div', { class: 'ticket-head' }, h('div', { class: 'merchant' }, data.name), h('div', { class: 'number' }, data.label));
  const q = data.queue;
  if (q && data.role === 'client') {
    const place = q.position === 1 ? t('queue_next') : t('queue_pos', { pos: ordinal(q.position) });
    box.append(
      h('div', { class: 'queue-line' }, h('span', { class: 'badge' }, place), q.waitMin && h('span', { class: 'badge' }, t('queue_wait', { min: q.waitMin }))),
      h('p', { class: 'small muted' }, t('queue_last', { n: q.last })),
    );
  }
  return box;
}

/** La ligne du créateur du lot (partenaire, réseaux sociaux), s'il en a mis une. */
function promo() {
  if (data.role !== 'client' || (!data.promo && !data.link)) return null;
  return h(
    'div',
    { class: 'promo-card small' },
    icon('megaphone'),
    h('div', {}, data.promo, data.promo && data.link && ' ', data.link && h('a', { href: data.link, target: '_blank', rel: 'noopener nofollow ugc' }, data.link.replace(/^https:\/\//, ''))),
  );
}

const view = (...children) => render(app, header(), ...children, promo());
const errorView = (code) => render(app, h('p', { class: 'banner-warn' }, errorText(code)));

/* --------------------------------------------------------- temps réel */

/** Attend l'appel : connexion temps réel, ou à défaut vérification du petit fichier d'état. */
function watch() {
  if (watching) return;
  watching = true;
  let polling = null;
  const poll = () => {
    if (polling) return;
    const check = async () => {
      try {
        const res = await fetch(`/etat/${data.status}.txt`, { cache: 'no-store' });
        if (res.ok) ready();
      } catch {
        /* réseau coupé : on réessaie */
      }
    };
    polling = setInterval(check, 5000);
    document.addEventListener('visibilitychange', () => !document.hidden && check());
    check();
  };
  if ('EventSource' in window) {
    const es = new EventSource(`/api/events/${data.status}`);
    es.addEventListener('ready', () => {
      es.close();
      ready();
    });
    es.onerror = () => {
      es.close();
      poll();
    };
  } else poll();

  // La place dans la file se met à jour toutes les 30 s.
  refreshTimer = setInterval(async () => {
    if (document.hidden) return;
    const fresh = await api(`/t/${token}`);
    if (fresh.ok) {
      data = fresh;
      if (fresh.called) ready();
      else app.querySelector('.ticket-head')?.replaceWith(header());
    }
  }, 30_000);
}

let readyShown = false;
async function ready() {
  if (readyShown) return;
  readyShown = true;
  clearInterval(refreshTimer);
  document.title = t('ready_title');
  ring();
  // Le message de l'appel (ex. « attendus au Terrain 3 ») vient avec l'état à jour du ticket.
  if (!data.called) {
    const fresh = await api(`/t/${token}`);
    if (fresh.ok) data = fresh;
  }
  render(
    app,
    h(
      'div',
      { class: 'ready', role: 'alert' },
      h('h1', {}, t('ready_title')),
      h('div', { class: 'number' }, data.label),
      data.message ? h('p', { class: 'ready-message' }, data.message) : h('p', {}, t('ready_text', { n: data.label, m: data.name })),
      promo(),
    ),
  );
  api('/seen', { body: { t: token } });
}

/* ------------------------------------------------------------ inscription */

async function register(kind, value) {
  const blob = await sealForLot(data.pubEcdh, { c: kind, v: value, l: LANG });
  const res = await api('/sub', { body: { t: token, blob, kind } });
  if (!res.ok) return res.error;
  local.set(storageKey, { rid: res.rid, kind });
  registered();
  return null;
}

function choose() {
  const enabled = ['push', 'sms', 'wa', 'mail'].filter((c) => data.channels.includes(c));
  const choices = enabled.map((c) => h('button', { type: 'button', class: 'btn choice', onclick: () => (c === 'push' ? pushFlow() : contactForm(c)) }, h('span', { class: 'icon' }, icon(ICON[c])), t(`ch_${c}`)));
  view(
    h('p', { class: 'lead center' }, t(enabled.length ? 'how' : 'no_channels')),
    h('div', { class: 'stack' }, choices, h('button', { type: 'button', class: 'linklike', onclick: waitOnly }, t('wait_only'))),
  );
}

function contactForm(kind) {
  unlockAudio();
  const isMail = kind === 'mail';
  const input = h('input', {
    id: 'contact',
    type: isMail ? 'email' : 'tel',
    autocomplete: isMail ? 'email' : 'tel',
    inputmode: isMail ? 'email' : 'tel',
    placeholder: t(isMail ? 'ph_mail' : 'ph_tel'),
    required: true,
  });
  const error = h('p', { class: 'error', role: 'alert', hidden: true });
  const submit = h('button', { class: 'btn btn-big btn-block', type: 'submit' }, t('validate'));
  const form = h(
    'form',
    { class: 'card stack', novalidate: true },
    h('label', { for: 'contact' }, t(`label_${kind}`)),
    input,
    error,
    submit,
    h('p', { class: 'small muted' }, t(isMail ? 'privacy_mail' : 'privacy_phone', { m: data.name })),
  );
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const value = input.value.trim();
    const valid = isMail ? /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) : value.replace(/[^\d+]/g, '').length >= 8;
    if (!valid) {
      error.textContent = t('err_contact');
      error.hidden = false;
      return;
    }
    submit.disabled = true;
    const failed = await register(kind, isMail ? value : value.replace(/[^\d+]/g, ''));
    submit.disabled = false;
    if (failed) {
      error.textContent = errorText(failed);
      error.hidden = false;
    }
  });
  view(form, h('button', { type: 'button', class: 'linklike', onclick: choose }, t('back')));
  input.focus();
}

async function pushFlow() {
  unlockAudio();
  const info = (key) => view(h('p', { class: 'banner-warn' }, t(key)), h('button', { type: 'button', class: 'linklike', onclick: choose }, t('back')));
  if (isIOS() && !isStandalone()) return iosGuide();
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return info('push_unsupported');
  // La demande d'autorisation doit suivre directement le geste de l'utilisateur.
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return info('push_denied');
  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64u.decode(data.pubVapid) });
    const failed = await register('push', subscription.toJSON());
    if (failed) info(`err_${failed}`);
  } catch {
    info('push_failed');
  }
}

function iosGuide() {
  view(
    h('div', { class: 'card' }, h('h2', {}, t('ios_title')), h('ol', { class: 'steps' }, h('li', {}, t('ios_1')), h('li', {}, t('ios_2')), h('li', {}, t('ios_3')))),
    h('p', { class: 'notice' }, t('ios_other')),
    h('button', { type: 'button', class: 'linklike', onclick: choose }, t('back')),
  );
}

function registered() {
  const saved = local.get(storageKey);
  const cancel = h('button', { type: 'button', class: 'linklike small' }, t('cancel'));
  cancel.addEventListener('click', async () => {
    await api('/unsub', { body: { t: token, rid: saved.rid } });
    local.remove(storageKey);
    choose();
  });
  view(
    h('div', { class: 'banner-ok center' }, icon('check-circle'), t('registered_title')),
    h('p', { class: 'lead center' }, icon(ICON[saved.kind]), ' ', t(`registered_${saved.kind}`)),
    h('p', { class: 'muted center' }, t('keep_open')),
    h('div', { class: 'center' }, cancel),
  );
  watch();
}

function waitOnly() {
  unlockAudio();
  view(
    h('div', { class: 'card center' }, h('h2', {}, t('waiting_title')), h('p', {}, t('waiting_text'))),
    h('button', { type: 'button', class: 'btn btn-ghost btn-block', onclick: choose }, t('change_mind')),
  );
  watch();
}

/* ------------------------------------------------------------------ souche */

async function stub() {
  const login = await unlock(data.lot);
  if (!login) {
    return view(h('div', { class: 'card' }, h('h2', {}, t('stub_title')), h('p', {}, t('stub_login'))), h('a', { class: 'btn btn-ghost btn-block', href: '/m' }, t('to_dashboard')));
  }
  view(h('p', { class: 'lead center' }, t('loading')));
  const [lot, info] = await Promise.all([api('/lot', { auth: login.auth }), api('/info')]);
  if (!lot.ok) return errorView(lot.error);
  const access = await unlock(data.lot, lot.wrapped);
  const dashboard = h('a', { class: 'btn btn-ghost btn-block', href: '/m' }, t('to_dashboard'));
  const run = async (message = '', tag = '') => {
    view(h('p', { class: 'lead center' }, t('calling', { n: data.label })));
    const result = await callTickets({ lot, access, target: { t: token }, brand: info.brand, contact: info.contact, message, tag });
    if (!result.ok) return errorView(result.error);
    view(result.element, dashboard);
  };
  // Sans modèle ni listes : l'appel part dès le scan. Sinon : choix des variables, retouche, puis appel.
  if (!needsComposer(lot)) return run();
  const group = groupOf(lot, data.n);
  const box = composer(lot, { label: data.label, group });
  const go = h('button', { type: 'button', class: 'btn btn-big btn-block' }, icon('megaphone'), t('call_this', { n: data.label }));
  go.addEventListener('click', () => run(box.message(), box.tag(group)));
  view(h('div', { class: 'card stack' }, h('p', { class: 'small muted' }, t('stub_compose')), box.element, go), dashboard);
}

/* ------------------------------------------------------------------ départ */

data = await api(`/t/${token}`);
if (!data.ok) {
  errorView(data.error === 'network' ? 'network' : 'invalid');
} else {
  document.title = `${data.label} · ${data.name}`;
  // Option Pro : la couleur du commerçant remplace l'orange de WeCallYou (boutons, accents).
  if (data.theme?.accent) {
    const accent = data.theme.accent;
    setColors({ '--brand': accent, '--brand-hover': accent, '--brand-ink': inkOn(accent), '--brand-text': `color-mix(in srgb, ${accent} 70%, var(--text))`, '--brand-soft': `color-mix(in srgb, ${accent} 16%, var(--surface))` });
  }
  // Option Pro « marque masquée » : seul le lien Confidentialité reste (il est obligatoire).
  if (data.whiteLabel) {
    const footer = document.querySelector('footer');
    footer.replaceChildren(footer.querySelector('a[href="/confidentialite"]'));
  }
  if (data.role === 'stub') await stub();
  else {
    if (data.channels.includes('push') && 'serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
    if (data.called) ready();
    else if (local.get(storageKey)) registered();
    else choose();
  }
}
