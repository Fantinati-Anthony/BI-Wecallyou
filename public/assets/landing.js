// Accueil : un vrai ticket en vitrine (le même rendu que l'impression) et une démonstration du
// chiffrement des coordonnées, calculée dans ce navigateur : rien n'est envoyé au serveur.
import { h, t, LANG, qrSvg, translatePage, icon, ordinal, fmtTime } from './common.js';
import { ticketSheets } from './sheets.js';
import { sealForLot, b64u } from './crypto.js';
import { comparison, minProPrice } from './plans.js';

translatePage();

/* Métiers qui utilisent WeCall.You : une ligne qui défile (deux copies pour boucler sans à-coup). */
const track = document.querySelector('[data-i18n-list="uses_list"]');
if (track) {
  const items = t('uses_list').split('|');
  track.replaceChildren(...items.map((item) => h('li', {}, item)), ...items.map((item) => h('li', { 'aria-hidden': 'true' }, item)));
}

/* Comparatif Gratuit / Pro, au prix le plus bas de l'offre. */
const compare = document.getElementById('compare');
if (compare) minProPrice().then((price) => compare.append(comparison(price)));

/* Ticket de démonstration : son QR code ouvre ce site, jamais un faux ticket. */
const slot = document.getElementById('hero-ticket');
if (slot) {
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
    name: t('demo_name'),
    last: 42,
  });
  if (sheet) {
    for (const qr of sheet.querySelectorAll('.p-qr')) qr.replaceWith(qrSvg(`HTTPS://${location.host.toUpperCase()}/`));
    slot.append(sheet);
    // La feuille est en millimètres : on l'ajuste à la largeur disponible.
    const fit = () => {
      const scale = slot.clientWidth / sheet.offsetWidth;
      sheet.style.transform = `scale(${scale})`;
      slot.style.height = `${sheet.offsetHeight * scale}px`;
    };
    new ResizeObserver(fit).observe(slot);
  }
}

/* Écran public animé : les appels s'enchaînent, et le téléphone d'un client suit sa place dans la file,
   de « Vous êtes le 3e » jusqu'à « C'est à vous ! ». Une démonstration jouée ici, sans serveur. */
const live = document.getElementById('live-queue');
if (live) liveQueue(live);

function liveQueue(box) {
  const FIRST = 43; // premier numéro affiché
  const MINE = 46; // le ticket du client de la démonstration
  const PACE = 2; // minutes entre deux appels
  const pad = (n) => String(n).padStart(3, '0');
  // Relance une animation CSS déjà jouée.
  const replay = (el) => {
    el.classList.remove('in');
    void el.offsetWidth;
    el.classList.add('in');
  };

  const clock = h('span', { class: 'lq-clock' });
  const number = h('div', { class: 'lq-number' });
  const prev = h('div', { class: 'lq-prev' });
  const tv = h(
    'div',
    { class: 'lq-tv' },
    h('div', { class: 'lq-head' }, h('span', { class: 'lq-name' }, t('demo_name')), clock),
    h('div', { class: 'lq-main' }, h('span', { class: 'lq-label' }, t('e_now')), number, prev),
    h('div', { class: 'lq-foot' }, h('span', { class: 's-live' }, t('e_live'))),
  );
  const place = h('div', { class: 'lq-place' });
  const wait = h('div', { class: 'lq-wait' });
  const phone = h('div', { class: 'lq-phone' }, h('div', { class: 'lq-ticket' }, icon('ticket'), h('b', {}, pad(MINE)), h('span', {}, `· ${t('demo_name')}`)), place, wait);
  box.append(tv, phone);

  let called = FIRST;
  const show = () => {
    clock.textContent = fmtTime(Date.now());
    number.textContent = pad(called);
    prev.replaceChildren(...[1, 2, 3, 4, 5].map((k) => h('b', {}, pad(called - k))));
    const pos = MINE - called;
    phone.classList.toggle('is-ready', pos <= 0);
    place.textContent = pos <= 0 ? t('ready_title') : pos === 1 ? t('queue_next') : t('queue_pos', { pos: ordinal(pos) });
    wait.textContent = pos <= 0 ? '' : t('queue_wait', { min: pos * PACE });
  };
  show();
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return; // image fixe, sans mouvement

  let hold = 0;
  const step = () => {
    if (called < MINE) {
      called += 1;
      show();
      for (const el of [tv, number, prev, phone]) replay(el);
      return;
    }
    if (++hold < 2) return; // « C'est à vous ! » reste affiché un moment, puis tout recommence
    hold = 0;
    box.classList.add('fade');
    setTimeout(() => {
      called = FIRST;
      show();
      box.classList.remove('fade');
    }, 400);
  };
  // Ne tourne que lorsque l'écran est visible.
  let timer = 0;
  new IntersectionObserver(([entry]) => {
    clearInterval(timer);
    if (entry.isIntersecting) timer = setInterval(step, 2600);
  }).observe(box);
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
