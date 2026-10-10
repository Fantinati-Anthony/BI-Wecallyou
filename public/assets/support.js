// Page « Soutenir » : encart de dons + tableau transparent des frais (depuis /soutien.json).
import { h, t, LANG, api, render, translatePage } from './common.js';
import { supportCard, loadSupport } from './donate.js';

translatePage();

const cfg = await loadSupport();
document.getElementById('card').append(await supportCard({ context: 'support' }));

// Textes de soutien.json : en français ou en anglais (comme les blocs de la page), l'anglais sinon.
const said = (entry, key = '') => {
  const field = (lang) => entry[key ? `${key}_${lang}` : lang];
  return field(LANG) ?? field('en') ?? field('fr');
};
// Montants dans la langue des blocs affichés ; les centimes seulement quand il y en a (2,50 €).
const euros = (n) => new Intl.NumberFormat(LANG === 'fr' ? 'fr' : 'en', { style: 'currency', currency: 'EUR', minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 }).format(n);
const grow = (bar, ratio) => requestAnimationFrame(() => {
  bar.style.width = `${Math.min(100, Math.round(ratio * 100))}%`;
});

if (cfg) {
  // Chapitres : ceux qui ont un montant se débloquent quand les contributions et le Pro du mois l'atteignent ;
  // les autres (association, hébergeur mécène, autres outils) viendront quand les membres le décideront.
  const stages = cfg.roadmap ?? [];
  // Chapitres suivis par une jauge : un montant mensuel payé par les dons et le Pro (pas les ventes).
  // Les étapes « total » (frais d'avance) se mesurent au cumul réuni depuis le début, les autres au mois.
  const raisedFor = (s) => (s.total ? (cfg.raised_total ?? 0) : cfg.raised_month);
  const targetOf = (s) => s.total ?? s.month;
  const gauged = (s) => targetOf(s) && !s.once && !s.by_fr;
  const nextIndex = stages.findIndex((s, i) => i > 0 && gauged(s) && raisedFor(s) < targetOf(s)); // le chapitre 1, c'est aujourd'hui
  // Montants arrondis (« ≈ ») : investissement de départ et coût mensuel.
  const fr = LANG === 'fr';
  const cost = (stage) => {
    const about = stage.approx ? '≈ ' : '';
    return [
      stage.once && `${about}${euros(stage.once)} ${fr ? 'd’investissement' : 'investment'}`,
      stage.month && `${about}${euros(stage.month)} ${fr ? '/ mois' : '/ month'}`,
      stage.total && `${about}${euros(stage.total)} ${fr ? 'pour 12 mois de frais' : 'for 12 months of costs'}`,
      said(stage, 'by'),
    ].filter(Boolean).join(' · ') || said(stage, 'when');
  };
  render(
    document.getElementById('roadmap'),
    stages.flatMap((stage, i) => {
      const followed = gauged(stage);
      const reached = i === 0 || (followed && raisedFor(stage) >= targetOf(stage));
      const bar = h('span');
      if (followed) grow(bar, raisedFor(stage) / targetOf(stage));
      return [
        said(stage, 'act') && h('li', { class: 'act' }, h('p', { class: 'eyebrow' }, said(stage, 'act'))),
        h(
          'li',
          { class: reached ? 'done' : i === nextIndex ? 'next' : 'later' },
          h('strong', {}, said(stage)),
          h('p', { class: 'small' }, said(stage, 'detail')),
          h('span', { class: 'badge' }, cost(stage), reached && i > 0 ? ` · ${t('road_reached')}` : ''),
          i > 0 && !reached && followed && h('div', { class: 'progress' }, bar),
        ),
      ];
    }),
  );

  // Le prochain palier du plan (ou le dernier, une fois tout atteint) : titre, jauge, explication.
  const challenge = stages[nextIndex] ?? [...stages].reverse().find(gauged);
  if (challenge) {
    const raised = raisedFor(challenge);
    const target = targetOf(challenge);
    const done = raised >= target;
    document.getElementById('ch-title').textContent = said(challenge);
    document.getElementById('ch-detail').textContent = said(challenge, 'detail');
    document.getElementById('ch-raised').textContent = euros(raised);
    document.getElementById('ch-goal').textContent = challenge.total
      ? (fr ? `sur ${euros(target)} pour ce palier` : `of ${euros(target)} for this step`)
      : (fr ? `sur ${euros(target)} par mois` : `of ${euros(target)} a month`);
    document.getElementById('ch-note').textContent = [
      challenge.total
        ? (fr ? 'Soutiens et licences réunis depuis le début.' : 'Support and licences raised since the start.')
        : (fr ? 'Soutiens et licences du mois.' : 'Support and licences this month.'),
      done ? (fr ? 'Palier atteint : merci à tous !' : 'Step reached: thank you all!') : '',
      t('sup_updated', { date: cfg.updated }),
    ].filter(Boolean).join(' ');
    grow(document.getElementById('ch-bar'), raised / target);
    document.getElementById('challenge').hidden = false;
  }

  const total = cfg.costs.reduce((sum, c) => sum + c.month, 0);
  render(
    document.getElementById('costs'),
    cfg.costs.map((c) => h('tr', {}, h('td', {}, c[LANG] ?? c.en ?? c.fr), h('td', {}, `${euros(c.month)} ${LANG === 'fr' ? '/ mois' : '/ month'}`))),
    h('tr', {}, h('td', {}, h('strong', {}, t('sup_total'))), h('td', {}, `${euros(total)} ${LANG === 'fr' ? '/ mois' : '/ month'}`)),
  );
  document.getElementById('updated').textContent = t('sup_updated', { date: cfg.updated });
  if (cfg.capacity) health(cfg.capacity);
  document.getElementById('tax-fr').textContent = cfg.tax_deductible
    ? 'Oui : WeCall.You est porté par une association, un reçu fiscal vous est envoyé.'
    : 'Non. Pour l’instant, les contributions sont encaissées par la micro-entreprise du fondateur et déclarées comme recettes : elles ne donnent pas droit à une réduction d’impôt. Quand l’association existera, elle pourra peut-être délivrer des reçus fiscaux.';
  document.getElementById('tax-en').textContent = cfg.tax_deductible
    ? 'Yes: WeCall.You is run by a non-profit, you receive a tax receipt.'
    : 'No. For now, contributions are received by the founder’s sole-trader business and declared as income: they give no tax reduction. Once the association exists, it may be able to issue tax receipts.';
}


/**
 * Le service tient-il la route ? Le bulletin du mois (chiffres anonymes du serveur) et un simulateur
 * fondé sur le test de charge : le modèle, la mesure et les tarifs sont dans soutien.json.
 */
function health(cap) {
  const fr = LANG === 'fr';
  const count = (n) => new Intl.NumberFormat(fr ? 'fr' : 'en').format(n);
  const percent = (ratio) => `${count(Math.round(ratio * 100))}${fr ? ' %' : '%'}`;
  const plural = (n, one, many) => `${count(n)} ${(fr ? n > 1 : n !== 1) ? many : one}`;
  const perMonth = fr ? '/ mois' : '/ month';

  // Requêtes par seconde : une page de client ouverte vérifie son ticket toutes les 5 s et sa place
  // toutes les 30 s ; la page d'un commerçant se rafraîchit toutes les 10 s.
  const rps = (clients, queues) => clients * cap.client_rps + queues * cap.queue_rps;
  // Prudent : toute la charge mesurée est comptée comme du calcul, alors qu'elle venait surtout du direct.
  const fullRps = rps(cap.waiting, cap.queues) / cap.load;
  // Les pages en direct occupent au plus `live` des `connections` du serveur ; le reste, c'est le calcul.
  const loadOf = (clients, queues) => Math.max(Math.min(clients, cap.live) / cap.connections, rps(clients, queues) / fullRps);
  // Clients en attente à 75 % (au-delà, les soutiens passent devant), à la centaine près.
  const comfortable = Math.floor((0.75 * fullRps) / (cap.client_rps + (cap.queue_rps * cap.queues) / cap.waiting) / 100) * 100;
  // Serveur évolutif : des instances d'un processeur, chacune comme le serveur actuel, payées à la
  // seconde pendant les heures d'affluence (30 jours), moins la part offerte chaque mois.
  const elastic = cap.elastic;
  const liveShare = cap.live / cap.connections;
  const checked = new Date(`${elastic.checked}-01T12:00:00`).toLocaleDateString(fr ? 'fr' : 'en', { month: 'long', year: 'numeric' });
  const elasticCost = (clients, queues, hours) => {
    const instances = Math.max(1, Math.ceil(rps(clients, queues) / (0.75 * fullRps)));
    const seconds = instances * hours * 3600 * 30;
    const cpu = (Math.max(0, seconds - elastic.free_vcpu_s) * elastic.vcpu_100k) / 1e5;
    const memory = (Math.max(0, seconds * elastic.gb - elastic.free_gb_s) * elastic.gb_100k) / 1e5;
    return { instances, month: Math.round((cpu + memory) * 100) / 100 };
  };

  document.getElementById('h-capacity').textContent = fr
    ? `Le serveur actuel (${euros(cap.month)} par mois) tient environ ${count(comfortable)} clients en attente en même temps avant de donner la priorité aux soutiens ; ${count(cap.waiting)} ont été mesurés sans faiblir ${cap.measured_fr}.`
    : `The current server (${euros(cap.month)} a month) holds about ${count(comfortable)} customers waiting at the same time before giving supporters priority; ${count(cap.waiting)} were measured without a hitch ${cap.measured_en}.`;

  // Le bulletin du mois, rédigé à partir des chiffres du serveur.
  api('/health').then((month) => {
    if (!month.ok) return;
    const minutes = (n) => (n < 1 ? (fr ? 'moins d’une minute' : 'under a minute') : plural(n, 'minute', 'minutes'));
    const wait = month.wait === null ? '' : fr ? ` (attente moyenne : ${minutes(month.wait)})` : ` (average wait: ${minutes(month.wait)})`;
    const usage = fr
      ? `Ce mois-ci, ${plural(month.queues, 'file a', 'files ont')} accueilli ${plural(month.tickets, 'client', 'clients')}${wait}.`
      : `This month, ${plural(month.queues, 'queue', 'queues')} welcomed ${plural(month.tickets, 'customer', 'customers')}${wait}.`;
    const host = month.host;
    const limits = month.limits
      ? fr ? `a touché ses limites pendant ${plural(month.limits, 'minute', 'minutes')}` : `reached its limits for ${plural(month.limits, 'minute', 'minutes')}`
      : fr ? 'n’a jamais touché ses limites' : 'never reached its limits';
    const busiest = host
      ? fr
        ? `Au plus fort, le serveur ${host.peak < 0.75 ? 'n’a utilisé que' : 'a utilisé'} ${percent(host.peak)} de ses capacités (${percent(host.average)} en moyenne), `
        : `At its busiest, the server used ${host.peak < 0.75 ? 'only ' : ''}${percent(host.peak)} of its capacity (${percent(host.average)} on average), `
      : fr ? 'Le serveur ' : 'The server ';
    const server = fr
      ? `${busiest}a fait passer ${plural(month.priority, 'demande', 'demandes')} en priorité et ${limits}.`
      : `${busiest}gave priority to ${plural(month.priority, 'request', 'requests')} and ${limits}.`;
    const now = month.load ? (fr ? ` En ce moment : ${percent(month.load.ratio)}.` : ` Right now: ${percent(month.load.ratio)}.`) : '';
    const text = document.getElementById('h-month');
    text.textContent = `${usage} ${server}${now}`;
    text.hidden = false;
    const strained = month.limits > 0 || (host?.peak ?? 0) >= 0.75;
    const verdict = document.getElementById('h-verdict');
    render(
      verdict,
      strained
        ? [fr ? 'Le serveur a touché ses limites ce mois-ci : le projet a besoin de vous. ' : 'The server reached its limits this month: the project needs you. ', h('a', { href: '#card' }, fr ? 'Je soutiens' : 'I support')]
        : fr ? 'Pour le moment, le projet tient la route.' : 'For now, the project is holding up.',
    );
    verdict.classList.toggle('warn', strained);
    verdict.hidden = false;
  });

  // Le simulateur : files ouvertes, clients par file, heures d'affluence.
  const fields = ['sim-queues', 'sim-clients', 'sim-hours'].map((id) => document.getElementById(id));
  const valueOf = (input) => Math.min(Number(input.max), Math.max(Number(input.min), Math.round(Number(input.value)) || Number(input.min)));
  const verdicts = {
    ok: fr ? `Le serveur actuel suffit : ${euros(cap.month)} par mois, quelle que soit l’affluence.` : `The current server is enough: ${euros(cap.month)} a month, however busy it gets.`,
    tight: fr ? 'Le serveur actuel tient, en mode prioritaire : les files des soutiens passent devant. Le serveur évolutif prendrait le relais.' : 'The current server holds, in priority mode: supporters’ queues go first. The scalable server would take over.',
    over: fr ? 'Au-delà du serveur actuel : il faut le serveur évolutif, payé selon l’affluence.' : 'Beyond the current server: the scalable server is needed, paid according to demand.',
  };
  const simulate = () => {
    const [queues, perQueue, hours] = fields.map(valueOf);
    const clients = queues * perQueue;
    const requests = Math.round(rps(clients, queues));
    const load = loadOf(clients, queues);
    const level = load < 0.75 ? 'ok' : load < 1 ? 'tight' : 'over';
    const scalable = elasticCost(clients, queues, hours);
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
      h('p', { class: 'small' }, fr ? `Charge estimée du serveur actuel : ${percent(load)} (le direct en occupe au plus ${percent(liveShare)}, une part fixe)` : `Estimated load on the current server: ${percent(load)} (live pages take at most ${percent(liveShare)}, a fixed share)`),
      h('div', { class: `progress sim-gauge ${level}` }, bar),
      h('p', { class: `sim-verdict ${level}` }, verdicts[level]),
      h(
        'table',
        { class: 'cost-table' },
        h('tr', {}, h('td', {}, fr ? 'Serveur actuel (lune o2switch)' : 'Current server (o2switch)'), h('td', {}, `${euros(cap.month)} ${perMonth}, ${fr ? 'fixe' : 'flat'}`)),
        h(
          'tr',
          {},
          h('td', {}, `${fr ? 'Serveur évolutif : ' : 'Scalable server: '}${said(elastic)}`),
          h('td', {}, scalable.month ? `≈ ${euros(scalable.month)} ${perMonth}` : fr ? 'offert (part gratuite du mois)' : 'free (monthly free share)'),
        ),
      ),
      h(
        'p',
        { class: 'small muted' },
        fr
          ? `Serveur évolutif : ${plural(scalable.instances, 'instance', 'instances')} d’un processeur pendant ${plural(hours, 'heure', 'heures')} par jour, payée${several ? 's' : ''} à la seconde ; le reste du temps, ${several ? 'elles s’éteignent' : 'elle s’éteint'}.`
          : `Scalable server: ${plural(scalable.instances, 'single-processor instance', 'single-processor instances')} for ${plural(hours, 'hour', 'hours')} a day, paid by the second; the rest of the time, ${several ? 'they switch' : 'it switches'} off.`,
      ),
    );
    grow(bar, Math.min(1, load));
  };
  for (const input of fields) input.addEventListener('input', simulate);
  simulate();
  document.getElementById('sim-note').textContent = fr
    ? `Estimation prudente, d’après le test de charge ${cap.measured_fr} : ${count(cap.waiting)} clients en attente dans ${count(cap.queues)} files, ${percent(cap.load)} de charge. Une page de client ouverte vérifie son ticket toutes les 5 s et sa place toutes les 30 s ; téléphone verrouillé, elle ne demande presque rien. Serveur évolutif : tarifs publics de Scaleway relevés en ${checked} (${euros(elastic.vcpu_100k)} les 100 000 secondes de processeur, ${euros(elastic.gb_100k)} les 100 000 Go-secondes de mémoire, ${count(elastic.free_vcpu_s)} s et ${count(elastic.free_gb_s)} Go-s offerts chaque mois), hors stockage partagé, à choisir avec ce palier.`
    : `Cautious estimate, based on the load test ${cap.measured_en}: ${count(cap.waiting)} customers waiting in ${count(cap.queues)} queues, ${percent(cap.load)} load. An open customer page checks its ticket every 5 s and its place every 30 s; with the phone locked, it asks almost nothing. Scalable server: Scaleway public prices checked in ${checked} (${euros(elastic.vcpu_100k)} per 100,000 processor seconds, ${euros(elastic.gb_100k)} per 100,000 GB-seconds of memory, ${count(elastic.free_vcpu_s)} s and ${count(elastic.free_gb_s)} GB-s free each month), excluding shared storage, to be chosen with this step.`;
  document.getElementById('health').hidden = false;
}
