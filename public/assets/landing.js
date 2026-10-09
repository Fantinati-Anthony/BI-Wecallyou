// Accueil : un vrai ticket en vitrine (le même rendu que l'impression) et une démonstration du
// chiffrement des coordonnées, calculée dans ce navigateur : rien n'est envoyé au serveur.
import { h, t, LANG, qrSvg } from './common.js';
import { ticketSheets } from './sheets.js';
import { sealForLot, b64u } from './crypto.js';
import { comparison, minProPrice } from './plans.js';

/* Métiers qui utilisent WeCallYou : une ligne qui défile (deux copies pour boucler sans à-coup). */
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
