// Page « WeCallYou Pro » : l'offre (distincte du don), l'usage du compte, le prix conseillé et les liens
// de paiement. Les liens Pro portent l'identifiant du compte : Stripe le renvoie au serveur, qui
// active le Pro pour une durée proportionnelle au montant payé.
import { h, t, LANG, render, translatePage } from './common.js';
import { session, sync } from './account.js';
import { loadSupport } from './donate.js';

translatePage();

const app = document.getElementById('app');
const [cfg, synced] = await Promise.all([loadSupport(), session.get() ? sync() : null]);
const account = session.get();
const pro = cfg?.pro ?? { tiers: [], monthly: [], once: {} };

/** Lien Stripe avec l'identifiant du compte : c'est ce qui permet d'activer le Pro au bon endroit. */
const withAccount = (url) => (url && account ? `${url}${url.includes('?') ? '&' : '?'}client_reference_id=${account.id}` : '');

const options = h(
  'ul',
  { class: 'steps' },
  [t('pro_opt_brand'), t('pro_opt_ttl'), t('pro_opt_stats'), t('pro_opt_priority')].map((text) => h('li', {}, text)),
);

function payment(usage) {
  if (!account || !synced) {
    return h(
      'section',
      { class: 'card stack' },
      h('p', {}, t('pro_need_account')),
      h('a', { class: 'btn btn-big btn-block', href: '/compte#creer' }, t('acc_tab_signup')),
      h('a', { class: 'btn btn-ghost btn-block', href: '/compte' }, t('acc_tab_login')),
    );
  }
  const status = synced.pro
    ? h('p', { class: 'banner-ok' }, t('pro_status_on', { date: new Date(synced.premiumUntil).toLocaleDateString(LANG) }))
    : h('p', { class: 'notice' }, h('strong', {}, t('pro_status_off')), ` · ${account.ident}`);
  const suggested = usage?.suggested ?? 1;
  let lower = 0;
  const tiers = pro.tiers.map((tier) => {
    const link = withAccount(pro.monthly.find((m) => m.amount === tier.month)?.url);
    const range = tier.upTo === null ? `${t('pro_tier_more')} ${lower.toLocaleString()}` : t('pro_tier_upto', { n: tier.upTo.toLocaleString() });
    lower = tier.upTo ?? lower;
    const mine = tier.month === suggested;
    return h(
      'a',
      { class: `btn btn-block ${mine ? 'btn-gold btn-big' : 'btn-soft'}`, href: link || false, target: link ? '_blank' : false, rel: 'noopener', 'aria-disabled': link ? false : 'true' },
      `${t('pro_tier', { price: tier.month })} · ${range}`,
      mine ? ` · ${t('pro_tier_you')}` : '',
      link ? '' : ` (${t('pro_soon')})`,
    );
  });
  const onceLink = withAccount(pro.once?.url);
  return h(
    'section',
    { class: 'card stack' },
    status,
    usage && h('p', {}, t('pro_usage', { active: usage.active.toLocaleString() })),
    h('p', { class: 'lead' }, h('strong', {}, t('pro_suggested', { price: suggested }))),
    h('h3', {}, t('pro_monthly')),
    tiers,
    h('h3', {}, t('pro_once')),
    h(
      'a',
      { class: 'btn btn-ghost btn-block', href: onceLink || false, target: onceLink ? '_blank' : false, rel: 'noopener', 'aria-disabled': onceLink ? false : 'true' },
      onceLink ? t('pro_once') : t('pro_soon'),
    ),
    h('p', { class: 'small muted' }, t('pro_once_hint')),
    h('p', { class: 'small' }, t('pro_rule')),
    h('p', { class: 'small muted' }, t('pro_cancel'), ' ', t('pro_no_sla'), ' ', h('a', { href: '/mentions#cgv' }, t('pro_terms'))),
  );
}

render(
  app,
  h('h1', {}, `⭐ ${t('pro_title')}`),
  h('p', { class: 'lead' }, t('pro_intro')),
  h('section', { class: 'card' }, options),
  payment(synced?.usage),
  h('p', { class: 'small muted center' }, t('pro_selfhost')),
);
