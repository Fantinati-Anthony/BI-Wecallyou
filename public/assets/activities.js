// Modèles par activité (public/activites.json) : un carrousel de métiers qui propose un message et
// des variables adaptés à chacun (un snack ne parle pas de terrain de foot). Utilisé à la création
// d'un lot et dans Réglages > Message et variables. Tout reste modifiable ensuite.
import { h, t, LANG, icon } from './common.js';
import { fill, builtins } from './message.js';

let catalog = null;

export async function loadActivities() {
  if (catalog) return catalog;
  try {
    const res = await fetch('/activites.json', { cache: 'no-cache' });
    catalog = res.ok ? ((await res.json()).activities ?? []) : [];
  } catch {
    catalog = [];
  }
  return catalog;
}

/** Message et listes du modèle, dans la langue de l'interface. */
export const presetOf = (activity) => activity?.[LANG] ?? activity?.en ?? { template: '', lists: [] };

/** Le message tel qu'un client le recevrait, avec la première option de chaque liste. */
export function exampleOf(activity, name) {
  const { template, lists } = presetOf(activity);
  const merchant = name || t('demo_name');
  if (!template) return t('msg_ready', { m: merchant, n: '042' });
  const choices = Object.fromEntries(lists.map((list) => [list.name, list.options[0] ?? '']));
  return fill(template, { ...builtins({ name: merchant, label: '042', group: t('act_group_example') }), ...choices });
}

/**
 * Carrousel des activités. onPick(activity) au choix ; name() : nom du commerce, pour des exemples
 * parlants. Renvoie { element, select(id), refresh() }.
 */
export function activityPicker({ activities, selected = null, name = () => '', onPick }) {
  const examples = new Map();
  const track = h(
    'div',
    { class: 'activity-track', role: 'group', 'aria-label': t('studio_activity') },
    activities.map((activity) => {
      const example = h('span', { class: 'activity-example' });
      examples.set(activity, example);
      const card = h(
        'button',
        { type: 'button', class: 'activity', 'data-id': activity.id, 'aria-pressed': String(activity.id === selected) },
        h('span', { class: 'activity-icon' }, icon(activity.icon)),
        h('span', { class: 'activity-name' }, activity.name[LANG] ?? activity.name.en),
        example,
      );
      card.addEventListener('click', () => {
        select(activity.id);
        onPick(activity);
      });
      return card;
    }),
  );
  const smooth = () => (matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth');
  const step = (direction) => track.scrollBy({ left: direction * track.clientWidth * 0.8, behavior: smooth() });
  const nav = h(
    'div',
    { class: 'carousel-nav' },
    h('button', { type: 'button', class: 'btn btn-ghost', 'aria-label': t('act_prev'), onclick: () => step(-1) }, icon('arrow-left')),
    h('button', { type: 'button', class: 'btn btn-ghost', 'aria-label': t('act_next'), onclick: () => step(1) }, icon('arrow-right')),
  );

  function select(id) {
    for (const card of track.children) card.setAttribute('aria-pressed', String(card.dataset.id === id));
  }
  function refresh() {
    for (const [activity, example] of examples) example.textContent = `« ${exampleOf(activity, name())} »`;
  }
  refresh();
  if (selected) requestAnimationFrame(() => track.querySelector('[aria-pressed="true"]')?.scrollIntoView({ block: 'nearest', inline: 'start' }));
  return { element: h('div', { class: 'carousel' }, nav, track), select, refresh };
}
