// Accueil : des démonstrations jouées dans ce navigateur, sans serveur : un vrai ticket (le même rendu
// que l'impression), le téléphone d'un client, l'écran public animé et le chiffrement des coordonnées.
// Elles suivent l'activité touchée dans la liste ; sinon elles en changent seules, à chaque cycle complet.
import { h, t, LANG, qrSvg, translatePage, icon, ordinal, fmtTime, render, local, isPhone } from './common.js';
import { ticketSheets } from './sheets.js';
import { sealForLot, b64u } from './crypto.js';
import { comparison, minProPrice } from './plans.js';
import { loadActivities, nameOf, demoOf, presetOf, messageExample, ACTIVITY_KEY } from './activities.js';

translatePage();

const STILL = matchMedia('(prefers-reduced-motion: reduce)').matches; // pas de mouvement demandé
const STEP = 2600; // ms entre deux appels de l'écran de démonstration
const FIRST = 43; // premier numéro affiché
const MINE = 46; // le ticket du client de la démonstration
const HOLD = 2; // pas pendant lesquels « C'est à vous ! » reste affiché
const CYCLE = STEP * (MINE - FIRST + HOLD) + 400; // un cycle complet, de « 3e » à « C'est à vous ! »
const pad = (n) => String(n).padStart(3, '0');
/** Relance une animation CSS déjà jouée. */
const replay = (el, cls) => {
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
};
/** Ce que reçoit le client de la démonstration, pour cette activité (null : message par défaut). */
const messageFor = (activity, label) => messageExample(presetOf(activity), demoOf(activity), label);

/* Moyens de prévenir : ce qui part d'où, selon l'appareil du visiteur (un ordinateur n'envoie pas de SMS). */
const deviceNote = document.getElementById('device-note');
if (deviceNote) render(deviceNote, icon(isPhone() ? 'device-mobile' : 'monitor-play'), h('span', {}, t(isPhone() ? 'dev_phone' : 'dev_pc')));

/* Comparatif Gratuit / Pro, au prix le plus bas de l'offre. */
const compare = document.getElementById('compare');
if (compare) minProPrice().then((price) => compare.append(comparison(price)));

/* Ticket de démonstration : son QR code ouvre ce site, jamais un faux ticket. */
const slot = document.getElementById('hero-ticket');
// La feuille est en millimètres : on l'ajuste à la largeur disponible.
const fitTicket = () => {
  const sheet = slot?.firstElementChild;
  if (!sheet) return;
  const scale = slot.clientWidth / sheet.offsetWidth;
  sheet.style.transform = `scale(${scale})`;
  slot.style.height = `${sheet.offsetHeight * scale}px`;
};
function showTicket(name) {
  if (!slot) return;
  const [sheet] = ticketSheets([{ label: '042', c: 'X'.repeat(26), s: 'Y'.repeat(26) }], {
    paper: 'custom',
    pw: 150,
    ph: 64,
    margins: [0, 0, 0, 0],
    cols: 1,
    rows: 1,
    stub: 'right',
    cut: false,
    accent: '#c8461c',
    lang: LANG,
    domain: location.host,
    name,
    last: 42,
  });
  if (!sheet) return;
  for (const qr of sheet.querySelectorAll('.p-qr')) qr.replaceWith(qrSvg(`HTTPS://${location.host.toUpperCase()}/`));
  slot.replaceChildren(sheet);
  fitTicket();
}
if (slot) new ResizeObserver(fitTicket).observe(slot);

/* Téléphone du client : « C'est à vous ! » et le message de l'activité. */
const heroPhone = document.getElementById('hero-phone');
function showPhone(activity, animate) {
  if (!heroPhone) return;
  render(
    heroPhone,
    h('span', { class: 'hp-merchant' }, demoOf(activity)),
    h('p', { class: 'hp-title' }, t('ready_title')),
    h('span', { class: 'hp-number' }, '042'),
    h('p', { class: 'hp-msg' }, messageFor(activity, '042')),
  );
  if (animate) replay(heroPhone, 'swap');
}

/* Écran public animé : les appels s'enchaînent, et le téléphone d'un client suit sa place dans la file,
   de « Vous êtes le 3e » jusqu'à « C'est à vous ! » avec le message de l'activité. */
function liveQueue(box, { onCycle }) {
  const PACE = 2; // minutes entre deux appels
  let activity = null;
  const clock = h('span', { class: 'lq-clock' });
  const merchant = h('span', { class: 'lq-name' });
  const number = h('div', { class: 'lq-number' });
  const prev = h('div', { class: 'lq-prev' });
  const tv = h(
    'div',
    { class: 'lq-tv' },
    h('div', { class: 'lq-head' }, merchant, clock),
    h('div', { class: 'lq-main' }, h('span', { class: 'lq-label' }, t('e_now')), number, prev),
    h('div', { class: 'lq-foot' }, h('span', { class: 's-live' }, t('e_live'))),
  );
  const ticketName = h('span');
  const place = h('div', { class: 'lq-place' });
  const wait = h('div', { class: 'lq-wait' });
  const phone = h('div', { class: 'lq-phone' }, h('div', { class: 'lq-ticket' }, icon('ticket'), h('b', {}, pad(MINE)), ticketName), place, wait);
  box.append(tv, phone);

  let called = FIRST;
  let hold = 0;
  const show = () => {
    clock.textContent = fmtTime(Date.now());
    merchant.textContent = demoOf(activity);
    ticketName.textContent = `· ${demoOf(activity)}`;
    number.textContent = pad(called);
    prev.replaceChildren(...[1, 2, 3, 4, 5].map((k) => h('b', {}, pad(called - k))));
    const pos = MINE - called;
    phone.classList.toggle('is-ready', pos <= 0);
    place.textContent = pos <= 0 ? t('ready_title') : pos === 1 ? t('queue_next') : t('queue_pos', { pos: ordinal(pos) });
    wait.textContent = pos <= 0 ? messageFor(activity, pad(MINE)) : t('queue_wait', { min: pos * PACE });
  };
  // Retour au début du cycle, en fondu.
  const rewind = (before = () => {}) => {
    hold = 0;
    box.classList.add('fade');
    setTimeout(() => {
      before();
      called = FIRST;
      show();
      box.classList.remove('fade');
    }, 400);
  };
  const step = () => {
    if (called < MINE) {
      called += 1;
      show();
      for (const el of [tv, number, prev, phone]) replay(el, 'in');
      return;
    }
    if (++hold < HOLD) return; // « C'est à vous ! » reste affiché un moment
    rewind(onCycle); // cycle complet : l'activité suivante peut prendre la place
  };
  let timer = 0;
  const start = () => {
    clearInterval(timer);
    if (!STILL && document.visibilityState === 'visible') timer = setInterval(step, STEP);
  };
  document.addEventListener('visibilitychange', start);
  show();
  start();
  return {
    setActivity(next) {
      activity = next;
      show();
    },
    /** Recommence le cycle (après un choix d'activité). */
    restart() {
      if (STILL) return;
      rewind();
      start();
    },
  };
}
const live = document.getElementById('live-queue');
const queue = live ? liveQueue(live, { onCycle: () => auto && pick((index + 1) % activities.length, false) }) : null;

/* Activités : un appui adapte les démonstrations ; sans appui, elles défilent à chaque cycle complet. */
showTicket(t('demo_name'));
showPhone(null, false);
const activities = await loadActivities();
const list = document.getElementById('home-acts');
let index = Math.max(0, activities.findIndex((a) => a.id === local.get(ACTIVITY_KEY)));
let auto = !STILL && activities.length > 1;
const chips = activities.map((activity, i) => {
  const chip = h('button', { type: 'button', class: 'act-chip', 'data-id': activity.id, 'aria-pressed': 'false' }, icon(activity.icon), nameOf(activity));
  chip.addEventListener('click', () => pick(i, true));
  return chip;
});
function pick(i, manual) {
  index = i;
  const activity = activities[i];
  for (const [j, chip] of chips.entries()) chip.setAttribute('aria-pressed', String(j === i));
  // Sur téléphone, la liste défile : la pastille choisie reste en vue (sans faire bouger la page).
  if (list && list.scrollWidth > list.clientWidth) list.scrollTo({ left: chips[i].offsetLeft - list.clientWidth / 2 + chips[i].offsetWidth / 2, behavior: STILL ? 'auto' : 'smooth' });
  showTicket(demoOf(activity));
  showPhone(activity, true);
  queue?.setActivity(activity);
  if (manual) {
    auto = false; // l'activité choisie reste à l'écran
    list.classList.remove('auto');
    local.set(ACTIVITY_KEY, activity.id); // et sera proposée à la création des tickets
    queue?.restart();
  }
}
if (list && activities.length) {
  list.append(...chips);
  list.style.setProperty('--cycle', `${CYCLE}ms`);
  list.classList.toggle('auto', auto);
  list.closest('section').hidden = false;
  pick(index, false);
}

/* Chiffrement réel, avec une clé jetable créée ici : voilà tout ce que le serveur verrait. */
const sealed = document.getElementById('cipher-sealed');
if (sealed) {
  const plain = document.getElementById('cipher-plain');
  plain.textContent = t('demo_phone');
  try {
    const keys = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const publicKey = b64u.encode(new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey)));
    sealed.textContent = await sealForLot(publicKey, { c: 'sms', v: t('demo_phone').replace(/\s/g, ''), l: LANG });
  } catch {
    sealed.closest('div').hidden = true; // navigateur sans chiffrement : la démonstration s'efface
  }
}
