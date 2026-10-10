// « Faisons les comptes » (page Soutenir) : un atelier d'impression simulé, avec les vrais chiffres
// du mois (dons et Pro, coût du serveur) et des hypothèses réalistes qu'on fait varier au curseur.
// Rien n'est envoyé : tout se calcule dans la page.
import { h, LANG, render, icon } from './common.js';
import { compute } from './workshop.js';

const FR = LANG === 'fr';
const say = (fr, en) => (FR ? fr : en);
const locale = FR ? 'fr' : 'en'; // la langue des blocs affichés (français, ou anglais pour les autres)
const euros = (n, digits = 0) => new Intl.NumberFormat(locale, { style: 'currency', currency: 'EUR', minimumFractionDigits: digits, maximumFractionDigits: digits }).format(n);
const count = (n) => new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(n);
const percent = (ratio) => `${count(Math.round(ratio * 100))} %`;
const cents = (n) => euros(n, n % 1 ? 2 : 0);

/** Les curseurs : la clé dans soutien.json (« sim »), les bornes et le libellé. money : affiché en euros. */
const PARAMS = {
  main: [
    { key: 'donations', min: 0, max: 3000, step: 10, money: true, fr: 'Dons et abonnements Pro par mois', en: 'Donations and Pro subscriptions per month' },
    { key: 'server', min: 10, max: 600, step: 1, money: true, fr: 'Coût du serveur par mois', en: 'Server cost per month' },
    { key: 'orders', min: 0, max: 800, step: 5, fr: 'Commandes d’impression par mois', en: 'Print orders per month' },
    { key: 'price', min: 8, max: 40, step: 1, money: true, fr: 'Prix moyen d’une commande, hors port', en: 'Average order price, excluding shipping' },
  ],
  shop: [
    { key: 'sheetsA4', min: 0, max: 50, step: 1, fr: 'Feuilles A4 de tickets par commande', en: 'A4 ticket sheets per order' },
    { key: 'postersA3', min: 0, max: 10, step: 1, fr: 'Affiches A3 par commande', en: 'A3 posters per order' },
    { key: 'rollTickets', min: 0, max: 1000, step: 50, fr: 'Tickets en rouleau par commande', en: 'Roll tickets per order' },
    { key: 'speedA4', min: 60, max: 900, step: 10, fr: 'Imprimante A4 : feuilles par heure', en: 'A4 printer: sheets per hour' },
    { key: 'speedA3', min: 30, max: 600, step: 10, fr: 'Imprimante A3 : affiches par heure', en: 'A3 printer: posters per hour' },
    { key: 'speedRoll', min: 300, max: 6000, step: 100, fr: 'Imprimante thermique : tickets par heure', en: 'Thermal printer: tickets per hour' },
    { key: 'minutesOrder', min: 3, max: 40, step: 1, fr: 'Minutes par commande : contrôle, découpe, emballage, étiquette', en: 'Minutes per order: check, cut, pack, label' },
    { key: 'minutesDay', min: 0, max: 180, step: 5, fr: 'Minutes communes par jour : démarrage, entretien, dépôt à la poste', en: 'Shared minutes per day: start-up, upkeep, post office run' },
    { key: 'days', min: 10, max: 26, step: 1, fr: 'Jours travaillés par mois', en: 'Working days per month' },
    { key: 'hours', min: 20, max: 160, step: 1, fr: 'Heures de travail par mois (76 h : un mi-temps)', en: 'Working hours per month (76 h: part-time)' },
  ],
  costs: [
    { key: 'wage', min: 0, max: 4000, step: 50, money: true, fr: 'Coût de l’emploi par mois, charges comprises', en: 'Job cost per month, including charges' },
    { key: 'company', min: 0, max: 600, step: 10, money: true, fr: 'Structure par mois : comptable, banque, assurance', en: 'Company per month: accountant, bank, insurance' },
    { key: 'dev', min: 0, max: 3000, step: 50, money: true, fr: 'Développement payé par mois', en: 'Paid development per month' },
    { key: 'costA4', min: 0, max: 1, step: 0.01, money: true, fr: 'Papier et encre par feuille A4', en: 'Paper and ink per A4 sheet' },
    { key: 'costA3', min: 0, max: 2, step: 0.05, money: true, fr: 'Papier et encre par affiche A3', en: 'Paper and ink per A3 poster' },
    { key: 'costRoll', min: 0, max: 0.1, step: 0.005, money: true, fr: 'Rouleau thermique par ticket', en: 'Thermal roll per ticket' },
    { key: 'packaging', min: 0, max: 3, step: 0.1, money: true, fr: 'Emballage par commande', en: 'Packaging per order' },
    { key: 'invest', min: 0, max: 15000, step: 100, money: true, fr: 'Investissement de départ : structure, stock, imprimantes', en: 'Start-up investment: company, stock, printers' },
  ],
};
const LIMITS = {
  staff: say('le temps de travail', 'working time'),
  a4: say('l’imprimante A4', 'the A4 printer'),
  a3: say('l’imprimante A3', 'the A3 printer'),
  roll: say('l’imprimante thermique', 'the thermal printer'),
};

const bar = (ratio, tone = '') => {
  const fill = h('span', { class: tone });
  fill.style.width = `${Math.max(0, Math.min(100, ratio * 100))}%`;
  return h('div', { class: 'progress' }, fill);
};
const line = (label, value, tone = '') => h('tr', { class: tone }, h('td', {}, label), h('td', {}, value));

/** Le simulateur : curseurs à gauche du calcul, résultats qui suivent à chaque mouvement. */
export function simulator(cfg) {
  const real = {
    donations: cfg.raised_month ?? 0,
    // Coût réel du serveur : les lignes « server » du tableau des frais (plus tard, l'API de Scaleway).
    server: cfg.live?.server_month ?? cfg.costs.filter((c) => c.server).reduce((sum, c) => sum + c.month, 0),
  };
  const start = { ...cfg.sim, ...real };
  const values = { ...start };
  const fees = { percent: cfg.fee_percent ?? 1.5, fixed: cfg.fee_fixed ?? 0.25 };
  const out = h('div', { class: 'sim-out', 'aria-live': 'polite' });
  const inputs = new Map();

  const control = (param) => {
    const input = h('input', { type: 'range', id: `sim-${param.key}`, min: param.min, max: param.max, step: param.step, value: values[param.key] });
    const shown = h('output', { for: `sim-${param.key}` });
    const show = () => {
      shown.textContent = param.money ? cents(values[param.key]) : count(values[param.key]);
    };
    input.addEventListener('input', () => {
      values[param.key] = Number(input.value);
      show();
      draw();
    });
    show();
    inputs.set(param.key, { input, show });
    return h('div', { class: 'sim-control' }, h('div', { class: 'sim-label' }, h('label', { for: `sim-${param.key}` }, say(param.fr, param.en)), shown), input);
  };
  const reset = h('button', { type: 'button', class: 'linklike small', id: 'sim-reset' }, say('Revenir aux vrais chiffres et aux hypothèses de départ', 'Back to the real numbers and starting assumptions'));
  reset.addEventListener('click', () => {
    Object.assign(values, start);
    for (const [key, { input, show }] of inputs) {
      input.value = values[key];
      show();
    }
    draw();
  });

  function draw() {
    const r = compute(values, fees);
    const isReal = values.donations === real.donations && values.server === real.server;
    const over = values.orders > r.capacity;
    const feasible = r.dream <= r.capacity;
    render(
      out,
      // 1. Ce mois-ci : les dons et le Pro face au serveur.
      h(
        'section',
        { class: 'sim-block' },
        h('h3', {}, say('Ce mois-ci', 'This month'), h('span', { class: `badge${isReal ? ' ok-badge' : ''}` }, isReal ? say('chiffres réels', 'real numbers') : say('simulé', 'simulated'))),
        h('p', {}, say(`Les dons et le Pro couvrent ${percent(r.coverServer)} du serveur.`, `Donations and Pro cover ${percent(r.coverServer)} of the server.`)),
        bar(r.coverServer, r.coverServer >= 1 ? 'good' : ''),
        h('p', { class: 'small muted' }, values.donations >= values.server
          ? say(`Reste ${euros(values.donations - values.server)} pour la suite de l’aventure.`, `${euros(values.donations - values.server)} left for the rest of the adventure.`)
          : say(`Il manque ${euros(values.server - values.donations)} : c’est le fondateur qui complète.`, `${euros(values.server - values.donations)} missing: the founder makes up the difference.`)),
      ),
      // 2. L'atelier : ce qu'il peut produire, et ce qui le limite.
      h(
        'section',
        { class: 'sim-block' },
        h('h3', {}, say('L’atelier', 'The workshop')),
        h('p', { class: 'sim-figure' }, h('strong', { id: 'sim-capacity' }, count(r.capacity)), ' ', say('commandes par mois au plus', 'orders a month at most')),
        h('p', { class: 'small muted' }, say(
          `≈ ${count(r.perDay)} par jour, expédiées sous 24 à 48 heures. Ce qui limite : ${LIMITS[r.bottleneck]}. Une commande demande ${count(r.staffMinutes)} min de travail et ${count(r.printMinutes)} min d’impression.`,
          `≈ ${count(r.perDay)} a day, shipped within 24 to 48 hours. What limits it: ${LIMITS[r.bottleneck]}. One order takes ${count(r.staffMinutes)} min of work and ${count(r.printMinutes)} min of printing.`,
        )),
        bar(r.load, over ? 'bad' : ''),
        h('p', { class: `small${over ? ' error' : ' muted'}` }, over
          ? say(`${count(values.orders)} commandes demanderaient ${count(r.workHours)} h de travail pour ${count(values.hours)} h prévues : il faut plus d’heures ou un second poste.`, `${count(values.orders)} orders would need ${count(r.workHours)} h of work for ${count(values.hours)} h planned: more hours or a second person are needed.`)
          : say(`${count(values.orders)} commandes : ${percent(r.load)} de la capacité, ${count(r.workHours)} h de travail sur ${count(values.hours)} h, ${count(r.printHours)} h d’impression.`, `${count(values.orders)} orders: ${percent(r.load)} of capacity, ${count(r.workHours)} h of work out of ${count(values.hours)} h, ${count(r.printHours)} h of printing.`)),
      ),
      // 3. Une commande : du prix à la marge.
      h(
        'section',
        { class: 'sim-block' },
        h('h3', {}, say('Une commande', 'One order')),
        h(
          'table',
          { class: 'cost-table' },
          line(say('Prix, hors port', 'Price, excluding shipping'), cents(values.price)),
          line(say('Papier, encre et emballage', 'Paper, ink and packaging'), `− ${cents(r.materials)}`),
          line(say('Frais de paiement', 'Payment fees'), `− ${cents(r.fee)}`),
          line(say('Marge', 'Margin'), cents(r.margin), 'total'),
        ),
      ),
      // 4. Le mois : ce qui rentre, ce qui sort.
      h(
        'section',
        { class: 'sim-block' },
        h('h3', {}, say('Le mois', 'The month')),
        h(
          'table',
          { class: 'cost-table' },
          line(say(`Marge des ventes (${count(values.orders)} commandes)`, `Sales margin (${count(values.orders)} orders)`), `+ ${euros(r.sales)}`),
          line(say('Dons et abonnements Pro', 'Donations and Pro subscriptions'), `+ ${euros(values.donations)}`),
          line(say('Emploi', 'Job'), `− ${euros(values.wage)}`),
          line(say('Structure', 'Company'), `− ${euros(values.company)}`),
          line(say('Développement', 'Development'), `− ${euros(values.dev)}`),
          line(say('Serveur', 'Server'), `− ${euros(values.server)}`),
          line(say('Résultat', 'Result'), `${r.result >= 0 ? '+ ' : '− '}${euros(Math.abs(r.result))}`, `total ${r.result >= 0 ? 'gain' : 'loss'}`),
        ),
      ),
      // 5. Le rêve : tout payer par les ventes, sans un seul don.
      h(
        'section',
        { class: `sim-block sim-dream${feasible ? ' yes' : ''}` },
        h('h3', {}, icon(feasible ? 'check-circle' : 'hourglass-medium'), ' ', say('Le rêve : tout gratuit', 'The dream: everything free')),
        h('p', {}, Number.isFinite(r.dream)
          ? say(
              `Sans aucun don, il faut ${count(r.dream)} commandes par mois pour tout payer : ${percent(r.dream / Math.max(1, r.capacity))} de la capacité de l’atelier. ${feasible ? 'Réalisable avec ces hypothèses.' : 'Il faudrait plus d’heures, une machine plus rapide ou un second poste.'}`,
              `Without a single donation, ${count(r.dream)} orders a month pay for everything: ${percent(r.dream / Math.max(1, r.capacity))} of the workshop’s capacity. ${feasible ? 'Doable with these assumptions.' : 'It would take more hours, a faster machine or a second person.'}`,
            )
          : say('Avec ce prix, une commande ne rapporte rien : impossible de tout payer par les ventes.', 'At this price, an order earns nothing: sales can’t pay for everything.')),
        h('p', { class: 'small muted' }, Number.isFinite(r.payback)
          ? say(`Les ${euros(values.invest)} d’investissement de départ sont remboursés en ${count(r.payback)} mois à ce rythme.`, `The ${euros(values.invest)} start-up investment is paid back in ${count(r.payback)} months at this pace.`)
          : say(`À ce rythme, les ${euros(values.invest)} d’investissement de départ ne se remboursent pas encore.`, `At this pace, the ${euros(values.invest)} start-up investment isn’t paid back yet.`)),
      ),
    );
  }

  draw();
  const group = (name, title) => h('details', { class: 'sim-more' }, h('summary', {}, title), h('div', { class: 'sim-controls' }, PARAMS[name].map(control)));
  return h(
    'div',
    { class: 'sim' },
    h('div', { class: 'sim-controls' }, PARAMS.main.map(control)),
    group('shop', say('Hypothèses de l’atelier : imprimantes, temps de travail', 'Workshop assumptions: printers, working time')),
    group('costs', say('Hypothèses de coûts : emploi, structure, matière', 'Cost assumptions: job, company, materials')),
    reset,
    out,
  );
}
