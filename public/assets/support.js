// Page « Soutenir » : encart de dons, le plan chiffré (chapitres, prochain palier), les frais, et
// « le service tient-il la route ? » (bulletin du mois et simulateur). Les montants des paliers
// suivent l'affluence : la réelle au chargement, celle du simulateur quand on bouge les curseurs.
import { h, t, LANG, render, translatePage } from './common.js';
import { supportCard, loadSupport } from './donate.js';
import { model, amounts, scenarioOf, targetOf, loadUsage } from './plan.js';
import { loadCosts, calibrate, dollars, millions, cents } from './couts.js';

translatePage();

const [cfg, usage, costs] = await Promise.all([loadSupport(), loadUsage(), loadCosts()]);
document.getElementById('card').append(await supportCard({ context: 'support' }));

const fr = LANG === 'fr';
// Textes de soutien.json : en français ou en anglais (comme les blocs de la page), l'anglais sinon.
const said = (entry, key = '') => {
  const field = (lang) => entry[key ? `${key}_${lang}` : lang];
  return field(LANG) ?? field('en') ?? field('fr');
};
// Montants dans la langue des blocs affichés ; les centimes seulement quand il y en a (2,50 €).
const euros = (n) => new Intl.NumberFormat(fr ? 'fr' : 'en', { style: 'currency', currency: 'EUR', minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 }).format(n);
const count = (n) => new Intl.NumberFormat(fr ? 'fr' : 'en').format(n);
const percent = (ratio) => `${count(Math.round(ratio * 100))}${fr ? ' %' : '%'}`;
const plural = (n, one, many) => `${count(n)} ${(fr ? n > 1 : n !== 1) ? many : one}`;
const perMonth = fr ? '/ mois' : '/ month';
// Jauge : animée au premier affichage, posée directement ensuite (curseurs du simulateur).
const gauge = (bar, ratio, animate) => {
  const set = () => (bar.style.width = `${Math.min(100, Math.round(ratio * 100))}%`);
  if (animate) requestAnimationFrame(set);
  else set();
};

if (cfg) {
  const stages = cfg.roadmap ?? [];
  let shown = '';
  /** Les chapitres et le prochain palier, aux montants du plan (affluence réelle, ou simulée). */
  const showPlan = (plan, animate = false) => {
    if (JSON.stringify(plan) === shown) return; // montants arrondis : inchangés la plupart du temps
    shown = JSON.stringify(plan);
    // Les étapes à frais d'avance (« total », « plan ») se mesurent au cumul réuni depuis le début, les
    // autres au mois. Le chapitre 1, c'est aujourd'hui.
    const raisedFor = (s) => (s.total || s.plan ? (cfg.raised_total ?? 0) : cfg.raised_month);
    const target = (s) => targetOf(s, plan);
    const gauged = (s) => target(s) && !s.once && !s.by_fr;
    const nextIndex = stages.findIndex((s, i) => i > 0 && gauged(s) && raisedFor(s) < target(s));
    const fill = (text) => (plan && text ? text.replace(/\{(month|costs|servers|switch)\}/g, (_, key) => (key === 'switch' ? count(plan.switchAt) : euros(Math.round(plan[key])))) : text);
    // Montants arrondis (« ≈ ») : investissement de départ, coût mensuel, un an d'avance.
    const cost = (stage) => {
      const about = stage.approx || stage.plan ? '≈ ' : '';
      return [
        stage.once && `${about}${euros(stage.once)} ${fr ? 'd’investissement' : 'investment'}`,
        stage.month && `${about}${euros(stage.month)} ${perMonth}`,
        (stage.total || stage.plan === 'year') && `${about}${euros(target(stage))} ${fr ? 'pour 12 mois de frais' : 'for 12 months of costs'}`,
        stage.plan === 'switch' && `${about}${euros(target(stage))} ${fr ? 'pour un an de serveurs à la demande' : 'for a year of on-demand servers'}`,
        said(stage, 'by'),
      ].filter(Boolean).join(' · ') || said(stage, 'when');
    };
    render(
      document.getElementById('roadmap'),
      stages.flatMap((stage, i) => {
        const followed = gauged(stage);
        const reached = i === 0 || (followed && raisedFor(stage) >= target(stage));
        const bar = h('span');
        if (followed) gauge(bar, raisedFor(stage) / target(stage), animate);
        return [
          said(stage, 'act') && h('li', { class: 'act' }, h('p', { class: 'eyebrow' }, said(stage, 'act'))),
          h(
            'li',
            { class: reached ? 'done' : i === nextIndex ? 'next' : 'later' },
            h('strong', {}, said(stage)),
            h('p', { class: 'small' }, fill(said(stage, 'detail'))),
            h('span', { class: 'badge' }, cost(stage), reached && i > 0 ? ` · ${t('road_reached')}` : ''),
            i > 0 && !reached && followed && h('div', { class: 'progress' }, bar),
          ),
        ];
      }),
    );

    // Le prochain palier du plan (ou le dernier, une fois tout atteint) : titre, jauge, explication.
    const challenge = stages[nextIndex] ?? [...stages].reverse().find(gauged);
    if (!challenge) return;
    const raised = raisedFor(challenge);
    const goal = target(challenge);
    const ahead = challenge.total || challenge.plan;
    document.getElementById('ch-title').textContent = said(challenge);
    document.getElementById('ch-detail').textContent = fill(said(challenge, 'detail'));
    document.getElementById('ch-raised').textContent = euros(raised);
    document.getElementById('ch-goal').textContent = ahead
      ? (fr ? `sur ${euros(goal)} pour ce palier` : `of ${euros(goal)} for this step`)
      : (fr ? `sur ${euros(goal)} par mois` : `of ${euros(goal)} a month`);
    document.getElementById('ch-note').textContent = [
      ahead
        ? (fr ? 'Soutiens et licences réunis depuis le début.' : 'Support and licences raised since the start.')
        : (fr ? 'Soutiens et licences du mois.' : 'Support and licences this month.'),
      raised >= goal ? (fr ? 'Palier atteint : merci à tous !' : 'Step reached: thank you all!') : '',
      t('sup_updated', { date: cfg.updated }),
    ].filter(Boolean).join(' ');
    gauge(document.getElementById('ch-bar'), raised / goal, animate);
    document.getElementById('challenge').hidden = false;
  };

  const start = scenarioOf(usage);
  showPlan(cfg.capacity ? amounts(cfg, start) : null, true);

  const total = cfg.costs.reduce((sum, c) => sum + c.month, 0);
  render(
    document.getElementById('costs'),
    cfg.costs.map((c) => h('tr', {}, h('td', {}, c[LANG] ?? c.en ?? c.fr), h('td', {}, `${euros(c.month)} ${perMonth}`))),
    h('tr', {}, h('td', {}, h('strong', {}, t('sup_total'))), h('td', {}, `${euros(total)} ${perMonth}`)),
  );
  document.getElementById('updated').textContent = t('sup_updated', { date: cfg.updated });
  if (cfg.capacity) health(cfg.capacity, start, (scenario) => showPlan(amounts(cfg, scenario)));
  if (cfg.ai) frugal(cfg, costs);
  document.getElementById('tax-fr').textContent = cfg.tax_deductible
    ? 'Oui : WeCall.You est porté par une association, un reçu fiscal vous est envoyé.'
    : 'Non. Pour l’instant, les contributions sont encaissées par la micro-entreprise du fondateur et déclarées comme recettes : elles ne donnent pas droit à une réduction d’impôt. Quand l’association existera, elle pourra peut-être délivrer des reçus fiscaux.';
  document.getElementById('tax-en').textContent = cfg.tax_deductible
    ? 'Yes: WeCall.You is run by a non-profit, you receive a tax receipt.'
    : 'No. For now, contributions are received by the founder’s sole-trader business and declared as income: they give no tax reduction. Once the association exists, it may be able to issue tax receipts.';
}

/**
 * Le service tient-il la route ? Le bulletin du mois (chiffres anonymes du serveur) et le simulateur,
 * qui part de l'affluence réelle et fait bouger les montants du plan (onScenario).
 */
function health(cap, start, onScenario) {
  const m = model(cap);
  const e = cap.elastic;
  const checked = new Date(`${e.checked}-01T12:00:00`).toLocaleDateString(fr ? 'fr' : 'en', { month: 'long', year: 'numeric' });

  document.getElementById('h-capacity').textContent = fr
    ? `La lune actuelle (${euros(cap.month)} par mois) tient environ ${count(m.comfortable)} clients en attente en même temps avant de donner la priorité aux soutiens ; la bascule vers les serveurs à la demande est prévue vers ${count(m.switchAt)}. ${count(cap.waiting)} clients ont été mesurés sans faiblir ${cap.measured_fr}.`
    : `The current server (${euros(cap.month)} a month) holds about ${count(m.comfortable)} customers waiting at the same time before giving supporters priority; the move to on-demand servers is planned at around ${count(m.switchAt)}. ${count(cap.waiting)} customers were measured without a hitch ${cap.measured_en}.`;

  // Le bulletin du mois, rédigé à partir des chiffres du serveur.
  if (usage) {
    const minutes = (n) => (n < 1 ? (fr ? 'moins d’une minute' : 'under a minute') : plural(n, 'minute', 'minutes'));
    const wait = usage.wait === null ? '' : fr ? ` (attente moyenne : ${minutes(usage.wait)})` : ` (average wait: ${minutes(usage.wait)})`;
    const crowd = usage.pages
      ? fr ? ` ; au plus fort, ${plural(usage.pages, 'client attendait', 'clients attendaient')} page ouverte, dans ${plural(usage.pagesQueues, 'file', 'files')}` : `; at the busiest, ${plural(usage.pages, 'customer was', 'customers were')} waiting with the page open, in ${plural(usage.pagesQueues, 'queue', 'queues')}`
      : '';
    const welcomed = fr
      ? `Ce mois-ci, ${plural(usage.queues, 'file a', 'files ont')} accueilli ${plural(usage.tickets, 'client', 'clients')}${wait}${crowd}.`
      : `This month, ${plural(usage.queues, 'queue', 'queues')} welcomed ${plural(usage.tickets, 'customer', 'customers')}${wait}${crowd}.`;
    const host = usage.host;
    const limits = usage.limits
      ? fr ? `a touché ses limites pendant ${plural(usage.limits, 'minute', 'minutes')}` : `reached its limits for ${plural(usage.limits, 'minute', 'minutes')}`
      : fr ? 'n’a jamais touché ses limites' : 'never reached its limits';
    const busiest = host
      ? fr
        ? `La lune ${host.peak < 0.75 ? 'n’a utilisé au plus que' : 'a utilisé jusqu’à'} ${percent(host.peak)} de ses capacités (${percent(host.average)} en moyenne), `
        : `The server used ${host.peak < 0.75 ? 'at most only' : 'up to'} ${percent(host.peak)} of its capacity (${percent(host.average)} on average), `
      : fr ? 'La lune ' : 'The server ';
    const server = fr
      ? `${busiest}a fait passer ${plural(usage.priority, 'demande', 'demandes')} en priorité et ${limits}.`
      : `${busiest}gave priority to ${plural(usage.priority, 'request', 'requests')} and ${limits}.`;
    const now = usage.load ? (fr ? ` En ce moment : ${percent(usage.load.ratio)}.` : ` Right now: ${percent(usage.load.ratio)}.`) : '';
    const text = document.getElementById('h-month');
    text.textContent = `${welcomed} ${server}${now}`;
    text.hidden = false;
    // Verdict : limites touchées (le projet a besoin de vous), bascule à préparer, ou tout va bien.
    const peak = host?.peak ?? 0;
    const state = usage.limits > 0 || peak >= 0.75 ? 'warn' : peak >= cap.switch ? 'soon' : 'ok';
    const verdict = document.getElementById('h-verdict');
    const support = h('a', { href: '#card' }, fr ? 'Je soutiens' : 'I support');
    render(
      verdict,
      {
        warn: [fr ? 'La lune a touché ses limites ce mois-ci : le projet a besoin de vous. ' : 'The server reached its limits this month: the project needs you. ', support],
        soon: [fr ? 'La lune approche de sa limite : la bascule vers les serveurs à la demande se prépare. ' : 'The server is nearing its limit: the move to on-demand servers is being prepared. ', support],
        ok: fr ? 'Pour le moment, le projet tient la route.' : 'For now, the project is holding up.',
      }[state],
    );
    verdict.className = `health-verdict ${state}`;
    verdict.hidden = false;
  }

  // Le simulateur : files ouvertes, clients par file, heures d'affluence, en curseurs.
  const sliders = { queues: 'sim-queues', perQueue: 'sim-clients', hours: 'sim-hours' };
  const input = (key) => document.getElementById(sliders[key]);
  const read = () => Object.fromEntries(Object.keys(sliders).map((key) => [key, Number(input(key).value)]));
  const place = (scenario) => {
    for (const key of Object.keys(sliders)) input(key).value = String(Math.min(Number(input(key).max), scenario[key]));
  };
  const reset = h('button', { type: 'button', class: 'btn btn-ghost sim-reset', hidden: true }, fr ? 'Revenir à l’affluence réelle' : 'Back to real demand');
  render(
    document.getElementById('sim-start'),
    start.real
      ? fr
        ? `Point de départ : l’affluence réelle de ce mois, au plus fort (${plural(start.queues * start.perQueue, 'client', 'clients')} dans ${plural(start.queues, 'file', 'files')}, ${plural(start.hours, 'heure', 'heures')} d’affluence par jour). Bougez les curseurs : les montants du plan suivent. `
        : `Starting point: this month’s real demand at its busiest (${plural(start.queues * start.perQueue, 'customer', 'customers')} in ${plural(start.queues, 'queue', 'queues')}, ${plural(start.hours, 'busy hour', 'busy hours')} a day). Move the sliders: the plan’s amounts follow. `
      : fr
        ? 'Point de départ : un exemple, un tournoi avec trois buvettes de 50 clients, 4 heures par jour (pas encore d’affluence mesurée ce mois-ci). Bougez les curseurs : les montants du plan suivent. '
        : 'Starting point: an example, a tournament with three snack bars of 50 customers, 4 hours a day (no demand measured yet this month). Move the sliders: the plan’s amounts follow. ',
    reset,
  );
  const verdicts = {
    ok: fr ? `La lune suffit : ${euros(cap.month)} par mois, quelle que soit l’affluence.` : `The current server is enough: ${euros(cap.month)} a month, however busy it gets.`,
    soon: fr ? 'La lune approche de sa limite (au-delà de 75 %, les soutiens passent devant) : c’est le moment de basculer sur les serveurs à la demande.' : 'The current server is nearing its limit (beyond 75%, supporters go first): it’s time to move to on-demand servers.',
    over: fr ? 'Au-delà de la lune : les serveurs à la demande prennent le relais, payés selon l’affluence.' : 'Beyond the current server: on-demand servers take over, paid according to demand.',
  };
  const simulate = () => {
    const scenario = read();
    for (const key of Object.keys(sliders)) document.getElementById(`${sliders[key]}-out`).textContent = count(scenario[key]);
    const clients = scenario.queues * scenario.perQueue;
    const requests = Math.round(m.rps(clients, scenario.queues));
    const load = m.loadOf(clients, scenario.queues);
    const level = load < cap.switch ? 'ok' : load < 1 ? 'soon' : 'over';
    const scalable = m.elastic(clients, scenario.queues, scenario.hours);
    const several = scalable.instances > 1;
    const bar = h('span');
    render(
      document.getElementById('sim-result'),
      h(
        'p',
        { class: 'sim-total' },
        h('strong', {}, plural(clients, fr ? 'client' : 'customer', fr ? 'clients' : 'customers')),
        fr ? ` en attente en même temps · ≈ ${plural(requests, 'requête', 'requêtes')} par seconde` : ` waiting at the same time · ≈ ${plural(requests, 'request', 'requests')} per second`,
      ),
      h('p', { class: 'small' }, fr ? `Charge estimée de la lune : ${percent(load)} (le direct en occupe au plus ${percent(cap.live / cap.connections)}, une part fixe)` : `Estimated load on the current server: ${percent(load)} (live pages take at most ${percent(cap.live / cap.connections)}, a fixed share)`),
      h('div', { class: `progress sim-gauge ${level}` }, bar),
      h('p', { class: `sim-verdict ${level}` }, verdicts[level]),
      h(
        'table',
        { class: 'cost-table' },
        h('tr', { class: level === 'ok' ? 'chosen' : '' }, h('td', {}, fr ? 'La lune (o2switch)' : 'Current server (o2switch)'), h('td', {}, level === 'over' ? (fr ? 'dépassée' : 'exceeded') : `${euros(cap.month)} ${perMonth}, ${fr ? 'fixe' : 'flat'}`)),
        h(
          'tr',
          { class: level === 'ok' ? '' : 'chosen' },
          h('td', {}, `${fr ? 'Serveurs à la demande : ' : 'On-demand servers: '}${said(e)}`),
          h('td', {}, `≈ ${euros(scalable.month)} ${perMonth}`),
        ),
      ),
      h(
        'p',
        { class: 'small muted' },
        fr
          ? `Serveurs à la demande : ${plural(scalable.instances, 'instance', 'instances')} d’un processeur et la base partagée, pendant ${plural(scenario.hours, 'heure', 'heures')} par jour, payée${several ? 's' : ''} à la seconde, TVA comprise ; le reste du temps, tout s’éteint.`
          : `On-demand servers: ${plural(scalable.instances, 'single-processor instance', 'single-processor instances')} and the shared database, for ${plural(scenario.hours, 'hour', 'hours')} a day, paid by the second, VAT included; the rest of the time, everything switches off.`,
      ),
    );
    gauge(bar, Math.min(1, load), false);
    reset.hidden = !start.real || Object.keys(sliders).every((key) => scenario[key] === Math.min(Number(input(key).max), start[key]));
    onScenario(scenario);
  };
  for (const key of Object.keys(sliders)) input(key).addEventListener('input', simulate);
  reset.addEventListener('click', () => {
    place(start);
    simulate();
  });
  place(start);
  simulate();
  document.getElementById('sim-note').textContent = fr
    ? `Estimation prudente, d’après le test de charge ${cap.measured_fr} : ${count(cap.waiting)} clients en attente dans ${count(cap.queues)} files, ${percent(cap.load)} de charge. Une page de client ouverte vérifie son ticket toutes les 5 s et sa place toutes les 30 s ; téléphone verrouillé, elle ne demande presque rien. Serveurs à la demande : tarifs publics de Scaleway relevés en ${checked}, hors taxes plus ${percent(cap.vat)} de TVA (conteneurs : ${euros(e.vcpu_100k)} les 100 000 secondes de processeur, ${euros(e.gb_100k)} les 100 000 Go-secondes de mémoire, ${count(e.free_vcpu_s)} s et ${count(e.free_gb_s)} Go-s offerts chaque mois ; base partagée : ${euros(e.db_vcpu_hour)} par heure et par processeur quand elle sert, ${euros(e.db_gb_month)} par Go et par mois). Les paliers réunissent ${plural(cap.months, 'mois', 'mois')} d’avance.`
    : `Cautious estimate, based on the load test ${cap.measured_en}: ${count(cap.waiting)} customers waiting in ${count(cap.queues)} queues, ${percent(cap.load)} load. An open customer page checks its ticket every 5 s and its place every 30 s; with the phone locked, it asks almost nothing. On-demand servers: Scaleway public prices checked in ${checked}, before tax plus ${percent(cap.vat)} VAT (containers: ${euros(e.vcpu_100k)} per 100,000 processor seconds, ${euros(e.gb_100k)} per 100,000 GB-seconds of memory, ${count(e.free_vcpu_s)} s and ${count(e.free_gb_s)} GB-s free each month; shared database: ${euros(e.db_vcpu_hour)} per hour and processor while in use, ${euros(e.db_gb_month)} per GB a month). The steps raise ${plural(cap.months, 'month', 'months')} ahead.`;
  document.getElementById('health').hidden = false;
}

/**
 * Fait avec presque rien : ce que le projet a coûté, mesuré à la fin de chaque session de travail
 * (couts.json) : le temps du fondateur, l'IA (part de l'abonnement, et tarif de l'API pour comparer),
 * l'hébergement, les noms de domaine, et le coût réel des dernières évolutions.
 */
function frugal(cfg, costs) {
  const calib = calibrate(costs);
  if (!calib) return;
  const ai = cfg.ai;
  const yearly = (id) => (cfg.costs.find((c) => c.id === id)?.month ?? 0) * 12;
  const minutes = Math.round((costs.hours % 1) * 60);
  const time = fr ? `${Math.floor(costs.hours)} h ${String(minutes).padStart(2, '0')}` : `${Math.floor(costs.hours)} hr ${minutes} min`;
  const tokens = Object.values(costs.tokens).reduce((sum, n) => sum + n, 0);
  const evolutions = costs.evolutions.filter((e) => e.usd > 0);
  const cheapest = evolutions.reduce((a, b) => (b.usd < a.usd ? b : a));
  const dearest = evolutions.reduce((a, b) => (b.usd > a.usd ? b : a));
  const checked = new Date(`${ai.checked}-01T12:00:00`).toLocaleDateString(fr ? 'fr' : 'en', { month: 'long', year: 'numeric' });
  const perYear = fr ? 'par an' : 'a year';
  // Deux montants à ne pas confondre : ce qui a été réellement payé (la part du projet dans un abonnement
  // à prix fixe) et la valeur du travail de l'IA (les mêmes jetons payés un par un, au tarif de l'API).
  const daily = (ai.subscription_month * 12) / 365;
  const paid = (usd) => cents(usd * calib.eurPerUsd);
  const tenths = (ratio) => `${new Intl.NumberFormat(fr ? 'fr' : 'en', { maximumFractionDigits: 1 }).format(ratio * 100)}${fr ? ' %' : '%'}`;

  document.getElementById('f-summary').textContent = fr
    ? `En ${plural(costs.days, 'jour', 'jours')}, ${plural(evolutions.length, 'évolution', 'évolutions')} et ${count(costs.lines)} lignes de code : ${time} du fondateur et ${cents(costs.subscription)} d’intelligence artificielle réellement payés. Le seul vrai besoin, ce sont les serveurs.`
    : `In ${plural(costs.days, 'day', 'days')}, ${plural(evolutions.length, 'change', 'changes')} and ${count(costs.lines)} lines of code: ${time} of the founder’s time and ${cents(costs.subscription)} of artificial intelligence actually paid. The only real need is servers.`;
  const row = (label, value) => h('tr', {}, h('td', {}, label), h('td', {}, value));
  render(
    document.getElementById('f-table'),
    row(fr ? `Temps du fondateur (bénévole, ${plural(costs.messages, 'message', 'messages')})` : `The founder’s time (volunteer, ${plural(costs.messages, 'message', 'messages')})`, time),
    row(fr ? `IA réellement payée (part de l’${said(ai)})` : `AI actually paid (share of the ${said(ai)})`, cents(costs.subscription)),
    row(fr ? `Valeur du travail de l’IA : ${millions(tokens)} de jetons au tarif de l’API` : `Value of the AI’s work: ${millions(tokens)} tokens at API prices`, dollars(costs.usd)),
    row(fr ? 'Hébergement (o2switch)' : 'Hosting (o2switch)', `${euros(yearly('hosting'))} ${perYear}`),
    row(fr ? 'Noms de domaine' : 'Domain names', `${euros(yearly('domains'))} ${perYear}`),
  );
  const share = costs.subscription / (costs.days * daily);
  document.getElementById('f-why').textContent = fr
    ? `Pourquoi ${cents(costs.subscription)} et pas ${dollars(costs.usd)} ? L’abonnement coûte ${euros(ai.subscription_month)} par mois quoi qu’il arrive, soit ${cents(daily)} par jour. Sur ces ${plural(costs.days, 'jour', 'jours')} (${cents(costs.days * daily)}), WeCall.You en a utilisé ${percent(share)}, les autres projets du fondateur le reste : ${cents(costs.subscription)}, soit ${tenths(costs.subscription / ai.subscription_month)} d’un mois d’abonnement. Ses quotas (par 5 heures et par semaine) se rechargent tout seuls : tant qu’ils ne sont pas atteints, un jeton de plus ne coûte rien de plus. Les montants en dollars sont ce qu’auraient coûté les mêmes jetons payés un par un : la valeur du travail de l’IA, pas ce qui a été payé.`
    : `Why ${cents(costs.subscription)} and not ${dollars(costs.usd)}? The subscription costs ${euros(ai.subscription_month)} a month whatever happens, that is ${cents(daily)} a day. Over these ${plural(costs.days, 'day', 'days')} (${cents(costs.days * daily)}), WeCall.You used ${percent(share)} of it, the founder’s other projects the rest: ${cents(costs.subscription)}, that is ${tenths(costs.subscription / ai.subscription_month)} of a month’s subscription. Its quotas (per 5 hours and per week) refill on their own: as long as they are not reached, one more token costs nothing more. The dollar amounts are what the same tokens would have cost paid one by one: the value of the AI’s work, not what was paid.`;
  document.getElementById('f-evolution').textContent = fr
    ? `Une évolution représente de ${dollars(cheapest.usd)} (un réglage) à ${dollars(dearest.usd)} (un module entier) de travail d’IA, ${dollars(calib.median)} en médiane ; payée par l’abonnement, elle revient à environ ${paid(calib.median)}, plus une quinzaine de minutes du fondateur. Quelques minutes de concertation suffisent, l’IA fait le travail : chaque évolution est chiffrée en jetons avant (page Voter) et après (ici).`
    : `A change represents from ${dollars(cheapest.usd)} (a tweak) to ${dollars(dearest.usd)} (a whole module) of AI work, ${dollars(calib.median)} in the median; paid through the subscription, it comes to about ${paid(calib.median)}, plus around a quarter of an hour of the founder’s time. A few minutes of discussion are enough, AI does the work: each change is costed in tokens before (Vote page) and after (here).`;
  render(
    document.getElementById('f-last'),
    evolutions.slice(-5).reverse().map((e) =>
      h(
        'li',
        {},
        h('strong', {}, e.title),
        h('span', { class: 'small muted' }, ` ${new Date(`${e.date}T12:00:00`).toLocaleDateString(fr ? 'fr' : 'en', { day: 'numeric', month: 'long' })} · ${millions(e.tokens)} ${fr ? 'de jetons' : 'tokens'} · ${fr ? `${dollars(e.usd)} de travail d’IA, ≈ ${paid(e.usd)} payés` : `${dollars(e.usd)} of AI work, ≈ ${paid(e.usd)} paid`}`),
      ),
    ),
  );
  const updated = new Date(costs.updated).toLocaleDateString(fr ? 'fr' : 'en', { day: 'numeric', month: 'long', year: 'numeric' });
  const price = Object.values(ai.prices)[0];
  document.getElementById('f-note').textContent = fr
    ? `Mesuré automatiquement à la fin de chaque session de travail, dans les journaux de l’assistant de code (Claude Code) : seulement des totaux, jamais les conversations. Temps : pauses de plus de 10 minutes exclues. Abonnement : chaque jour est partagé entre les projets du fondateur selon leur usage du jour. Tarif de l’API : ${ai.model}, relevé en ${checked} (par million de jetons : ${dollars(price.input)} en entrée, ${dollars(price.output)} en sortie, ${dollars(price.cacheWrite)} mis en cache, ${dollars(price.cacheRead)} relus). Mis à jour le ${updated}.`
    : `Measured automatically at the end of each work session, in the coding assistant’s logs (Claude Code): totals only, never the conversations. Time: breaks over 10 minutes excluded. Subscription: each day is shared between the founder’s projects according to that day’s use. API prices: ${ai.model}, checked in ${checked} (per million tokens: ${dollars(price.input)} input, ${dollars(price.output)} output, ${dollars(price.cacheWrite)} cached, ${dollars(price.cacheRead)} re-read). Updated ${updated}.`;
  document.getElementById('frugal').hidden = false;
}
