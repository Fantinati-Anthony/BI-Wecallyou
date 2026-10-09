// Page « Soutenir » : encart de dons + tableau transparent des frais (depuis /soutien.json).
import { h, t, LANG, render, translatePage } from './common.js';
import { supportCard, loadSupport } from './donate.js';

translatePage();

const cfg = await loadSupport();
document.getElementById('card').append(await supportCard({ context: 'support' }));

// Textes de soutien.json : en français ou en anglais (comme les blocs de la page), l'anglais sinon.
const said = (entry, key = '') => {
  const field = (lang) => entry[key ? `${key}_${lang}` : lang];
  return field(LANG) ?? field('en') ?? field('fr');
};
const euros = (n) => new Intl.NumberFormat(LANG === 'fr' ? 'fr' : 'en', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(n); // la langue des blocs affichés
const grow = (bar, ratio) => requestAnimationFrame(() => {
  bar.style.width = `${Math.min(100, Math.round(ratio * 100))}%`;
});

if (cfg) {
  // Chapitres : ceux qui ont un montant se débloquent quand les dons et le Pro du mois l'atteignent ;
  // les suivants (chiffres en direct, boutique, impression, tout gratuit) viendront ensuite.
  const stages = cfg.roadmap ?? [];
  const nextIndex = stages.findIndex((s) => s.month && cfg.raised_month < s.month);
  render(
    document.getElementById('roadmap'),
    stages.map((stage, i) => {
      const later = !stage.month;
      const reached = i === 0 || (!later && cfg.raised_month >= stage.month);
      const bar = h('span');
      if (!later) grow(bar, cfg.raised_month / stage.month);
      return h(
        'li',
        { class: reached ? 'done' : i === nextIndex ? 'next' : later ? 'later' : '' },
        h('strong', {}, said(stage)),
        h('p', { class: 'small' }, said(stage, 'detail')),
        h('span', { class: 'badge' }, later ? said(stage, 'when') : t('road_month', { amount: stage.month }), reached && i > 0 ? ` · ${t('road_reached')}` : ''),
        i > 0 && !reached && !later && h('div', { class: 'progress' }, bar),
      );
    }),
  );

  // Le défi du mois : la jauge du chapitre marqué « challenge » (ou du prochain palier).
  const challenge = stages.find((s) => s.challenge) ?? stages[nextIndex];
  if (challenge?.month) {
    const done = cfg.raised_month >= challenge.month;
    document.getElementById('ch-raised').textContent = euros(cfg.raised_month);
    document.getElementById('ch-goal').textContent = LANG === 'fr' ? `sur ${euros(challenge.month)} par mois` : `of ${euros(challenge.month)} a month`;
    document.getElementById('ch-note').textContent = [
      LANG === 'fr' ? 'Dons et abonnements Pro du mois.' : 'Donations and Pro subscriptions this month.',
      done ? (LANG === 'fr' ? 'Défi relevé : merci à tous !' : 'Challenge met: thank you all!') : '',
      t('sup_updated', { date: cfg.updated }),
    ].filter(Boolean).join(' ');
    grow(document.getElementById('ch-bar'), cfg.raised_month / challenge.month);
    document.getElementById('challenge').hidden = false;
  }

  const total = cfg.costs.reduce((sum, c) => sum + c.month, 0);
  render(
    document.getElementById('costs'),
    cfg.costs.map((c) => h('tr', {}, h('td', {}, c[LANG] ?? c.en ?? c.fr), h('td', {}, t('sup_per_month', { n: c.month })))),
    h('tr', {}, h('td', {}, h('strong', {}, t('sup_total'))), h('td', {}, t('sup_per_month', { n: total }))),
  );
  document.getElementById('updated').textContent = t('sup_updated', { date: cfg.updated });
  document.getElementById('tax-fr').textContent = cfg.tax_deductible
    ? 'Oui : WeCall.You est porté par une association, un reçu fiscal vous est envoyé.'
    : 'Non, pas pour l’instant : c’est une contribution volontaire, sans reçu fiscal. Si une association reprend le projet, cela changera.';
  document.getElementById('tax-en').textContent = cfg.tax_deductible
    ? 'Yes: WeCall.You is run by a non-profit, you receive a tax receipt.'
    : 'Not for now: it is a voluntary contribution, without a tax receipt. This will change if a non-profit takes over the project.';
}
