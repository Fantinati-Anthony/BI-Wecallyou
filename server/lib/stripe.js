// Dons via Stripe : chaque don active le statut Pro du compte qui l'a fait.
// Le lien de paiement porte l'identifiant du compte (client_reference_id) ; Stripe prévient ensuite
// le serveur (webhook signé). Le serveur ne voit ni carte, ni nom, ni adresse : seulement « payé ».
import { createHmac, timingSafeEqual } from 'node:crypto';
import { PRO_MONTH } from './accounts.js';

const TOLERANCE_S = 300;
const GRACE = 3 * 86_400_000; // un renouvellement en retard de quelques jours ne coupe pas le Pro

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
 * Applique un événement Stripe :
 *  - paiement terminé (don ponctuel ou 1er mois) : un mois de Pro, cumulable ;
 *  - facture payée (renouvellement mensuel) : Pro jusqu'à la fin de la période payée ;
 *  - don mensuel arrêté : rien à faire, le Pro s'arrête seul à la fin de la période déjà payée.
 */
export async function applyEvent(event, accounts, now = Date.now()) {
  const object = event?.data?.object ?? {};
  if (event?.type === 'checkout.session.completed') {
    const id = object.client_reference_id;
    if (!id || !(await accounts.get(id))) return 'no_account';
    if (typeof object.customer === 'string') await accounts.linkCustomer(object.customer, id);
    const current = (await accounts.get(id)).premiumUntil ?? 0;
    const until = object.mode === 'subscription' ? now + PRO_MONTH : Math.max(now, current) + PRO_MONTH;
    await accounts.extendPro(id, until);
    return 'pro';
  }
  if (event?.type === 'invoice.paid') {
    const id = await accounts.accountOfCustomer(object.customer);
    if (!id) return 'unknown_customer';
    const ends = (object.lines?.data ?? []).map((line) => (line.period?.end ?? 0) * 1000);
    await accounts.extendPro(id, Math.max(now, ...ends) + GRACE);
    return 'pro';
  }
  return 'ignored';
}
