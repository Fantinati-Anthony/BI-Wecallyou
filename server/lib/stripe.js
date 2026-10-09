// Paiements Stripe. Deux offres bien séparées :
//  - le DON : sans contrepartie, il n'active rien (lien sans identifiant de compte) ;
//  - l'abonnement PRO : il active les options Pro du compte (client_reference_id + lien Pro).
// Stripe prévient le serveur (webhook signé). Le serveur ne voit ni carte, ni nom, ni adresse.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { PRO_MONTH } from './accounts.js';

const TOLERANCE_S = 300;
const GRACE = 3 * 86_400_000; // un renouvellement en retard de quelques jours ne coupe pas le Pro
const MAX_MONTHS = 12;

/** Vérifie l'en-tête Stripe-Signature (t=…,v1=…) sur le corps brut de la requête. */
export function verifySignature(rawBody, header, secret, now = Date.now()) {
  if (!secret || typeof header !== 'string') return false;
  const parts = header.split(',').map((p) => p.split('='));
  const t = Number(parts.find(([k]) => k === 't')?.[1]);
  if (!Number.isFinite(t) || Math.abs(now / 1000 - t) > TOLERANCE_S) return false;
  const expected = Buffer.from(createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex'));
  return parts
    .filter(([k]) => k === 'v1')
    .some(([, sig]) => sig?.length === expected.length && timingSafeEqual(Buffer.from(sig), expected));
}

/**
 * Part de période Pro couverte par un paiement : montant payé / prix conseillé pour l'usage du compte.
 * Payer moins que le conseillé raccourcit le Pro en proportion ; personne n'est bloqué.
 */
const coverage = (amountCents, suggestedEuros, max = 1) => Math.min(max, Math.max(0, amountCents / 100 / Math.max(suggestedEuros, 0.01)));

/**
 * Applique un événement Stripe :
 *  - paiement Pro unique (prix libre) : durée = montant / prix conseillé mensuel, cumulable, 12 mois max ;
 *  - abonnement Pro : chaque facture payée prolonge jusqu'à la fin de la période (en proportion si
 *    le palier choisi est sous le prix conseillé) ; arrêté, le Pro s'éteint à la fin de la période payée.
 *  `pricing` : { suggested(accountId) → €/mois, proLinks: [plink_…] (vide = tout lien portant un compte) }.
 */
export async function applyEvent(event, accounts, pricing, now = Date.now()) {
  const object = event?.data?.object ?? {};
  if (event?.type === 'checkout.session.completed') {
    const id = object.client_reference_id;
    if (!id || !(await accounts.get(id))) return 'no_account'; // un don pur : rien à activer
    if (pricing.proLinks.length && !pricing.proLinks.includes(object.payment_link)) return 'not_pro';
    if (typeof object.customer === 'string') await accounts.linkCustomer(object.customer, id);
    const suggested = await pricing.suggested(id);
    const current = (await accounts.get(id)).premiumUntil ?? 0;
    const until =
      object.mode === 'subscription'
        ? now + PRO_MONTH * coverage(object.amount_total ?? 0, suggested)
        : Math.max(now, current) + PRO_MONTH * coverage(object.amount_total ?? 0, suggested, MAX_MONTHS);
    await accounts.extendPro(id, Math.round(until));
    return 'pro';
  }
  if (event?.type === 'invoice.paid') {
    const id = await accounts.accountOfCustomer(object.customer);
    if (!id) return 'unknown_customer'; // abonnement de don pur, ou client inconnu
    const end = Math.max(now, ...(object.lines?.data ?? []).map((line) => (line.period?.end ?? 0) * 1000)) + GRACE;
    const share = coverage(object.amount_paid ?? 0, await pricing.suggested(id));
    await accounts.extendPro(id, Math.round(now + (end - now) * share));
    return 'pro';
  }
  return 'ignored';
}
