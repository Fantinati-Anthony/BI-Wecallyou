// « Votez pour la suite » : les idées et leur coût réel (public/idees.json), les voix en direct.
// Voter demande un compte (trois voix par compte) ; lire le classement, non.
import { h, LANG, api, render, translatePage, errorText, icon } from './common.js';
import { session } from './account.js';
import { loadCosts, calibrate, sizeOf, dollars, millions, cents } from './couts.js';

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

const [cfg, costs] = await Promise.all([fetch('/idees.json').then((r) => r.json()).catch(() => null), loadCosts()]);
// L'IA, mesurée sur les évolutions déjà livrées (couts.json) : des fourchettes par taille d'idée.
const calib = calibrate(costs);
const errorBox = document.getElementById('vote-error');
const account = session.get();
let auth = account?.token ? `Account ${account.token}` : null;
let state = { counts: {}, mine: null, max: cfg?.votes_per_account ?? 3 };

/** L'IA d'une idée de cette taille (ou de ces idées) : fourchette de jetons et de dollars au tarif de l'API. */
const aiRange = (ideas) =>
  ideas.reduce(
    (sum, idea) => {
      const size = calib.size(sizeOf(idea.days));
      return { usd: [sum.usd[0] + size.usd[0], sum.usd[1] + size.usd[1]], tokens: [sum.tokens[0] + size.tokens[0], sum.tokens[1] + size.tokens[1]] };
    },
    { usd: [0, 0], tokens: [0, 0] },
  );

/** Ce que coûte une idée : jours, prix avec un développeur, et l'IA mesurée sur les évolutions livrées. */
const costOf = (idea) => {
  const ai = calib && aiRange([idea]);
  return [
    `≈ ${days(idea.days)}`,
    say(`≈ ${euros(idea.days * cfg.rates.dev_day)} avec un développeur`, `≈ ${euros(idea.days * cfg.rates.dev_day)} with a developer`),
    ai && say(`IA : ${millions(ai.tokens[0])} à ${millions(ai.tokens[1])} de jetons (≈ ${dollars(ai.usd[0])} à ${dollars(ai.usd[1])} au tarif de l’API)`, `AI: ${millions(ai.tokens[0])} to ${millions(ai.tokens[1])} tokens (≈ ${dollars(ai.usd[0])} to ${dollars(ai.usd[1])} at API prices)`),
  ].filter(Boolean).join(' · ');
};

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
    const ai = calib && aiRange(top);
    return say(
      `${top.length === 1 ? 'La première' : `Les ${top.length} premières`} : ≈ ${days(total)} de travail, soit ≈ ${euros(total * cfg.rates.dev_day)} avec un développeur${ai ? `, ou ${millions(ai.tokens[0])} à ${millions(ai.tokens[1])} de jetons d’IA (≈ ${dollars(ai.usd[0])} à ${dollars(ai.usd[1])} au tarif de l’API, ${cents(ai.usd[1] * calib.eurPerUsd)} au plus de mon abonnement)` : ''}.`,
      `${top.length === 1 ? 'The top one' : `The top ${top.length}`}: ≈ ${days(total)} of work, that is ≈ ${euros(total * cfg.rates.dev_day)} with a developer${ai ? `, or ${millions(ai.tokens[0])} to ${millions(ai.tokens[1])} AI tokens (≈ ${dollars(ai.usd[0])} to ${dollars(ai.usd[1])} at API prices, at most ${cents(ai.usd[1] * calib.eurPerUsd)} of my subscription)` : ''}.`,
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
    calib &&
      h(
        'li',
        {},
        say(
          `Quand je la code avec un assistant IA, mesuré sur les ${calib.count} évolutions déjà livrées : ${dollars(calib.median)} au tarif de l’API en médiane, soit ${cents(calib.median * calib.eurPerUsd)} de mon abonnement, et environ ${calib.minutes} min de mon temps par évolution. `,
          `When I code it with an AI assistant, measured on the ${calib.count} changes already delivered: ${dollars(calib.median)} at API prices in the median, that is ${cents(calib.median * calib.eurPerUsd)} of my subscription, and about ${calib.minutes} min of my time per change. `,
        ),
        h('a', { href: '/soutenir#frugal' }, say('Le détail', 'The details')),
      ),
    h('li', {}, say('Les durées sont estimées et arrondies au demi-jour : tests et traductions compris.', 'Durations are estimated and rounded to half a day: tests and translations included.')),
    h('li', {}, h('a', { href: '/soutenir' }, say('L’IA ne coûte presque rien : vos contributions paient surtout les serveurs, le seul vrai besoin du projet.', 'AI costs almost nothing: your contributions mostly pay for servers, the project’s only real need.'))),
  );
  const res = await api('/votes', { auth });
  if (res.ok) state = res;
  else if (res.status === 401) auth = null;
  draw();
}
