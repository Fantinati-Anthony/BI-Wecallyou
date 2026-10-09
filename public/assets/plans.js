// Comparatif Gratuit / Pro, affiché sur l'accueil et sur la page Pro. Chaque ligne correspond à
// une limite réelle du serveur (durées, statistiques, options) : le tableau ne promet rien de plus.
import { h, t, icon } from './common.js';

const YES = 'yes';
const NO = 'no';

/** [libellé, gratuit, Pro] : YES, NO, ou une clé de texte (ex. « jusqu'à 48 h »). */
const GROUPS = [
  [
    'cmp_g_tickets',
    [
      ['cmp_tickets', 'cmp_tickets_v', 'cmp_tickets_v'],
      ['cmp_channels', YES, YES],
      ['cmp_queue', YES, YES],
      ['cmp_messages', YES, YES],
      ['cmp_ttl', 'cmp_ttl_free', 'cmp_ttl_pro'],
    ],
  ],
  [
    'cmp_g_brand',
    [
      ['cmp_studio', YES, YES],
      ['cmp_whitelabel', NO, YES],
      ['cmp_colors', NO, YES],
      ['cmp_keypage', NO, YES],
    ],
  ],
  [
    'cmp_g_service',
    [
      ['cmp_privacy', YES, YES],
      ['cmp_stats', 'cmp_stats_free', 'cmp_stats_pro'],
      ['cmp_multilots', 'cmp_multilots_free', YES],
      ['cmp_priority', NO, YES],
    ],
  ],
];

function cell(value, pro) {
  const cls = `v${pro ? ' is-pro' : ''}`;
  if (value === YES) return h('td', { class: `${cls} yes` }, icon('check'), h('span', { class: 'sr' }, t('cmp_yes')));
  if (value === NO) return h('td', { class: `${cls} no` }, icon('minus'), h('span', { class: 'sr' }, t('cmp_no')));
  return h('td', { class: cls }, t(value));
}

/** Prix Pro le plus bas, d'après soutien.json (paliers mensuels). */
export async function minProPrice() {
  try {
    const res = await fetch('/soutien.json', { cache: 'no-cache' });
    const tiers = res.ok ? (await res.json()).pro?.tiers ?? [] : [];
    return Math.min(...tiers.map((tier) => tier.month)) || 1;
  } catch {
    return 1;
  }
}

/** Tableau comparatif. price : prix Pro le plus bas (€ / mois). */
export function comparison(price = 1) {
  const head = (name, amount, sub, pro) =>
    h('th', { scope: 'col', class: `plan${pro ? ' is-pro' : ''}` }, h('div', { class: 'plan-name' }, pro && icon('star'), t(name)), h('div', { class: 'plan-price' }, amount), h('div', { class: 'plan-sub' }, t(sub)));
  return h(
    'div',
    { class: 'compare-wrap' },
    h(
      'table',
      { class: 'compare' },
      h('caption', { class: 'sr' }, t('cmp_caption')),
      h('thead', {}, h('tr', {}, h('td', {}), head('plan_free', t('plan_free_price'), 'plan_free_sub', false), head('plan_pro', t('plan_pro_price', { price }), 'plan_pro_sub', true))),
      GROUPS.map(([group, rows]) =>
        h(
          'tbody',
          {},
          h('tr', { class: 'group' }, h('th', { scope: 'rowgroup', colspan: 2 }, t(group)), h('td', { class: 'is-pro' })),
          rows.map(([label, free, pro]) => h('tr', {}, h('th', { scope: 'row' }, t(label)), cell(free, false), cell(pro, true))),
        ),
      ),
    ),
  );
}
