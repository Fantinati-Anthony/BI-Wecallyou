// Ce que coûte une évolution, mesuré : public/couts.json (écrit par server/couts.js à la fin de chaque
// session de travail) donne le coût réel de chaque évolution déjà livrée. On en tire des fourchettes par
// taille, en jetons, en dollars au tarif de l'API, et en part de l'abonnement réellement payé.
import { LANG } from './common.js';

let loading;
/** Les coûts mesurés (une fois par page). */
export function loadCosts() {
  loading ??= fetch('/couts.json', { cache: 'no-cache' })
    .then((res) => (res.ok ? res.json() : null))
    .catch(() => null);
  return loading;
}

/** Taille d'une idée d'après sa durée estimée (en jours de développeur). */
export const sizeOf = (days) => (days <= 1.5 ? 'small' : days <= 4 ? 'medium' : 'large');

/**
 * Fourchettes par taille : le tiers le moins cher des évolutions livrées pour une petite, le tiers du
 * milieu pour une moyenne, le tiers le plus cher pour une grosse. Rien sans mesure.
 */
export function calibrate(costs) {
  const done = costs?.evolutions?.filter((e) => e.usd > 0) ?? [];
  if (done.length < 3) return null;
  const sorted = (key) => done.map((e) => e[key]).sort((a, b) => a - b);
  const usd = sorted('usd');
  const tokens = sorted('tokens');
  const at = (list, p) => list[Math.round(p * (list.length - 1))];
  const range = (list) => ({ small: [list[0], at(list, 1 / 3)], medium: [at(list, 1 / 3), at(list, 2 / 3)], large: [at(list, 2 / 3), list.at(-1)] });
  const usdRanges = range(usd);
  const tokenRanges = range(tokens);
  return {
    count: done.length,
    median: at(usd, 0.5),
    eurPerUsd: costs.usd ? costs.subscription / costs.usd : 0, // ce que coûte vraiment un dollar d'IA, par l'abonnement
    minutes: Math.round((costs.hours * 60) / done.length),
    size: (name) => ({ usd: usdRanges[name], tokens: tokenRanges[name] }),
  };
}

const fr = LANG === 'fr';
const number = (n, digits = 1) => new Intl.NumberFormat(fr ? 'fr' : 'en', { maximumFractionDigits: digits }).format(n);
const twoDigits = (n) => new Intl.NumberFormat(fr ? 'fr' : 'en', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
/** 3,94 $ (en français) ou $3.94. */
export const dollars = (n) => (fr ? `${twoDigits(n)} $` : `$${twoDigits(n)}`);
/** Jetons en millions : « 13,9 M ». */
export const millions = (n) => `${number(n / 1e6, n < 1e7 ? 1 : 0)} M`;
/** Centimes d'euro quand c'est petit : « 0,04 € ». */
export const cents = (n) => new Intl.NumberFormat(fr ? 'fr' : 'en', { style: 'currency', currency: 'EUR', minimumFractionDigits: n < 10 ? 2 : 0, maximumFractionDigits: n < 10 ? 2 : 0 }).format(n);
