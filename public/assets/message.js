// Composition du message d'appel : modèle du lot + listes déroulantes (variables) + retouche libre.
//   Variables intégrées : {nom} {numero} {groupe} (aussi {name} {number} {group}),
//   remplacées pour chaque ticket ; variables du lot : {Terrain}, {Équipe}… (ses listes).
//   Une option « U11 > Rouge » crée une sous-liste : deux menus déroulants enchaînés.
import { h, t, local } from './common.js';

const norm = (key) => key.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();

/** Remplace les {variables} connues ; les autres restent telles quelles. */
export function fill(text, values) {
  const map = Object.fromEntries(Object.entries(values).map(([k, v]) => [norm(k), v]));
  return text.replace(/\{([\p{L}\p{N} _-]{1,24})\}/gu, (match, key) => (norm(key) in map ? map[norm(key)] : match));
}

/** Variables intégrées pour un ticket donné. */
export const builtins = ({ name, label = '', group = '' }) => ({ nom: name, name, numero: label, number: label, num: label, groupe: group, group });

/** Plage « 12-18, 25 » → numéros (même règle que le serveur). */
export function parseNumbers(text, max = 200) {
  const numbers = new Set();
  for (const part of String(text).split(/[,;\s]+/).filter(Boolean)) {
    const match = /^(\d{1,6})(?:-(\d{1,6}))?$/.exec(part);
    if (!match) return null;
    const a = Number(match[1]);
    const b = Number(match[2] ?? match[1]);
    if (a < 1 || b < a || b - a + 1 > max) return null;
    for (let n = a; n <= b; n++) numbers.add(n);
    if (numbers.size > max) return null;
  }
  return numbers.size ? [...numbers].sort((x, y) => x - y) : null;
}

export const groupOf = (lot, n) => (lot.groups ?? []).find((g) => parseNumbers(g.numbers)?.includes(n))?.name ?? '';

/** Le compositeur n'apparaît que si le lot a un modèle ou des listes ; sinon, message par défaut traduit. */
export const needsComposer = (lot) => Boolean(lot.template) || (lot.lists ?? []).length > 0;

/** Modèle utilisé : celui du lot, sinon le texte par défaut suivi des variables des listes. */
function baseTemplate(lot) {
  if (lot.template) return lot.template;
  return [t('tpl_default'), ...(lot.lists ?? []).map((l) => `{${l.name}}`)].join(' ');
}

/** Un menu déroulant par liste ; deux enchaînés pour une liste « Parent > Enfant ». */
function listField(list, saved, onChange) {
  const nested = list.options.some((o) => o.includes('>'));
  const empty = () => h('option', { value: '' }, t('var_none'));
  if (!nested) {
    const select = h('select', { class: 'select' }, empty(), list.options.map((o) => h('option', { value: o, selected: o === saved }, o)));
    select.addEventListener('change', () => onChange(select.value));
    return { element: select, value: () => select.value };
  }
  const split = (o) => o.split('>').map((s) => s.trim());
  const parents = [...new Set(list.options.map((o) => split(o)[0]))];
  const [savedParent, savedChild] = saved ? split(saved) : [];
  const parent = h('select', { class: 'select' }, empty(), parents.map((p) => h('option', { value: p, selected: p === savedParent }, p)));
  const child = h('select', { class: 'select' });
  const fillChildren = (keep) => {
    const children = list.options.map(split).filter(([p, c]) => p === parent.value && c);
    child.replaceChildren(empty(), ...children.map(([, c]) => h('option', { value: c, selected: c === keep }, c)));
    child.hidden = children.length === 0;
  };
  const value = () => [parent.value, child.hidden ? '' : child.value].filter(Boolean).join(' ');
  parent.addEventListener('change', () => {
    fillChildren('');
    onChange(value());
  });
  child.addEventListener('change', () => onChange(value()));
  fillChildren(savedChild);
  return { element: h('div', { class: 'inline-fields' }, parent, child), value, raw: () => [parent.value, child.value].filter(Boolean).join(' > ') };
}

/**
 * Bloc « message » à placer avant le bouton d'appel.
 * example : { label, group } du ticket montré en aperçu.
 * Renvoie { element, message(), tag() } : message avec les listes remplies ({numero}… gardés).
 */
export function composer(lot, example = {}) {
  const storageKey = `wcy:vars:${lot.lot}`;
  const saved = local.get(storageKey, {});
  const values = {};
  let dirty = false;
  const text = h('textarea', { class: 'textarea', rows: 3, maxlength: 280 });
  const preview = h('p', { class: 'small muted' });
  const reset = h('button', { type: 'button', class: 'linklike small', hidden: true }, t('msg_reset'));

  const refreshPreview = () => {
    preview.textContent = t('msg_preview', { text: fill(text.value, builtins({ name: lot.name, label: example.label, group: example.group })) });
  };
  const rebuild = () => {
    if (!dirty) text.value = fill(baseTemplate(lot), values);
    refreshPreview();
  };
  const fields = (lot.lists ?? []).map((list) => {
    const field = listField(list, saved[list.name], (v) => {
      values[list.name] = v;
      local.set(storageKey, { ...local.get(storageKey, {}), [list.name]: field.raw?.() ?? v });
      rebuild();
    });
    values[list.name] = field.value();
    return h('div', { class: 'field' }, h('label', {}, list.name), field.element);
  });
  text.addEventListener('input', () => {
    dirty = true;
    reset.hidden = false;
    refreshPreview();
  });
  reset.addEventListener('click', () => {
    dirty = false;
    reset.hidden = true;
    rebuild();
  });
  rebuild();

  return {
    element: h('div', { class: 'composer stack' }, fields, h('label', {}, t('msg_title')), text, preview, reset, h('p', { class: 'small muted' }, t('msg_hint'))),
    message: () => text.value.trim(),
    /** Repère court pour l'écran public : valeurs choisies dans les listes. */
    tag: (group = '') => [...new Set([group, ...Object.values(values)].filter(Boolean))].join(' · '),
  };
}
