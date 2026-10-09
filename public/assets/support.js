// Page « Soutenir » : encart de dons + tableau transparent des frais (depuis /soutien.json).
import { h, t, LANG, render, translatePage } from './common.js';
import { supportCard, loadSupport } from './donate.js';

translatePage();

const cfg = await loadSupport();
document.getElementById('card').append(await supportCard({ context: 'support' }));

if (cfg) {
  // Feuille de route : chaque palier se débloque quand les dons mensuels atteignent son coût.
  const stages = cfg.roadmap ?? [];
  const nextIndex = stages.findIndex((s) => cfg.raised_month < s.month);
  render(
    document.getElementById('roadmap'),
    stages.map((stage, i) => {
      const reached = i === 0 || cfg.raised_month >= stage.month;
      const bar = h('span');
      requestAnimationFrame(() => {
        bar.style.width = `${Math.min(100, Math.round((cfg.raised_month / stage.month) * 100))}%`;
      });
      return h(
        'li',
        { class: reached ? 'done' : i === nextIndex ? 'next' : '' },
        h('strong', {}, stage[LANG] ?? stage.fr),
        h('p', { class: 'small' }, stage[`detail_${LANG}`] ?? stage.detail_fr),
        h('span', { class: 'badge' }, t('road_month', { amount: stage.month }), reached && i > 0 ? ` · ${t('road_reached')}` : ''),
        i > 0 && !reached && h('div', { class: 'progress' }, bar),
      );
    }),
  );

  const total = cfg.costs.reduce((sum, c) => sum + c.month, 0);
  render(
    document.getElementById('costs'),
    cfg.costs.map((c) => h('tr', {}, h('td', {}, c[LANG] ?? c.fr), h('td', {}, `${c.month} € / ${LANG === 'fr' ? 'mois' : 'month'}`))),
    h('tr', {}, h('td', {}, h('strong', {}, 'Total')), h('td', {}, `${total} € / ${LANG === 'fr' ? 'mois' : 'month'}`)),
  );
  document.getElementById('updated').textContent = LANG === 'fr' ? `Chiffres mis à jour : ${cfg.updated}.` : `Figures updated: ${cfg.updated}.`;
  document.getElementById('tax-fr').textContent = cfg.tax_deductible
    ? 'Oui : WeCallYou est porté par une association, un reçu fiscal vous est envoyé.'
    : 'Non, pas pour l’instant : c’est une contribution volontaire, sans reçu fiscal. Si une association reprend le projet, cela changera.';
  document.getElementById('tax-en').textContent = cfg.tax_deductible
    ? 'Yes: WeCallYou is run by a non-profit, you receive a tax receipt.'
    : 'Not for now: it is a voluntary contribution, without a tax receipt. This will change if a non-profit takes over the project.';
}
