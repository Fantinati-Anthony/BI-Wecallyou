// Appel d'un ticket ou d'un groupe depuis le téléphone du commerçant (scan de la souche ou numéro) :
// le serveur rend des blocs chiffrés, ce téléphone les déchiffre, envoie les notifications
// via le relais aveugle et propose un bouton pour chaque SMS, WhatsApp ou e-mail.
import { h, t, tl, api, isIOS, fmtTime, lots } from './common.js';
import { b64u, authTokenOf, openLot, openFromClient, buildPush } from './crypto.js';
import { fill, builtins, groupOf } from './message.js';

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
const mailHref = (bcc, subject, body) => `mailto:?bcc=${bcc.join(',')}&subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
const masked = (value) => (value.includes('@') ? `${value[0]}•••@${value.split('@')[1]}` : `••${value.slice(-2)}`);

// Les coordonnées viennent du client : on refuse tout ce qui pourrait détourner le lien
// (destinataires ou paramètres cachés, comme « ?bcc= » dans une adresse e-mail).
const VALID = {
  sms: (v) => /^\+?[0-9]{8,15}$/.test(v),
  wa: (v) => /^\+?[0-9]{8,15}$/.test(v),
  mail: (v) => v.length <= 254 && /^[^\s@?&#,;:/\\<>"']+@[^\s@?&#,;:/\\<>"']+\.[a-z]{2,}$/i.test(v),
};

/**
 * Texte envoyé au client : le message choisi au moment de l'appel (variables remplies pour ce
 * ticket), sinon le message par défaut dans SA langue ; plus la ligne du créateur du lot.
 */
function textFor(lot, label, lang, message) {
  const base = message
    ? fill(message, builtins({ name: lot.name, label, group: groupOf(lot, Number(label)) }))
    : tl(lang, 'msg_ready', { m: lot.name, n: label });
  const extra = [lot.promo, lot.link].filter(Boolean).join(' ');
  return extra ? `${base}\n${extra}` : base;
}

/** Déchiffre les inscriptions d'un ticket appelé et les trie : notifications / envois manuels. */
async function readSubs(access, call) {
  const pushes = [];
  const manual = [];
  let unreadable = 0;
  for (const sub of call.subs) {
    let data;
    try {
      data = await openFromClient(access.keys.ecdh, sub.blob);
    } catch {
      unreadable++;
      continue;
    }
    const lang = data.l === 'fr' ? 'fr' : 'en';
    if (data.c === 'push' && typeof data.v?.endpoint === 'string') pushes.push({ sub, data, lang, call });
    else if (VALID[data.c]?.(String(data.v))) manual.push({ sub, data, lang, call });
    else unreadable++;
  }
  return { pushes, manual, unreadable };
}

/** Prépare et relaie les notifications d'un ticket ; renvoie le nombre remis et perdu. */
async function sendPushes({ lot, access, contact, message }, call, pushes) {
  if (!pushes.length) return { sent: 0, lost: 0 };
  const messages = await Promise.all(
    pushes.map(({ data, lang }) =>
      buildPush({
        subscription: data.v,
        payload: {
          title: lot.name,
          body: message ? textFor(lot, call.label, lang, message) : [tl(lang, 'msg_push', { n: call.label }), lot.promo].filter(Boolean).join('\n'),
          url: `/${call.clientToken}`,
          tag: `ticket-${call.label}`,
        },
        vapidKey: access.keys.vapid,
        vapidPublic: lot.pubVapid,
        subject: contact,
      }),
    ),
  );
  const relayed = await api('/relay', { body: { n: call.n, messages }, auth: access.auth });
  const statuses = relayed.statuses ?? messages.map(() => 0);
  let sent = 0;
  let lost = 0;
  statuses.forEach((status, i) => {
    if (status >= 200 && status < 300) sent++;
    else {
      lost++;
      if (status === 404 || status === 410) api('/sub/drop', { body: { n: call.n, id: pushes[i].sub.id }, auth: access.auth });
    }
  });
  return { sent, lost };
}

/** Bouton SMS / WhatsApp pour une personne (un appui = l'application s'ouvre, message prêt). */
function manualButton({ lot, access, message, showLabel }, { data, lang, call }) {
  const body = textFor(lot, call.label, lang, message);
  const to = String(data.v);
  const [href, cls, text] = data.c === 'sms' ? [smsHref(to, body), 'btn-sms', `💬 ${t('send_sms')}`] : [waHref(to, body), 'btn-wa', `🟢 ${t('send_wa')}`];
  const btn = h('a', { class: `btn btn-block btn-big ${cls}`, href, target: data.c === 'wa' ? '_blank' : false, rel: 'noopener' }, showLabel ? `${call.label} · ` : '', `${text} ${masked(to)}`);
  btn.addEventListener('click', () => {
    if (!btn.classList.contains('done')) api('/lot/event', { body: { n: call.n, type: 'send', detail: data.c }, auth: access.auth });
    btn.classList.add('done');
  });
  return btn;
}

/** Un seul e-mail pour toutes les adresses, en copie cachée (personne ne voit les autres). */
function mailButton({ lot, access, message, brand }, mails) {
  if (!mails.length) return null;
  const labels = [...new Set(mails.map((m) => m.call.label))];
  const lang = mails[0].lang;
  // Option Pro « marque masquée » : pas de mention de WeCallYou dans l'e-mail.
  const foot = lot.whiteLabel ? tl(lang, 'msg_mail_foot_plain') : tl(lang, 'msg_mail_foot', { brand });
  const body = `${textFor(lot, labels.join(', '), lang, message)}\n\n${foot}`;
  const subject = tl(lang, 'msg_subject', { m: lot.name, n: labels.join(', ') });
  const label = mails.length === 1 ? `✉️ ${t('send_mail')} ${masked(String(mails[0].data.v))}` : t('g_mail', { count: mails.length });
  const btn = h('a', { class: 'btn btn-block btn-big btn-mail', href: mailHref(mails.map((m) => m.data.v), subject, body) }, label);
  btn.addEventListener('click', () => {
    if (!btn.classList.contains('done')) for (const m of mails) api('/lot/event', { body: { n: m.call.n, type: 'send', detail: 'mail' }, auth: access.auth });
    btn.classList.add('done');
  });
  return btn;
}

/**
 * Appelle un ticket (target = { t: code de la souche } ou { n: numéro }) ou un groupe
 * (target = { numbers: '12-18' }), avec un message optionnel et un repère pour l'écran.
 */
export async function callTickets({ lot, access, target, brand, contact, message = '', tag = '', groupName = '' }) {
  const res = await api('/call', { body: { ...target, message, tag }, auth: access.auth });
  if (!res.ok) return { ok: false, error: res.error };
  const calls = res.calls ?? [res];
  const ctx = { lot, access, brand, contact, message, showLabel: calls.length > 1 };
  const box = h('div', { class: 'result stack' });
  box.append(
    h('p', { class: 'call-title' }, calls.length > 1 ? t('g_result', { name: groupName, count: calls.length }) : t('called_title', { n: res.label })),
  );
  if (calls.length === 1 && res.previousAt) box.append(h('p', { class: 'muted' }, t('recall', { time: fmtTime(res.previousAt) })));
  if (message) box.append(h('p', { class: 'notice small' }, fill(message, builtins({ name: lot.name, label: calls[0].label, group: groupOf(lot, calls[0].n) }))));

  let sent = 0;
  let lost = 0;
  let unreadable = 0;
  const manual = [];
  const nobody = [];
  for (const call of calls) {
    const subs = await readSubs(access, call);
    const pushed = await sendPushes(ctx, call, subs.pushes);
    sent += pushed.sent;
    lost += pushed.lost;
    unreadable += subs.unreadable;
    manual.push(...subs.manual);
    if (call.subs.length === 0) nobody.push(call.label);
  }

  if (sent) box.append(h('p', { class: 'ok' }, `🔔 ${t('push_sent')}${sent > 1 ? ` ×${sent}` : ''}`));
  if (lost) box.append(h('p', { class: 'muted' }, `🔕 ${t('push_lost')}${lost > 1 ? ` ×${lost}` : ''}`));
  for (const entry of manual.filter((m) => m.data.c !== 'mail')) box.append(manualButton(ctx, entry));
  box.append(mailButton(ctx, manual.filter((m) => m.data.c === 'mail')) ?? '');
  if (manual.length) box.append(h('p', { class: 'small muted' }, t('manual_hint')));
  if (unreadable) box.append(h('p', { class: 'muted' }, t('unreadable')));
  if (nobody.length) {
    box.append(
      h(
        'div',
        { class: 'nobody' },
        h('strong', {}, t('nobody_title')),
        calls.length > 1 ? t('g_nobody', { list: nobody.join(', ') }) : t('nobody_text', { n: res.label }),
      ),
    );
  }
  return { ok: true, element: box, result: res };
}
