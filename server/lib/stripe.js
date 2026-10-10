// Paiements Stripe. Soutenir le projet ouvre la licence Pro du compte connecté (le lien porte son
// identifiant : client_reference_id). Sans compte, c'est un soutien pur : rien à activer.
// La licence s'ouvre pour toute la durée payée ; le montant, ramené au mois, fixe seulement combien
// de tickets passent en priorité quand le serveur sature (table des coûts de soutien.json).
// Stripe prévient le serveur (webhook signé). Le serveur ne voit ni carte, ni nom, ni adresse.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { PRO_MONTH } from './accounts.js';

const TOLERANCE_S = 300;
const GRACE = 3 * 86_400_000; // un renouvellement en retard de quelques jours ne coupe pas la licence
const YEAR = 12; // un soutien ponctuel ouvre la licence pour un an, réparti sur douze mois

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

const euros = (cents) => Math.max(0, Number(cents) || 0) / 100;

/**
 * Applique un événement Stripe :
 *  - soutien ponctuel : licence ouverte un an, montant réparti sur douze mois ;
 *  - abonnement (mensuel ou annuel) : chaque facture payée ouvre la licence jusqu'à la fin de sa
 *    période ; le montant est ramené au mois (une facture annuelle compte pour douze mois).
 *  `pricing` : { proLinks: [plink_…] } (vide = tout lien portant un compte).
 */
export async function applyEvent(event, accounts, pricing, now = Date.now()) {
  const object = event?.data?.object ?? {};
  if (event?.type === 'checkout.session.completed') {
    const id = object.client_reference_id;
    if (!id || !(await accounts.get(id))) return 'no_account'; // un soutien sans compte : rien à activer
    if (pricing.proLinks?.length && !pricing.proLinks.includes(object.payment_link)) return 'not_pro';
    if (typeof object.customer === 'string') await accounts.linkCustomer(object.customer, id);
    if (object.mode === 'subscription') {
      // La facture qui suit fixe la vraie période ; d'ici là, un mois au montant payé.
      const until = now + PRO_MONTH;
      await accounts.extendPro(id, until);
      await accounts.setSupport(id, euros(object.amount_total), until);
    } else {
      const current = (await accounts.get(id)).premiumUntil ?? 0;
      const until = Math.max(now, current) + YEAR * PRO_MONTH;
      await accounts.extendPro(id, until);
      await accounts.setSupport(id, euros(object.amount_total) / YEAR, until);
    }
    return 'pro';
  }
  if (event?.type === 'invoice.paid') {
    const id = await accounts.accountOfCustomer(object.customer);
    if (!id) return 'unknown_customer'; // abonnement sans compte, ou client inconnu
    const lines = object.lines?.data ?? [];
    const end = Math.max(now, ...lines.map((line) => (line.period?.end ?? 0) * 1000));
    const start = Math.min(...lines.map((line) => (line.period?.start ?? 0) * 1000).filter(Boolean));
    const months = Number.isFinite(start) ? Math.max(1, Math.round((end - start) / PRO_MONTH)) : 1;
    await accounts.extendPro(id, end + GRACE);
    await accounts.setSupport(id, euros(object.amount_paid) / months, end + GRACE);
    return 'pro';
  }
  return 'ignored';
}
