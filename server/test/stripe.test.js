// Soutien et licence Pro : un paiement rattaché à un compte active le Pro, en proportion du prix
// conseillé, et un soutien annuel se compare à douze mois.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyEvent } from '../lib/stripe.js';

const DAY = 86_400_000;

test('soutien annuel : comparé à douze fois le prix conseillé, au prorata du montant', async () => {
  let until = 0;
  const accounts = { accountOfCustomer: async () => 'compte', extendPro: async (_, t) => (until = t) };
  const pricing = { suggested: async () => 1, proLinks: [] }; // 1 € par mois conseillé
  const now = Date.UTC(2026, 9, 10);
  const year = { start: now / 1000, end: now / 1000 + 365 * 86_400 };
  const paid = (cents) => ({ type: 'invoice.paid', data: { object: { customer: 'cus_an', amount_paid: cents, lines: { data: [{ period: year }] } } } });
  assert.equal(await applyEvent(paid(1200), accounts, pricing, now), 'pro');
  assert.ok(until >= now + 365 * DAY); // 12 € pour 12 mois à 1 € : l'année entière
  await applyEvent(paid(600), accounts, pricing, now);
  assert.ok(Math.abs(until - (now + 184 * DAY)) < 2 * DAY); // la moitié : environ six mois
  // Sans début de période (ancien format) : un mois, comme avant.
  await applyEvent({ type: 'invoice.paid', data: { object: { customer: 'cus_an', amount_paid: 100, lines: { data: [{ period: { end: year.end } }] } } } }, accounts, pricing, now);
  assert.ok(until >= now + 365 * DAY);
});
