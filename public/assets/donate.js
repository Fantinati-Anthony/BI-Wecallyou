// Encart de dons : sincère, chiffré, jamais bloquant.
// Les paiements passent par des liens Stripe (Payment Links) déclarés dans /soutien.json :
// notre serveur ne voit ni carte, ni montant, ni donateur.
// Le DON est sans contrepartie : ses liens ne portent jamais d'identifiant de compte et n'activent rien.
// Les options en plus relèvent de l'abonnement Pro (page /pro), une offre distincte.
import { h, t, api, local, icon } from './common.js';
import { session } from './account.js';

let configPromise = null;

export function loadSupport() {
  configPromise ??= fetch('/soutien.json', { cache: 'no-cache' })
    .then((r) => r.json())
    .catch(() => null);
  return configPromise;
}

const euros = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(2).replace('.', ','));
// Donateur : retour de Stripe sur ce téléphone, ou compte connecté au statut Pro.
const isDonor = () => local.get('wcy:donor', false) || (session.get()?.premiumUntil ?? 0) > Date.now();

/**
 * Encart de soutien.
 * context : 'create' (après la création des tickets), 'dashboard' (une ligne dépliable),
 * 'dashboard-open' (la même, dépliée), 'support' (page dédiée).
 */
export async function supportCard({ context, count = 0, brand = 'WeCall.You' }) {
  const [cfg, info] = await Promise.all([loadSupport(), api('/info')]);
  if (!cfg) return h('div');
  const stats = info.ok ? info.stats : null;
  const monthly = cfg.costs.reduce((sum, c) => sum + c.month, 0);
  const goal = cfg.goal_month ?? monthly;
  const card = h('section', { class: 'card donate', id: 'soutenir', 'aria-labelledby': 'don-title' });

  if (isDonor() && context !== 'support') {
    card.append(
      h('div', { class: 'donor-thanks' }, h('strong', {}, t('don_thanks', { brand }))),
      h('a', { href: '/soutenir', class: 'small' }, t('don_again')),
    );
    return card;
  }

  const intro = { create: t('don_create', { count }), dashboard: t('don_dashboard'), support: t('don_support', { brand }) }[context];

  // Dans l'espace commerçant, utilisé tous les jours : une seule ligne, dépliable.
  if (context === 'dashboard') {
    const open = h('button', { type: 'button', class: 'btn btn-gold' }, t('support_link'));
    card.classList.add('donate-mini');
    card.append(h('span', { class: 'donor-thanks' }, icon('hand-heart'), intro), open);
    open.addEventListener('click', async () => {
      const full = await supportCard({ context: 'dashboard-open', count, brand });
      card.replaceWith(full);
    });
    return card;
  }

  card.append(h('h3', { id: 'don-title' }, icon('hand-heart'), t('don_title')), h('p', { class: 'why' }, intro ?? t('don_dashboard')));

  if (stats && stats.tickets > 0) {
    const key = stats.lots === 1 ? 'don_stats_one' : 'don_stats';
    card.append(h('p', { class: 'small muted' }, t(key, { tickets: stats.tickets.toLocaleString(), lots: stats.lots.toLocaleString() })));
  }

  // Transparence : objectif du mois et montant déjà reçu (mis à jour à la main dans soutien.json).
  const bar = h('span');
  card.append(
    h('div', { class: 'progress', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': goal, 'aria-valuenow': cfg.raised_month }, bar),
    h('p', { class: 'small' }, t('don_goal', { raised: euros(cfg.raised_month), goal: euros(goal) })),
  );
  requestAnimationFrame(() => {
    bar.style.width = `${Math.min(100, Math.round((cfg.raised_month / goal) * 100))}%`;
  });

  // Choix : une fois / chaque mois, puis montant. Le texte d'impact se met à jour en direct.
  let mode = 'once';
  let choice = null;
  const chips = h('div', { class: 'chips', role: 'group' });
  const impact = h('p', { class: 'impact' });
  const fees = h('p', { class: 'small muted' });
  const cta = h('a', { class: 'btn btn-gold btn-block btn-big', target: '_blank', rel: 'noopener' });
  const toggle = h('div', { class: 'segmented', role: 'group' });

  const optionsFor = (m) => (m === 'once' ? cfg.once : cfg.monthly);

  function update() {
    const amount = choice?.amount ?? null;
    const net = amount ? amount - (amount * cfg.fee_percent) / 100 - cfg.fee_fixed : null;
    if (amount === null) {
      impact.textContent = t('don_impact_other');
      fees.textContent = '';
    } else if (mode === 'once') {
      impact.textContent = t('don_impact_once', { amount: euros(amount), days: Math.max(1, Math.round((net / monthly) * 30)) });
      fees.textContent = t('don_fees', { fee: euros(Math.round((amount - net) * 100) / 100) });
    } else {
      impact.textContent = t('don_impact_monthly', { amount: euros(amount), percent: Math.round((net / monthly) * 100) });
      fees.textContent = t('don_fees', { fee: euros(Math.round((amount - net) * 100) / 100) });
    }
    const label = amount === null ? t('don_cta_other') : t(mode === 'once' ? 'don_cta' : 'don_cta_monthly', { amount: euros(amount) });
    cta.textContent = choice?.url ? label : t('don_soon');
    if (choice?.url) cta.setAttribute('href', choice.url);
    else cta.removeAttribute('href');
    cta.classList.toggle('btn-soft', !choice?.url);
  }

  function drawChips() {
    const options = optionsFor(mode);
    choice = options.find((o) => o.preferred) ?? options[0];
    chips.replaceChildren(
      ...options.map((o) => {
        const chip = h('button', { type: 'button', class: 'chip', 'aria-pressed': String(o === choice) }, o.amount === null ? t('don_other') : `${euros(o.amount)} €`);
        chip.addEventListener('click', () => {
          choice = o;
          for (const c of chips.children) c.setAttribute('aria-pressed', String(c === chip));
          update();
        });
        return chip;
      }),
    );
    update();
  }

  for (const m of ['once', 'monthly']) {
    if (!optionsFor(m)?.length) continue;
    const btn = h('button', { type: 'button', 'aria-pressed': String(m === mode) }, t(m === 'once' ? 'don_once' : 'don_monthly'));
    btn.addEventListener('click', () => {
      mode = m;
      for (const b of toggle.children) b.setAttribute('aria-pressed', String(b === btn));
      drawChips();
    });
    toggle.append(btn);
  }

  card.append(
    toggle,
    chips,
    impact,
    cta,
    fees,
    h('p', { class: 'small muted' }, t('don_secure'), ' ', t(cfg.tax_deductible ? 'don_tax_yes' : 'don_tax_no')),
    h('p', { class: 'small' }, t('don_vs_pro'), ' ', h('a', { href: '/pro' }, t('pro_link'))),
  );

  if (context !== 'support') {
    const later = h('button', { type: 'button', class: 'linklike small' }, t('don_later'));
    later.addEventListener('click', () => {
      card.replaceChildren(h('a', { href: '/soutenir', class: 'small' }, t('support_link')));
      card.classList.remove('donate');
    });
    card.append(h('div', { class: 'row' }, later, h('a', { href: '/soutenir', class: 'small' }, t('don_more'))));
  }

  drawChips();
  return card;
}

/** Après l'impression : un rappel discret, une seule fois. */
export function nudgeAfterPrint(card) {
  window.addEventListener(
    'afterprint',
    () => {
      if (!card.isConnected || isDonor()) return;
      const note = h('p', { class: 'impact' }, t('don_after_print'));
      card.querySelector('.why')?.after(note);
      card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      card.classList.add('pulse');
    },
    { once: true },
  );
}
