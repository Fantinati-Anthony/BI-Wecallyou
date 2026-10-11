// Soutien et licence Pro : la licence s'ouvre pour toute la durée payée ; le montant, ramené au mois,
// fixe les tickets prioritaires (une facture annuelle compte pour douze mois). Réservé aux adresses en France.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyEvent } from '../lib/stripe.js';

const DAY = 86_400_000;

test('soutien annuel : licence ouverte toute l’année, montant ramené au mois', async () => {
  const seen = {};
  const accounts = {
    accountOfCustomer: async () => 'compte',
    extendPro: async (_, until) => (seen.until = until),
    setSupport: async (_, euros, until) => Object.assign(seen, { euros, supportUntil: until }),
  };
  const now = Date.UTC(2026, 9, 10);
  const year = { start: now / 1000, end: now / 1000 + 365 * 86_400 };
  const paid = (cents) => ({ type: 'invoice.paid', data: { object: { customer: 'cus_an', amount_paid: cents, lines: { data: [{ period: year }] } } } });
  assert.equal(await applyEvent(paid(3000), accounts, { proLinks: [] }, now), 'pro');
  assert.ok(seen.until >= now + 365 * DAY); // toute l'année, quel que soit le montant
  assert.equal(seen.euros, 2.5); // 30 € par an = 2,50 € par mois
  // Sans début de période (ancien format) : un mois.
  await applyEvent({ type: 'invoice.paid', data: { object: { customer: 'cus_an', amount_paid: 500, lines: { data: [{ period: { end: year.end } }] } } } }, accounts, { proLinks: [] }, now);
  assert.equal(seen.euros, 5);
});

test('accès membre : seulement pour une adresse de facturation en France', async () => {
  const seen = [];
  const accounts = {
    get: async () => ({ premiumUntil: 0 }),
    linkCustomer: async () => seen.push('lié'),
    extendPro: async () => seen.push('ouvert'),
    setSupport: async () => {},
    accountOfCustomer: async () => null,
  };
  const pay = (address) => ({ type: 'checkout.session.completed', data: { object: { client_reference_id: 'A', mode: 'subscription', amount_total: 300, customer: 'cus_be', customer_details: { address } } } });
  for (const address of [{ country: 'BE' }, {}, undefined]) assert.equal(await applyEvent(pay(address), accounts, { proLinks: [] }), 'not_fr');
  assert.deepEqual(seen, []); // ni Pro, ni client lié : ses renouvellements ne s'appliquent pas non plus
  assert.equal(await applyEvent(pay({ country: 'FR', postal_code: '75011' }), accounts, { proLinks: [] }), 'pro');
  assert.deepEqual(seen, ['lié', 'ouvert']);
});
