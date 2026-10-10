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

  // Transparence : l'objectif (12 mois de frais d'avance, sinon le mois) et ce qui est déjà réuni
  // (mis à jour à la main dans soutien.json).
  const yearly = cfg.goal_total != null;
  const target = yearly ? cfg.goal_total : goal;
  const raised = yearly ? (cfg.raised_total ?? 0) : cfg.raised_month;
  const bar = h('span');
  card.append(
    h('div', { class: 'progress', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': target, 'aria-valuenow': raised }, bar),
    h('p', { class: 'small' }, t(yearly ? 'don_goal_year' : 'don_goal', { raised: euros(raised), goal: euros(target) })),
  );
  requestAnimationFrame(() => {
    bar.style.width = `${Math.min(100, Math.round((raised / target) * 100))}%`;
  });

  // Choix : une fois / chaque mois, puis montant. Le texte d'impact se met à jour en direct.
  let mode = 'once';
  let choice = null;
  const chips = h('div', { class: 'chips', role: 'group' });
  const impact = h('p', { class: 'impact' });
  const fees = h('p', { class: 'small muted' });
  const cta = h('a', { class: 'btn btn-gold btn-block btn-big', target: '_blank', rel: 'noopener' });
  const toggle = h('div', { class: 'segmented', role: 'group' });

  const optionsFor = (m) => ({ once: cfg.once, monthly: cfg.monthly, yearly: cfg.yearly })[m];

  function update() {
    const amount = choice?.amount ?? null;
    const net = amount ? amount - (amount * cfg.fee_percent) / 100 - cfg.fee_fixed : null;
    if (amount === null) {
      impact.textContent = t('don_impact_other');
      fees.textContent = '';
    } else if (mode === 'once') {
      impact.textContent = t('don_impact_once', { amount: euros(amount), days: Math.max(1, Math.round((net / monthly) * 30)) });
      fees.textContent = t('don_fees', { fee: euros(Math.round((amount - net) * 100) / 100) });
    } else if (mode === 'yearly') {
      impact.textContent = t('don_impact_yearly', { amount: euros(amount), percent: Math.round((net / (monthly * 12)) * 100) });
      fees.textContent = t('don_fees', { fee: euros(Math.round((amount - net) * 100) / 100) });
    } else {
      impact.textContent = t('don_impact_monthly', { amount: euros(amount), percent: Math.round((net / monthly) * 100) });
      fees.textContent = t('don_fees', { fee: euros(Math.round((amount - net) * 100) / 100) });
    }
    const label = amount === null ? t('don_cta_other') : t({ once: 'don_cta', monthly: 'don_cta_monthly', yearly: 'don_cta_yearly' }[mode], { amount: euros(amount) });
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

  // Une fois (montant libre possible), chaque mois ou chaque année (montants fixes : un abonnement Stripe n'a pas de montant libre).
  for (const m of ['once', 'monthly', 'yearly']) {
    if (!optionsFor(m)?.length) continue;
    const btn = h('button', { type: 'button', 'aria-pressed': String(m === mode) }, t({ once: 'don_once', monthly: 'don_monthly', yearly: 'don_yearly' }[m]));
    btn.addEventListener('click', () => {
      mode = m;
      for (const b of toggle.children) b.setAttribute('aria-pressed', String(b === btn));
      drawChips();
    });
    toggle.append(btn);
  }

  // Deux offres : « Juste soutenir » (son bouton se fait prier), ou une licence Pro, le soutien moral en prime.
  const chooser = h('div', { class: 'stack offer-chooser', hidden: true }, toggle, chips, impact, cta, fees);
  card.append(
    h(
      'div',
      { class: 'support-offers' },
      h(
        'div',
        { class: 'offer offer-moral' },
        h('h4', {}, t('offer_moral_title')),
        h('p', { class: 'small' }, t('offer_moral_text')),
        runawayButton(() => {
          chooser.hidden = false;
          chips.querySelector('[aria-pressed="true"]')?.focus();
        }),
      ),
      licenceOffer(),
    ),
    chooser,
    h('p', { class: 'small muted' }, t('don_secure'), ' ', t(cfg.tax_deductible ? 'don_tax_yes' : 'don_tax_no')),
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

/**
 * « Juste soutenir » : le bouton esquive la souris trois fois, avec une petite phrase, puis se laisse
 * attraper. Au doigt, il saute une fois. Au clavier, ou si l'on réduit les animations, il ne fuit pas.
 */
function runawayButton(onAccept) {
  const quiet = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const lines = ['offer_flee_1', 'offer_flee_2', 'offer_flee_3'];
  let escapes = quiet ? lines.length : 0;
  const button = h('button', { type: 'button', class: 'btn btn-soft runaway', id: 'runaway-btn' }, t('offer_moral_btn'));
  const says = h('span', { class: 'runaway-says', 'aria-live': 'polite' });
  const zone = h('div', { class: 'runaway-zone' }, button);
  let resting = 0; // fin du saut en cours : on ne refuit pas pendant qu'il atterrit
  let skipClick = false;
  // Un saut ailleurs dans sa zone : parmi quelques places au hasard, la plus loin du pointeur.
  const jump = (pointerX, pointerY) => {
    const room = zone.getBoundingClientRect();
    const size = button.getBoundingClientRect();
    const spots = Array.from({ length: 8 }, () => ({ x: Math.random() * Math.max(0, room.width - size.width), y: Math.random() * Math.max(0, room.height - size.height) }));
    const far = (s) => Math.hypot(room.left + s.x + size.width / 2 - pointerX, room.top + s.y + size.height / 2 - pointerY);
    const spot = spots.reduce((a, b) => (far(b) > far(a) ? b : a));
    button.style.setProperty('--run-x', `${spot.x}px`);
    button.style.setProperty('--run-y', `${spot.y}px`);
    zone.classList.add('running');
    says.textContent = t(lines[escapes]);
    escapes++;
    resting = Date.now() + 400;
    if (escapes === lines.length) setTimeout(() => (says.textContent = t('offer_flee_done')), 1100);
  };
  // La souris approche (à moins de trois quarts de largeur de bouton) : il file.
  zone.addEventListener('pointermove', (event) => {
    if (event.pointerType !== 'mouse' || escapes >= lines.length || Date.now() < resting) return;
    const box = button.getBoundingClientRect();
    if (Math.hypot(event.clientX - (box.left + box.width / 2), event.clientY - (box.top + box.height / 2)) < box.width * 0.75) jump(event.clientX, event.clientY);
  });
  // Au doigt : il saute une fois, ce premier appui ne compte pas, puis il se rend.
  button.addEventListener('pointerdown', (event) => {
    if (event.pointerType === 'mouse' || escapes > 0) return;
    escapes = lines.length - 1;
    skipClick = true;
    jump(event.clientX, event.clientY);
  });
  button.addEventListener('click', (event) => {
    if (skipClick) {
      skipClick = false;
      return;
    }
    if (escapes < lines.length && event.detail > 0) return; // attrapé avant la fin du jeu : ça ne compte pas
    says.textContent = t('offer_flee_done');
    onAccept();
  });
  return h('div', { class: 'runaway-wrap' }, zone, says);
}

/** La licence : le vrai bouton, avec le ticket « C'est votre tour ! » qui surgit au survol. */
function licenceOffer() {
  return h(
    'div',
    { class: 'offer offer-licence' },
    h('h4', {}, t('offer_licence_title')),
    h('p', { class: 'small' }, t('offer_licence_text')),
    h(
      'div',
      { class: 'licence-wrap' },
      h('span', { class: 'licence-halo', 'aria-hidden': 'true' }),
      h(
        'a',
        { class: 'btn btn-big btn-block licence-btn', href: '/pro', id: 'licence-btn' },
        h('span', { class: 'licence-tag', 'aria-hidden': 'true' }, h('b', {}, '001'), t('offer_licence_tag')),
        h('span', { class: 'licence-bell' }, icon('bell-ringing')),
        t('offer_licence_btn'),
      ),
    ),
  );
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
