// Encart de dons : sincère, chiffré, jamais bloquant.
// Les paiements passent par des liens Stripe (Payment Links) déclarés dans /soutien.json :
// notre serveur ne voit ni carte, ni montant, ni donateur.
// Soutenir le projet donne aussi la licence Pro : si un compte est connecté, le lien porte son
// identifiant et le serveur ouvre le Pro pour la période payée ; seuls les tickets prioritaires suivent
// le montant (sans compte, c'est un soutien pur). L'objectif affiché est le prochain palier (plan.js).
import { h, t, api, local, icon } from './common.js';
import { session } from './account.js';
import { amounts, scenarioOf, targetOf, loadUsage } from './plan.js';
import { loadCosts } from './couts.js';

let configPromise = null;

/**
 * soutien.json, avec les frais mesurés : la ligne « measured » (l'IA) prend ce qu'elle a réellement
 * coûté sur les 30 derniers jours (couts.json). Frais du mois, paliers et encart suivent.
 */
export function loadSupport() {
  configPromise ??= Promise.all([fetch('/soutien.json', { cache: 'no-cache' }).then((r) => r.json()), loadCosts()])
    .then(([cfg, costs]) => {
      if (costs?.month != null) for (const line of cfg.costs) if (line.measured) line.month = costs.month;
      return cfg;
    })
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
  // Le prochain palier du plan, aux montants calculés d'après l'affluence réelle (plan.js).
  const plan = cfg.capacity ? amounts(cfg, scenarioOf(await loadUsage())) : null;
  const next = (cfg.roadmap ?? []).find((s) => (s.total || s.plan) && targetOf(s, plan) > (cfg.raised_total ?? 0));
  const target = yearly ? (next ? targetOf(next, plan) : cfg.goal_total) : goal;
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
    if (choice?.url) cta.setAttribute('href', withAccount(choice.url));
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

  // Deux offres qui mènent au même endroit. À gauche, « Juste l'outil ? » : son bouton licence fuit
  // toujours et renvoie vers la droite. À droite, le vrai bouton : soutenir le projet, la licence en prime.
  const account = session.get();
  const chooser = h(
    'div',
    { class: 'stack offer-chooser', id: 'offer-chooser', hidden: true },
    toggle,
    chips,
    impact,
    cta,
    fees,
    account?.id
      ? h('p', { class: 'small ok' }, icon('check-circle'), ' ', t('offer_pro_on'))
      : h('p', { class: 'small muted' }, t('offer_login_pro'), ' ', h('a', { href: '/compte' }, t('offer_login_link'))),
  );
  const vision = visionOffer(() => {
    chooser.hidden = false;
    chips.querySelector('[aria-pressed="true"]')?.focus();
  });
  card.append(
    h(
      'div',
      { class: 'support-offers' },
      h('div', { class: 'offer offer-tool' }, h('h4', {}, t('offer_tool_title')), h('p', { class: 'small' }, t('offer_tool_text')), fleeingLicence(vision.button)),
      vision.element,
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

// Paiement rattaché au compte connecté : le serveur active la licence Pro en proportion du montant.
const withAccount = (url) => {
  const id = session.get()?.id;
  return id ? `${url}${url.includes('?') ? '&' : '?'}client_reference_id=${id}` : url;
};

/**
 * « Prendre une licence » : le bouton de celui qui ne voit que l'outil. Il fuit toujours la souris en
 * montrant la droite ; au doigt ou au clavier, il ne s'ouvre pas non plus : il désigne le vrai bouton.
 */
function fleeingLicence(target) {
  const lines = ['offer_flee_1', 'offer_flee_2', 'offer_flee_3', 'offer_flee_4'];
  const quiet = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let said = 0;
  let resting = 0;
  const button = h('button', { type: 'button', class: 'btn btn-soft runaway', id: 'runaway-btn' }, t('offer_tool_btn'));
  const says = h('span', { class: 'runaway-says', 'aria-live': 'polite' });
  const zone = h('div', { class: 'runaway-zone' }, button);
  // Montrer le vrai bouton : une phrase, et le bouton de droite qui s'illumine.
  const point = () => {
    says.textContent = t(lines[said % lines.length]);
    said++;
    target.classList.remove('nudge');
    void target.offsetWidth; // relance l'animation à chaque fois
    target.classList.add('nudge');
  };
  // Un saut ailleurs dans sa zone : parmi quelques places au hasard, la plus loin du pointeur.
  const jump = (pointerX, pointerY) => {
    const room = zone.getBoundingClientRect();
    const size = button.getBoundingClientRect();
    const spots = Array.from({ length: 8 }, () => ({ x: Math.random() * Math.max(0, room.width - size.width), y: Math.random() * Math.max(0, room.height - size.height) }));
    const far = (spot) => Math.hypot(room.left + spot.x + size.width / 2 - pointerX, room.top + spot.y + size.height / 2 - pointerY);
    const spot = spots.reduce((x, y) => (far(y) > far(x) ? y : x));
    button.style.setProperty('--run-x', `${spot.x}px`);
    button.style.setProperty('--run-y', `${spot.y}px`);
    zone.classList.add('running');
    resting = Date.now() + 350;
    point();
  };
  zone.addEventListener('pointermove', (event) => {
    if (event.pointerType !== 'mouse' || quiet || Date.now() < resting) return;
    const box = button.getBoundingClientRect();
    if (Math.hypot(event.clientX - (box.left + box.width / 2), event.clientY - (box.top + box.height / 2)) < box.width * 0.8) jump(event.clientX, event.clientY);
  });
  button.addEventListener('click', (event) => {
    event.preventDefault();
    if (quiet || event.detail === 0) {
      point(); // au clavier : pas de saut, on désigne le vrai bouton
      target.focus();
    } else jump(event.clientX, event.clientY);
  });
  return h('div', { class: 'runaway-wrap' }, zone, says);
}

/** « Soutenir le projet » : la vision, et le vrai bouton (ticket « C'est votre tour ! » au survol). */
function visionOffer(onChoose) {
  const button = h(
    'button',
    { type: 'button', class: 'btn btn-big btn-block licence-btn', id: 'support-btn' },
    h('span', { class: 'licence-tag', 'aria-hidden': 'true' }, h('b', {}, '001'), t('offer_tag')),
    h('span', { class: 'licence-bell' }, icon('bell-ringing')),
    t('offer_vision_btn'),
  );
  button.addEventListener('click', onChoose);
  const element = h(
    'div',
    { class: 'offer offer-vision' },
    h('h4', {}, t('offer_vision_title')),
    h('p', { class: 'vision-quote' }, t('offer_vision_text')),
    h('p', { class: 'small muted' }, t('offer_vision_pro')),
    h('div', { class: 'licence-wrap' }, h('span', { class: 'licence-halo', 'aria-hidden': 'true' }), button),
  );
  return { element, button };
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
