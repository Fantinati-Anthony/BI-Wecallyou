// Affiche du comptoir : le client la scanne et reçoit le numéro suivant (ordre d'arrivée), puis
// arrive sur la page de son ticket. Ce téléphone garde son numéro : rescanner l'affiche rouvre le
// même ticket tant qu'il n'a pas été appelé, au lieu d'en prendre un autre.
import { h, api, local, render, translatePage, errorText } from './common.js';

translatePage();

const token = (location.pathname.split('/')[2] || '').toUpperCase();
const key = `wcy:poster:${token}`;
const open = (code) => location.replace(`/${code}?affiche`);

async function take() {
  const kept = local.get(key);
  if (kept) {
    const ticket = await api(`/t/${kept}`);
    if (ticket.ok && !ticket.called) return open(kept);
  }
  const res = await api(`/poster/${token}`, { body: {} });
  if (!res.ok) return render(document.getElementById('app'), h('p', { class: 'banner-warn' }, errorText(res.error === 'invalid' ? 'poster_invalid' : res.error)));
  local.set(key, res.code);
  open(res.code);
}

take();
