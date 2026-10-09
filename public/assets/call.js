// Appel d'un ticket depuis le téléphone du commerçant (scan de la souche ou numéro tapé) :
// le serveur rend des blocs chiffrés, ce téléphone les déchiffre, envoie les notifications
// via le relais aveugle et propose un bouton pour chaque SMS, WhatsApp ou e-mail.
import { h, t, tl, api, isIOS, fmtTime, lots } from './common.js';
import { b64u, authTokenOf, openLot, openFromClient, buildPush } from './crypto.js';

/** Accès à un lot connecté sur ce téléphone : jeton d'accès et clés privées (en mémoire seulement). */
export async function unlock(lotId, wrapped) {
  const saved = lots.get(lotId);
  if (!saved?.material) return null;
  const material = b64u.decode(saved.material);
  const auth = await authTokenOf(material);
  const keys = wrapped ? await openLot(material, wrapped) : null;
  return { auth, keys };
}

const smsHref = (to, body) => `sms:${to}${isIOS() ? '&' : '?'}body=${encodeURIComponent(body)}`;
const waHref = (to, body) => `https://wa.me/${to.replace(/^\+/, '')}?text=${encodeURIComponent(body)}`;
const mailHref = (to, subject, body) => `mailto:${to}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
const masked = (value) => (value.includes('@') ? `${value[0]}•••@${value.split('@')[1]}` : `••${value.slice(-2)}`);

// Les coordonnées viennent du client : on refuse tout ce qui pourrait détourner le lien
// (destinataires ou paramètres cachés, comme « ?bcc= » dans une adresse e-mail).
const VALID = {
  sms: (v) => /^\+?[0-9]{8,15}$/.test(v),
  wa: (v) => /^\+?[0-9]{8,15}$/.test(v),
  mail: (v) => v.length <= 254 && /^[^\s@?&#,;:/\\<>"']+@[^\s@?&#,;:/\\<>"']+\.[a-z]{2,}$/i.test(v),
};

/** Le message destiné au client, dans SA langue, avec la ligne du créateur du lot s'il en a mis une. */
function messageFor(lot, label, lang) {
  const extra = [lot.promo, lot.link].filter(Boolean).join(' ');
  const text = tl(lang, 'msg_ready', { m: lot.name, n: label });
  return extra ? `${text}\n${extra}` : text;
}

/**
 * Appelle un ticket et renvoie l'élément qui affiche le résultat.
 * target : { t: code de la souche } ou { n: numéro }.
 */
export async function callTicket({ lot, access, target, brand, contact }) {
  const res = await api('/call', { body: target, auth: access.auth });
  if (!res.ok) return { ok: false, error: res.error };
  const box = h('div', { class: 'result stack' });
  box.append(h('p', { class: 'call-title' }, t('called_title', { n: res.label })));
  if (res.previousAt) box.append(h('p', { class: 'muted' }, t('recall', { time: fmtTime(res.previousAt) })));

  const pushes = [];
  const manual = [];
  let unreadable = 0;
  for (const sub of res.subs) {
    let data;
    try {
      data = await openFromClient(access.keys.ecdh, sub.blob);
    } catch {
      unreadable++;
      continue;
    }
    const lang = data.l === 'fr' ? 'fr' : 'en';
    if (data.c === 'push' && typeof data.v?.endpoint === 'string') pushes.push({ sub, data, lang });
    else if (VALID[data.c]?.(String(data.v))) manual.push({ sub, data, lang });
    else unreadable++;
  }

  // Notifications : préparées ici, relayées à l'aveugle par le serveur.
  if (pushes.length) {
    const messages = await Promise.all(
      pushes.map(({ data, lang }) =>
        buildPush({
          subscription: data.v,
          payload: {
            title: lot.name,
            body: [tl(lang, 'msg_push', { n: res.label }), lot.promo].filter(Boolean).join('\n'),
            url: `/${res.clientToken}`,
            tag: `ticket-${res.label}`,
          },
          vapidKey: access.keys.vapid,
          vapidPublic: lot.pubVapid,
          subject: contact,
        }),
      ),
    );
    const relayed = await api('/relay', { body: { n: res.n, messages }, auth: access.auth });
    const statuses = relayed.statuses ?? messages.map(() => 0);
    const sent = statuses.filter((s) => s >= 200 && s < 300).length;
    if (sent) box.append(h('p', { class: 'ok' }, `🔔 ${t('push_sent')}${sent > 1 ? ` ×${sent}` : ''}`));
    statuses.forEach((status, i) => {
      if (status === 404 || status === 410) {
        api('/sub/drop', { body: { n: res.n, id: pushes[i].sub.id }, auth: access.auth });
        box.append(h('p', { class: 'muted' }, `🔕 ${t('push_lost')}`));
      } else if (status < 200 || status >= 300) {
        box.append(h('p', { class: 'error' }, `🔕 ${t('push_lost')}`));
      }
    });
  }

  // SMS, WhatsApp, e-mail : envoyés par l'application de ce téléphone, en un appui.
  for (const { data, lang } of manual) {
    const body = messageFor(lot, res.label, lang);
    const to = String(data.v);
    const [href, cls, label] = {
      sms: [smsHref(to, body), 'btn-sms', `💬 ${t('send_sms')}`],
      wa: [waHref(to, body), 'btn-wa', `🟢 ${t('send_wa')}`],
      mail: [
        mailHref(to, tl(lang, 'msg_subject', { m: lot.name, n: res.label }), `${body}\n\n${tl(lang, 'msg_mail_foot', { brand })}`),
        'btn-mail',
        `✉️ ${t('send_mail')}`,
      ],
    }[data.c] ?? [];
    if (!href) continue;
    const btn = h('a', { class: `btn btn-block btn-big ${cls}`, href, target: data.c === 'wa' ? '_blank' : false, rel: 'noopener' }, `${label} ${masked(to)}`);
    btn.addEventListener('click', () => {
      if (!btn.classList.contains('done')) api('/lot/event', { body: { n: res.n, type: 'send', detail: data.c }, auth: access.auth });
      btn.classList.add('done');
    });
    box.append(btn);
  }
  if (manual.length) box.append(h('p', { class: 'small muted' }, t('manual_hint')));
  if (unreadable) box.append(h('p', { class: 'muted' }, t('unreadable')));

  if (res.subs.length === 0) {
    box.append(h('div', { class: 'nobody' }, h('strong', {}, t('nobody_title')), t('nobody_text', { n: res.label })));
  }
  return { ok: true, element: box, result: res };
}
