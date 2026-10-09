// Outils de l'offre Pro, partagés par le générateur de tickets (accueil) et les réglages du lot :
// couleurs de l'écran public et de la page client, et la mention « réservé au Pro » quand ils sont grisés.
import { h, t, icon, inkOn } from './common.js';

export const PRO_LIFETIMES = [72, 168, 360, 720]; // 3, 7, 15 et 30 jours
/** Couleurs d'origine de l'écran public et de la page client. */
export const THEME_DEFAULTS = { screenBg: '#0e1013', screenText: '#f4f5f7', screenNumber: '#ff8a5c', accent: '#c8461c' };

/**
 * Couleurs Pro avec aperçu en direct.
 * value() : undefined si rien n'a changé, null pour les couleurs d'origine, sinon les couleurs.
 * canReset : revenir aux couleurs d'origine reste permis même sans Pro (lot qui en avait).
 */
export function themeFields({ initial = null, enabled = true, canReset = enabled, name = '' } = {}) {
  let touched = false;
  const label = h('span', {}, name || '…');
  const preview = h('div', { class: 'theme-preview', 'aria-hidden': 'true' }, h('div', { class: 'tp-screen' }, label, h('b', {}, '042')), h('div', { class: 'tp-btn' }, t('theme_button')));
  const inputs = Object.entries(THEME_DEFAULTS).map(([key, fallback]) => {
    const input = h('input', { type: 'color', class: 'color', id: `th-${key}`, value: initial?.[key] ?? fallback });
    input.addEventListener('input', () => {
      touched = true;
      draw();
    });
    return { key, input, element: h('div', { class: 'field' }, h('label', { for: `th-${key}` }, t(`theme_${key}`)), input) };
  });
  function draw() {
    for (const { key, input } of inputs) preview.style.setProperty(`--tp-${key}`, input.value);
    preview.style.setProperty('--tp-ink', inkOn(inputs.find((i) => i.key === 'accent').input.value));
  }
  const reset = h('button', { type: 'button', class: 'linklike small' }, t('theme_reset'));
  reset.addEventListener('click', () => {
    for (const { key, input } of inputs) input.value = THEME_DEFAULTS[key];
    touched = true;
    draw();
  });
  const setEnabled = (on, resettable = on) => {
    for (const { input } of inputs) input.disabled = !on;
    reset.hidden = !resettable;
  };
  setEnabled(enabled, canReset);
  draw();
  return {
    element: h('div', { class: 'stack' }, h('h3', {}, t('s_theme')), h('p', { class: 'small muted' }, t('s_theme_hint')), preview, h('div', { class: 'grid-4' }, inputs.map((i) => i.element)), reset),
    value() {
      if (!touched) return undefined;
      const theme = Object.fromEntries(inputs.map(({ key, input }) => [key, input.value]));
      return Object.entries(theme).every(([key, value]) => value === THEME_DEFAULTS[key]) ? null : theme;
    },
    setEnabled,
    setName: (value) => {
      label.textContent = value || '…';
    },
  };
}

/** Mention sous des outils grisés : réservés au Pro, avec le lien vers l'offre. anonymous : pas de compte connecté. */
export function proLock(anonymous) {
  return h('p', { class: 'pro-lock small' }, icon('lock-key'), h('span', {}, t(anonymous ? 'pro_lock_anon' : 'pro_lock_free'), ' ', h('a', { href: '/pro' }, t('nav_pro'))));
}
