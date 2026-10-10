// Bulletin de santé du service : chiffres du mois, anonymes, qui s'additionnent d'un redémarrage
// (ou d'un processus) à l'autre ; totaux du mois et files actives comptées une seule fois.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { Health } from '../lib/health.js';
import { Store } from '../lib/store.js';

test('santé : charge, minutes à la limite, priorité, direct plein, cumulés sur le mois', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'wcy-health-'));
  try {
    const health = new Health(tmp);
    health.load(0.2);
    health.load(0.6);
    health.live(12);
    await health.minute(); // aucune limite touchée
    health.limit(); // porte pleine
    health.priority();
    health.priority();
    await health.minute();
    health.load(0.8); // au-delà de 75 % : la porte se resserre, c'est une limite
    await health.minute();
    health.full(); // plus de place en direct
    health.live(32);
    let month = await health.month();
    assert.equal(month.samples, 3);
    assert.equal(month.peak, 0.8);
    assert.ok(Math.abs(month.sum - 1.6) < 1e-9);
    assert.equal(month.limits, 2); // la minute de « full » n'est pas encore close
    assert.equal(month.priority, 2);
    assert.equal(month.full, 1);
    assert.equal(month.live, 32);

    // Après un redémarrage (ou dans un autre processus) : on ajoute, on ne remplace pas.
    const again = new Health(tmp);
    again.load(0.1);
    again.live(5);
    await again.minute();
    month = await again.month();
    assert.equal(month.samples, 4);
    assert.equal(month.peak, 0.8);
    assert.equal(month.live, 32);
    assert.equal(month.limits, 2);
    assert.equal(month.busy, 0); // aucune page de client ouverte jusqu'ici

    // Affluence : une page ouverte relit son ticket toutes les 30 s (deux fois par minute).
    for (let i = 0; i < 60; i++) again.read(i < 40 ? 7 : 9); // 30 pages dans 2 files
    await again.minute();
    again.read(7); // une seule page, une seule lecture dans la minute
    await again.minute();
    await again.minute(); // personne
    month = await again.month();
    assert.equal(month.pages, 30);
    assert.equal(month.pagesQueues, 2);
    assert.equal(month.busy, 2); // deux minutes d'affluence
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('totaux du mois : compteurs de toutes les files, chaque file active comptée une fois', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'wcy-totals-'));
  try {
    const store = new Store({ dataDir: path.join(tmp, 'data'), publicDir: path.join(tmp, 'public'), statusKey: randomBytes(32) });
    await store.init();
    const month = new Date().toISOString().slice(0, 7);
    store.count(1, 'scan');
    store.count(1, 'scan');
    store.count(2, 'scan_desk');
    store.count(2, 'call');
    await store.flushStats();
    store.count(1, 'scan'); // même file, même mois : pas une file de plus
    let totals = await store.totals(month);
    assert.deepEqual(totals, { queues: 2, scan: 3, scan_desk: 1, call: 1 });
    // Écritures en même temps : rien ne se perd.
    store.count(3, 'scan');
    await Promise.all([store.flushStats(), store.flushStats(), store.totals(month)]);
    totals = await store.totals(month);
    assert.equal(totals.queues, 3);
    assert.equal(totals.scan, 4);
    clearInterval(store.flushTimer);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
