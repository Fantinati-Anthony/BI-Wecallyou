// Le calcul de l'atelier d'impression (page Soutenir) : capacité, goulot, marge, et le « tout gratuit ».
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compute } from '../../public/assets/workshop.js';

const cfg = JSON.parse(readFileSync(new URL('../../public/soutien.json', import.meta.url), 'utf8'));
const fees = { percent: cfg.fee_percent, fixed: cfg.fee_fixed };
const base = { ...cfg.sim, donations: 0, server: 21 };

test('hypothèses de départ : un mi-temps suffit, et les ventes peuvent tout payer', () => {
  const r = compute(base, fees);
  // 76 h moins 45 min par jour sur 21 jours, à 12 min par commande plus la surveillance de l'impression.
  assert.equal(r.bottleneck, 'staff');
  assert.equal(r.capacity, Math.floor((76 * 60 - 45 * 21) / (12 + 0.1 * (10 / 240 * 60 + 1 / 150 * 60))));
  assert.ok(Math.abs(r.margin - (18 - (10 * 0.12 + 0.3 + 0.7) - (18 * 0.015 + 0.25))) < 1e-9);
  assert.equal(r.dream, Math.ceil((1100 + 150 + 500 + 21) / r.margin));
  assert.ok(r.dream <= r.capacity); // réalisable
  assert.ok(r.result > 0 && Number.isFinite(r.payback));
});

test('une imprimante trop lente devient le goulot ; trop de commandes dépassent les heures', () => {
  const slow = compute({ ...base, sheetsA4: 50, speedA4: 60 }, fees);
  assert.equal(slow.bottleneck, 'a4');
  assert.equal(slow.capacity, Math.floor((76 * 60) / 50));
  const busy = compute({ ...base, orders: 800 }, fees);
  assert.ok(busy.load > 1 && busy.workHours > base.hours);
});

test('sans marge, rien ne se rembourse ; les dons couvrent le serveur', () => {
  const free = compute({ ...base, price: 2 }, fees);
  assert.ok(free.margin <= 0);
  assert.equal(free.dream, Infinity);
  assert.equal(compute({ ...base, donations: 42 }, fees).coverServer, 2);
});
