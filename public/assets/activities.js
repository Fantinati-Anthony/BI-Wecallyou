// Modèles par activité (public/activites.json) : un message, des variables et une durée adaptés à
// chaque métier (un snack ne parle pas de terrain de foot), et un nom de commerce d'exemple pour les
// démonstrations. Choisis dans une fenêtre (création d'un lot, réglages, compte) et montrés sur
// l'accueil. Tout reste modifiable ensuite.
import { h, t, LANG, icon, render } from './common.js';
import { fill, builtins, variableChips, builtinNames } from './message.js';

/** Activité choisie par défaut sur ce téléphone (et dans le coffre chiffré du compte). */
export const ACTIVITY_KEY = 'wcy:activity';
const FALLBACK = 'autre';

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

/** L'activité d'identifiant id, sinon « Autre » (message simple). */
export const activityOf = (activities, id) => activities.find((a) => a.id === id) ?? activities.find((a) => a.id === FALLBACK) ?? null;

/** Message et listes du modèle, dans la langue de l'interface. */
export const presetOf = (activity) => activity?.[LANG] ?? activity?.en ?? { template: '', lists: [] };
export const nameOf = (activity) => activity?.name[LANG] ?? activity?.name.en ?? '';
/** Nom de commerce d'exemple, pour les démonstrations. */
export const demoOf = (activity) => activity?.demo?.[LANG] ?? activity?.demo?.en ?? t('demo_name');
/** Durée de vie conseillée, en clair (« 3 h », « 7 jours (Pro) »). */
export const ttlText = (hours) => (hours >= 72 ? t('ttl_days', { d: hours / 24 }) : t('ttl_option', { h: hours }));

/** Le message tel qu'un client le recevrait (modèle et listes donnés, première option de chaque liste). */
export function messageExample({ template, lists }, name, label = '042') {
  if (!template.trim()) return t('msg_ready', { m: name, n: label });
  const choices = Object.fromEntries(lists.map((list) => [list.name, list.options[0] ?? '']));
  return fill(template, { ...builtins({ name, label, group: t('act_group_example') }), ...choices });
}

/** Exemple du modèle d'une activité, avec le nom du commerce (ou celui de la démonstration). */
export const exampleOf = (activity, name) => messageExample(presetOf(activity), name || demoOf(activity));

/* --------------------------------------------- listes et groupes ⇄ texte */

export const listsToText = (lists) => lists.map((l) => `${l.name} : ${l.options.join(', ')}`).join('\n');
export const groupsToText = (groups) => groups.map((g) => `${g.name} : ${g.numbers}`).join('\n');

/** « Nom : a, b, c » par ligne → [{ name, options }]. */
export const textToLists = (text) =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [name, ...rest] = line.split(':');
      return { name: name.trim(), options: rest.join(':').split(',').map((o) => o.trim()).filter(Boolean) };
    });

/** « Nom : 12-18, 25 » par ligne → [{ name, numbers }]. */
export const textToGroups = (text) =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const at = line.lastIndexOf(':');
      return { name: line.slice(0, at).trim(), numbers: line.slice(at + 1).trim() };
    });

/* --------------------------------------------------- fenêtre de choix */

/**
 * Fenêtre de choix : les activités en blocs à gauche, à droite le message qu'un client recevrait,
 * les variables proposées et la durée conseillée. Renvoie une promesse : l'activité choisie, ou null.
 */
export function chooseActivity({ activities, selected = null, name = '' }) {
  let chosen = activityOf(activities, selected);
  const phone = h('div', { class: 'act-phone' });
  const details = h('div', { class: 'act-details' });
  const show = (activity) => {
    const merchant = name || demoOf(activity);
    render(
      phone,
      h('div', { class: 'act-phone-head' }, icon('ticket'), h('b', {}, '042'), h('span', {}, `· ${merchant}`)),
      h('strong', {}, t('ready_title')),
      h('p', {}, exampleOf(activity, name)),
    );
    const { lists } = presetOf(activity);
    render(
      details,
      h('h3', {}, icon(activity.icon), nameOf(activity)),
      lists.length
        ? [h('p', { class: 'small muted' }, t('act_vars')), h('ul', { class: 'act-vars' }, lists.map((l) => h('li', {}, h('b', {}, `{${l.name}}`), ' ', l.options.join(' · '))))]
        : h('p', { class: 'small muted' }, t('act_no_vars')),
      h('p', { class: 'small' }, icon('clock'), ' ', t('act_ttl', { d: ttlText(activity.ttl) })),
    );
  };
  const blocks = activities.map((activity) => {
    const block = h('button', { type: 'button', class: 'act-block', 'data-id': activity.id, 'aria-pressed': String(activity === chosen) }, icon(activity.icon), h('span', {}, nameOf(activity)));
    block.addEventListener('click', () => {
      chosen = activity;
      for (const b of blocks) b.setAttribute('aria-pressed', String(b === block));
      show(activity);
    });
    // Survol ou clavier : on voit le message avant de choisir.
    for (const type of ['mouseenter', 'focus']) block.addEventListener(type, () => show(activity));
    block.addEventListener('mouseleave', () => chosen && show(chosen));
    return block;
  });
  const use = h('button', { type: 'button', class: 'btn act-use' }, icon('check'), t('act_use'));
  const close = h('button', { type: 'button', class: 'btn btn-ghost act-close', 'aria-label': t('close') }, icon('x'));
  const dialog = h(
    'dialog',
    { class: 'act-dialog', 'aria-labelledby': 'act-dialog-title' },
    h('header', { class: 'act-dialog-head' }, h('h2', { id: 'act-dialog-title' }, t('act_dialog_title')), close),
    h('p', { class: 'small muted' }, t('act_dialog_intro')),
    h('div', { class: 'act-dialog-body' }, h('div', { class: 'act-grid' }, blocks), h('aside', { class: 'act-preview' }, h('p', { class: 'small muted' }, t('act_preview')), phone, details)),
    h('footer', { class: 'act-dialog-foot' }, h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => dialog.close() }, t('cancel_btn')), use),
  );
  show(chosen ?? activities[0]);
  document.body.append(dialog);
  dialog.showModal();
  (blocks.find((b) => b.getAttribute('aria-pressed') === 'true') ?? blocks[0])?.focus();
  return new Promise((resolve) => {
    let result = null;
    use.addEventListener('click', () => {
      result = chosen;
      dialog.close();
    });
    close.addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => {
      dialog.remove();
      resolve(result);
    });
  });
}

/* ------------------------------------------- éditeur « Message et variables » */

/**
 * Activité (avec le bouton pour la choisir), message d'appel avec ses variables, listes et groupes :
 * à la création d'un lot comme dans ses réglages. Choisir une activité remplit le message et les listes
 * (après confirmation s'ils ont été modifiés). ids : identifiants des champs. Renvoie
 * { element, value(), activity(), refresh() }.
 */
export function messageEditor({ activities, selected = null, initial = null, name = () => '', ids, onActivity = () => {} }) {
  let current = selected ? activityOf(activities, selected) : null;
  const template = h('textarea', { id: ids.template, class: 'textarea', rows: 3, maxlength: 280, placeholder: t('s_template_ph') });
  const lists = h('textarea', { id: ids.lists, class: 'textarea', rows: 3, placeholder: t('s_lists_ph') });
  const groups = h('textarea', { id: ids.groups, class: 'textarea', rows: 3, placeholder: t('s_groups_ph') });
  const apply = (activity) => {
    const preset = presetOf(activity);
    template.value = preset.template;
    lists.value = listsToText(preset.lists);
  };
  if (initial) {
    template.value = initial.template ?? '';
    lists.value = listsToText(initial.lists ?? []);
    groups.value = groupsToText(initial.groups ?? []);
  } else if (current) apply(current);

  // Insertion d'une variable d'un simple appui (les listes saisies apparaissent aussitôt).
  const vars = variableChips(template, () => [...builtinNames(), ...textToLists(lists.value).map((l) => l.name)].filter(Boolean));
  const example = h('p', { class: 'msg-example', 'aria-live': 'polite' });
  const refresh = () => {
    vars.refresh();
    example.replaceChildren(h('span', { class: 'small muted' }, t('act_sent')), ' ', `« ${messageExample({ template: template.value, lists: textToLists(lists.value) }, name() || demoOf(current))} »`);
  };
  template.addEventListener('input', refresh);
  lists.addEventListener('input', refresh);

  const label = h('span', { class: 'act-current' });
  const drawLabel = () => render(label, current ? [icon(current.icon), h('b', {}, nameOf(current))] : h('span', { class: 'muted' }, t('act_none')));
  const choose = h('button', { type: 'button', class: 'btn btn-ghost', id: ids.choose }, icon('squares-four'), t(current ? 'act_change' : 'act_choose'));
  choose.addEventListener('click', async () => {
    const picked = await chooseActivity({ activities, selected: current?.id, name: name() });
    if (!picked) return;
    // Message retouché (ou propre au lot) : on demande avant de le remplacer par le modèle choisi.
    const was = current ? presetOf(current) : { template: '', lists: [] };
    const edited = template.value !== was.template || lists.value !== listsToText(was.lists);
    if (edited && (template.value.trim() || lists.value.trim()) && !confirm(t('act_replace_confirm'))) return;
    current = picked;
    apply(picked);
    drawLabel();
    render(choose, icon('squares-four'), t('act_change'));
    refresh();
    onActivity(picked);
  });
  drawLabel();
  refresh();

  return {
    element: h(
      'div',
      { class: 'stack' },
      h('label', { for: ids.choose }, t('studio_activity')),
      h('div', { class: 'act-line' }, label, choose),
      h('label', { for: ids.template }, t('s_template')),
      template,
      vars.element,
      example,
      h('p', { class: 'small muted' }, t('s_template_hint')),
      h('label', { for: ids.lists }, t('s_lists')),
      lists,
      h('p', { class: 'small muted' }, t('s_lists_hint')),
      h('label', { for: ids.groups }, t('s_groups')),
      groups,
      h('p', { class: 'small muted' }, t('s_groups_hint')),
    ),
    value: () => ({ template: template.value, lists: textToLists(lists.value), groups: textToGroups(groups.value) }),
    activity: () => current,
    refresh,
  };
}
