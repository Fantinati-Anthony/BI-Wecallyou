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
  // La charge mesurée chez l'hébergeur, en direct, quand le serveur la connaît.
  api('/info').then((info) => {
    if (!info.ok || !info.load) return;
    const percent = Math.round(info.load.ratio * 100);
    document.getElementById('updated').textContent += fr ? ` Charge du serveur en ce moment : ${percent} %.` : ` Server load right now: ${percent}%.`;
  });
  document.getElementById('tax-fr').textContent = cfg.tax_deductible
    ? 'Oui : WeCall.You est porté par une association, un reçu fiscal vous est envoyé.'
    : 'Non. Pour l’instant, les contributions sont encaissées par la micro-entreprise du fondateur et déclarées comme recettes : elles ne donnent pas droit à une réduction d’impôt. Quand l’association existera, elle pourra peut-être délivrer des reçus fiscaux.';
  document.getElementById('tax-en').textContent = cfg.tax_deductible
    ? 'Yes: WeCall.You is run by a non-profit, you receive a tax receipt.'
    : 'No. For now, contributions are received by the founder’s sole-trader business and declared as income: they give no tax reduction. Once the association exists, it may be able to issue tax receipts.';
}
