// Écran public (tablette, TV) : les numéros appelés en grand, en direct, annoncés par un carillon
// et une voix. Aucune donnée de client : seulement des numéros et les repères choisis à l'appel.
import { h, t, LANG, api, render, translatePage, local, setColors } from './common.js';

translatePage();

const token = (location.pathname.split('/')[2] || '').toUpperCase();
const root = document.getElementById('screen');
const prefs = { sound: local.get('wcy:screen:sound', true), voice: local.get('wcy:screen:voice', true) };
let audio = null;
let wakeLock = null;
let lastAt = null;
let delay = 2000;

/* ----------------------------------------------------------------- éléments */

const name = h('div', { class: 's-name' });
const clock = h('div', { class: 's-clock' });
const label = h('div', { class: 's-label' }, t('e_now'));
const number = h('div', { class: 's-number' }, '—');
const tagLine = h('div', { class: 's-tag' });
const previous = h('div', { class: 's-prev' });
const pace = h('div');
const promo = h('div', { class: 's-promo' });
const live = h('div', { class: 's-live' }, t('e_live'));

const toggle = (key, icon, text) => {
  const btn = h('button', { type: 'button', 'aria-pressed': String(prefs[key]) }, `${icon} ${text}`);
  btn.addEventListener('click', () => {
    prefs[key] = !prefs[key];
    local.set(`wcy:screen:${key}`, prefs[key]);
    btn.setAttribute('aria-pressed', String(prefs[key]));
  });
  return btn;
};
const start = h('button', { type: 'button', class: 's-start' }, h('strong', {}, t('e_start')), h('span', {}, t('e_start_hint')));

render(
  root,
  h('header', { class: 's-head' }, name, h('div', { class: 's-toggles' }, toggle('sound', '🔔', t('e_sound')), toggle('voice', '🗣', t('e_voice'))), clock),
  h('section', { class: 's-main' }, label, number, tagLine, previous),
  h('footer', { class: 's-foot' }, pace, promo, live),
  start,
);

const tick = () => {
  clock.textContent = new Date().toLocaleTimeString(LANG, { hour: '2-digit', minute: '2-digit' });
};
tick();
setInterval(tick, 10_000);

/* ------------------------------------------------- son, voix, plein écran */

async function keepAwake() {
  try {
    wakeLock = await navigator.wakeLock?.request('screen');
  } catch {
    /* veille non contrôlable : l'écran fonctionne quand même */
  }
}
document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && keepAwake());

// Les navigateurs n'autorisent le son qu'après un geste : un toucher suffit, une seule fois.
start.addEventListener('click', async () => {
  try {
    audio ??= new (window.AudioContext || window.webkitAudioContext)();
    await audio.resume();
  } catch {
    /* pas de son */
  }
  window.speechSynthesis?.speak(new SpeechSynthesisUtterance('')); // débloque la voix sur iPad / Safari
  await document.documentElement.requestFullscreen?.().catch(() => {});
  await keepAwake();
  start.remove();
});

/** Carillon « ding-dong » synthétisé (aucun fichier à charger). */
function chime() {
  if (!prefs.sound || !audio) return;
  const now = audio.currentTime;
  [[659.25, 0], [523.25, 0.45]].forEach(([freq, at]) => {
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    osc.connect(gain).connect(audio.destination);
    gain.gain.setValueAtTime(0.0001, now + at);
    gain.gain.exponentialRampToValueAtTime(0.5, now + at + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + at + 1.2);
    osc.start(now + at);
    osc.stop(now + at + 1.25);
  });
}

/** Annonce vocale, dans la langue de l'écran : « Numéro 42. Terrain 3. » */
function say(announcement) {
  if (!prefs.voice || !('speechSynthesis' in window)) return;
  const single = announcement.labels.length === 1;
  const text = single
    ? `${t('e_say', { n: Number(announcement.labels[0]) })} ${announcement.tag ? `${announcement.tag}.` : ''}`
    : t('e_say_group', { tag: announcement.tag || announcement.labels.map(Number).join(', ') });
  const utterance = new SpeechSynthesisUtterance(text.replaceAll('·', ','));
  utterance.lang = LANG === 'fr' ? 'fr-FR' : 'en-GB';
  utterance.rate = 0.95;
  speechSynthesis.cancel();
  setTimeout(() => speechSynthesis.speak(utterance), prefs.sound && audio ? 1300 : 0);
}

/* ---------------------------------------------------------------- affichage */

/** Les tickets d'un même appel de groupe (même lot d'appel côté serveur) forment une seule annonce. */
function announcements(recent) {
  const out = [];
  for (const call of recent) {
    const last = out.at(-1);
    if (last && call.batch && last.batch === call.batch) last.labels.push(call.label);
    else out.push({ labels: [call.label], tag: call.tag, at: call.at, batch: call.batch });
  }
  for (const a of out) a.labels.sort();
  return out;
}

function show(data) {
  // Couleurs du commerçant (option Pro) : fond, textes, numéro appelé.
  const theme = data.theme ?? {};
  setColors({ '--screen-bg': theme.screenBg, '--screen-text': theme.screenText, '--screen-number': theme.screenNumber });
  name.textContent = data.name;
  document.title = data.name;
  promo.textContent = [data.promo, data.link?.replace(/^https:\/\//, '')].filter(Boolean).join(' · ');
  pace.textContent = data.avgMs ? t('e_pace', { min: Math.max(1, Math.round(data.avgMs / 60000)) }) : '';
  const list = announcements(data.recent);
  const current = list[0];
  if (!current) {
    number.textContent = '—';
    tagLine.textContent = t('e_first');
    return;
  }
  number.textContent = current.labels.join(' · ');
  number.classList.toggle('many', current.labels.length > 1);
  tagLine.textContent = current.tag;
  render(
    previous,
    list.slice(1, 6).map((a) => h('div', {}, h('b', {}, a.labels.length > 3 ? `${a.labels[0]}…${a.labels.at(-1)}` : a.labels.join(' ')), a.tag && h('span', {}, a.tag))),
  );
  if (lastAt !== null && current.at > lastAt) {
    number.classList.remove('bump');
    root.classList.remove('s-flash');
    void number.offsetWidth; // relance les animations
    number.classList.add('bump');
    root.classList.add('s-flash');
    chime();
    say(current);
  }
  lastAt = current.at;
}

async function poll() {
  const data = await api(`/screen/${token}`);
  if (data.status === 404) {
    render(root, h('div', { class: 's-main' }, h('p', { class: 's-tag' }, t('e_invalid'))));
    return;
  }
  if (data.ok) {
    show(data);
    live.classList.remove('off');
    live.textContent = t('e_live');
    delay = 2000;
  } else {
    live.classList.add('off');
    live.textContent = t('e_offline');
    delay = Math.min(delay * 2, 15_000);
  }
  setTimeout(poll, delay);
}

if (/^[A-Z2-7]{23}$/.test(token)) poll();
else render(root, h('div', { class: 's-main' }, h('p', { class: 's-tag' }, t('e_invalid'))));
