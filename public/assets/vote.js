// « Votez pour la suite » : les idées et leur coût réel (public/idees.json), les voix en direct.
// Voter demande un compte (trois voix par compte) ; lire le classement, non.
import { h, LANG, api, render, translatePage, errorText, icon } from './common.js';
import { session } from './account.js';

translatePage();

const FR = LANG === 'fr';
const say = (fr, en) => (FR ? fr : en);
const locale = FR ? 'fr' : 'en'; // la langue des blocs affichés (français, ou anglais pour les autres)
const said = (entry, key = '') => {
  const field = (lang) => entry[key ? `${key}_${lang}` : lang];
  return field(LANG) ?? field('en') ?? field('fr');
};
const euros = (n) => new Intl.NumberFormat(locale, { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(n);
const number = (n) => new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(n);
const days = (n) => say(`${number(n)} jour${n > 1 ? 's' : ''}`, `${number(n)} day${n > 1 ? 's' : ''}`);
const voices = (n) => say(`${n} voix`, `${n} vote${n === 1 ? '' : 's'}`);

const cfg = await fetch('/idees.json').then((r) => r.json()).catch(() => null);
const errorBox = document.getElementById('vote-error');
const account = session.get();
let auth = account?.token ? `Account ${account.token}` : null;
let state = { counts: {}, mine: null, max: cfg?.votes_per_account ?? 3 };

/** Ce que coûte une idée : jours, prix avec un développeur, IA si le fondateur la code. */
const costOf = (idea) => [
  `≈ ${days(idea.days)}`,
  say(`≈ ${euros(idea.days * cfg.rates.dev_day)} avec un développeur`, `≈ ${euros(idea.days * cfg.rates.dev_day)} with a developer`),
  say(`≈ ${euros(idea.days * cfg.rates.ai_day)} d’IA si je la code`, `≈ ${euros(idea.days * cfg.rates.ai_day)} of AI if I code it`),
].join(' · ');

const tierBadge = (idea) => h('span', { class: `badge${idea.tier === 'pro' ? ' pro-badge' : ' free-badge'}` }, idea.tier === 'pro' ? 'Pro' : say('Gratuit', 'Free'));

async function toggle(idea, on) {
  errorBox.hidden = true;
  if (!auth) return document.getElementById('vote-status').scrollIntoView({ behavior: 'smooth', block: 'center' });
  const res = await api('/votes', { body: { idea: idea.id, on }, auth });
  if (!res.ok) {
    errorBox.textContent = errorText(res.error);
    errorBox.hidden = false;
    if (res.status === 401) auth = null; // session expirée : on redemande la connexion
    return draw();
  }
  state = res;
  draw();
}

function draw() {
  const mine = new Set(state.mine ?? []);
  const open = cfg.ideas.filter((i) => i.status === 'vote');
  const used = open.filter((i) => mine.has(i.id)).length;
  const left = Math.max(0, state.max - used);
  const count = (idea) => state.counts[idea.id] ?? 0;

  // Votre compte : se connecter pour voter, ou les voix qui restent.
  render(
    document.getElementById('vote-status'),
    auth
      ? h('p', { class: 'banner-ok' }, icon('check-circle'), h('span', { id: 'votes-left' }, say(`Il vous reste ${left} voix sur ${state.max}.`, `You have ${left} of ${state.max} votes left.`)))
      : h(
          'div',
          { class: 'banner-warn stack' },
          h('p', {}, say('Pour voter, il faut un compte : gratuit, anonyme, sans e-mail. Une fois connecté, revenez ici.', 'To vote, you need an account: free, anonymous, no email. Once signed in, come back here.')),
          h('a', { class: 'btn btn-block', href: '/compte' }, icon('user-circle'), say('Se connecter ou créer un compte', 'Sign in or create an account')),
        ),
  );

  // Une idée du classement, avec sa place, son coût et le bouton pour voter.
  const ideaItem = (idea, rank) => {
    const voted = mine.has(idea.id);
    const button = h(
      'button',
      { type: 'button', class: 'btn vote-btn', 'aria-pressed': String(voted), disabled: Boolean(auth) && !voted && left === 0, 'data-idea': idea.id },
      icon(voted ? 'check' : 'plus'),
      voted ? say('Votée', 'Voted') : say('Voter', 'Vote'),
    );
    button.addEventListener('click', () => toggle(idea, !voted));
    return h(
      'li',
      { class: `idea${voted ? ' mine' : ''}`, id: `idea-${idea.id}` },
      h('span', { class: 'idea-rank' }, String(rank + 1)),
      h(
        'div',
        { class: 'idea-body' },
        h('div', { class: 'idea-head' }, h('strong', {}, said(idea)), tierBadge(idea)),
        h('p', { class: 'small' }, said(idea, 'detail')),
        h('p', { class: 'small muted idea-cost' }, costOf(idea)),
      ),
      h('div', { class: 'idea-vote' }, h('span', { class: 'idea-count' }, voices(count(idea))), button),
    );
  };
  // Ce que coûte le trio de tête d'un chantier, en clair.
  const topLine = (list) => {
    const top = list.filter((i) => count(i) > 0).slice(0, 3);
    const total = top.reduce((sum, i) => sum + i.days, 0);
    if (!top.length) return say('Aucune voix pour l’instant : à vous de donner le ton.', 'No votes yet: it’s up to you to set the tone.');
    return say(
      `${top.length === 1 ? 'La première' : `Les ${top.length} premières`} : ≈ ${days(total)} de travail, soit ≈ ${euros(total * cfg.rates.dev_day)} avec un développeur, ou ≈ ${euros(total * cfg.rates.ai_day)} d’IA.`,
      `${top.length === 1 ? 'The top one' : `The top ${top.length}`}: ≈ ${days(total)} of work, that is ≈ ${euros(total * cfg.rates.dev_day)} with a developer, or ≈ ${euros(total * cfg.rates.ai_day)} of AI.`,
    );
  };
  // Un classement par chantier (la file d'attente, le projet communautaire, le prochain outil) :
  // les plus votées d'abord, à égalité dans l'ordre de la liste.
  const ranked = (list) => list.map((idea, i) => ({ idea, i })).sort((a, b) => count(b.idea) - count(a.idea) || a.i - b.i).map((x) => x.idea);
  render(
    document.getElementById('rankings'),
    (cfg.projects ?? [{ id: 'file', fr: 'Le classement', en: 'The ranking' }]).map((project) => {
      const list = ranked(open.filter((i) => (i.project ?? 'file') === project.id));
      if (!list.length) return null;
      return h(
        'section',
        { class: 'card stack ranking', id: `projet-${project.id}` },
        h('h2', {}, said(project)),
        said(project, 'detail') && h('p', { class: 'muted' }, said(project, 'detail')),
        project.id === 'outil' && said(cfg, 'next_choice') && h('p', { class: 'badge next-choice' }, icon('clock'), say(`Prochain choix : ${said(cfg, 'next_choice')}`, `Next choice: ${said(cfg, 'next_choice')}`)),
        h('p', { class: 'small muted' }, topLine(list)),
        h('ol', { class: 'ideas ideas-open' }, list.map(ideaItem)),
      );
    }),
  );

  // En cours, puis déjà livré.
  const listOf = (status, id, box) => {
    const items = cfg.ideas.filter((i) => i.status === status);
    document.getElementById(box).hidden = !items.length;
    render(
      document.getElementById(id),
      items.map((idea) =>
        h(
          'li',
          { class: `idea ${status}` },
          h('span', { class: 'idea-rank' }, icon(status === 'done' ? 'check-circle' : 'hourglass-medium')),
          h(
            'div',
            { class: 'idea-body' },
            h('div', { class: 'idea-head' }, h('strong', {}, said(idea)), tierBadge(idea)),
            h('p', { class: 'small' }, said(idea, 'detail')),
            h('p', { class: 'small muted' }, [status === 'done' && idea.done && say(`Livré en ${idea.done}`, `Delivered ${idea.done}`), `≈ ${days(idea.days)}`, count(idea) && voices(count(idea))].filter(Boolean).join(' · ')),
          ),
        ),
      ),
    );
  };
  listOf('next', 'ideas-next', 'next-ideas');
  listOf('done', 'ideas-done', 'done-ideas');
}

if (cfg) {
  render(
    document.getElementById('rates-list'),
    h('li', {}, say(`Un jour de développeur indépendant : ≈ ${euros(cfg.rates.dev_day)}.`, `One day of a freelance developer: ≈ ${euros(cfg.rates.dev_day)}.`)),
    h('li', {}, say(`Quand je la code moi-même avec un assistant IA : ≈ ${euros(cfg.rates.ai_day)} d’IA par jour de travail. Mon temps, lui, n’est pas compté.`, `When I code it myself with an AI assistant: ≈ ${euros(cfg.rates.ai_day)} of AI per day of work. My own time isn’t counted.`)),
    h('li', {}, say('Les durées sont estimées et arrondies au demi-jour : tests et traductions compris.', 'Durations are estimated and rounded to half a day: tests and translations included.')),
    h('li', {}, h('a', { href: '/soutenir' }, say('Vos contributions accélèrent la liste : une fois les frais du mois couverts, chaque euro paie de l’IA pour développer plus vite les idées votées.', 'Your contributions speed up the list: once the month’s costs are covered, every euro pays for AI to build the voted ideas faster.'))),
  );
  const res = await api('/votes', { auth });
  if (res.ok) state = res;
  else if (res.status === 401) auth = null;
  draw();
}
