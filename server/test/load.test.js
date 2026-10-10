// Charge de l'hébergement (cPanel) et priorité : la porte se resserre près du plafond, le direct
// laisse de la place au reste du site, et seuls les tickets couverts par un soutien passent devant.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadOf, entryLimit, squeeze, HostLoad } from '../lib/load.js';
import { Gate } from '../lib/priority.js';
import { Plans } from '../lib/pro.js';

const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../public');

test('charge cPanel : la limite la plus haute compte, la porte se resserre près du plafond', async () => {
  const usages = (cpu, mem) => ({ status: 1, data: [{ id: 'disk_usage', usage: 9e9, maximum: 1e10 }, { id: 'lvecpu', usage: cpu, maximum: 100 }, { id: 'lvememphy', usage: mem, maximum: 1024 }] });
  assert.equal(loadOf(usages(20, 256)), 0.25); // le disque ne compte pas
  assert.equal(loadOf({ result: { data: [{ id: 'lveep', usage: 18, maximum: 20 }] } }), 0.9);
  assert.equal(loadOf({ data: [] }), null);
  // Réponse réelle d'une lune o2switch (uapi en ligne de commande) : la plus haute limite est
  // celle des processus démarrés, 1 sur 80.
  const lune = { apiversion: 3, func: 'get_usages', module: 'ResourceUsage', result: { status: 1, data: [
    { id: 'disk_usage', maximum: null, usage: 180224 },
    { id: 'bandwidth', maximum: null, usage: '37488888' },
    { id: 'mailing_lists', maximum: '10', usage: 0 },
    { id: 'lvecpu', maximum: 100, usage: 0 },
    { id: 'lveep', maximum: 80, usage: 1 },
    { id: 'lvememphy', maximum: 51539607552, usage: 10678272 },
    { id: 'lveiops', maximum: 1024, usage: 0 },
    { id: 'lveio', maximum: 50331648, usage: 0 },
    { id: 'lvenproc', maximum: 400, usage: 3 },
  ] } };
  assert.equal(loadOf(lune), 1 / 80);
  assert.equal(entryLimit(lune), 80);
  assert.equal(entryLimit({ data: [] }), null);
  assert.equal(squeeze(40, 0.5), 40);
  assert.equal(squeeze(40, 0.9), 20);
  assert.equal(squeeze(40, 0.99), 10);

  const gate = new Gate({ capacity: 40 });
  const host = new HostLoad({ cpanel: { host: 'lune.o2switch.net', user: 'u', token: 't' }, gate, fetcher: async (url, init) => {
    assert.match(url, /:2083\/execute\/ResourceUsage\/get_usages$/);
    assert.equal(init.headers.Authorization, 'cpanel u:t');
    return { json: async () => usages(96, 100) };
  } });
  await host.tick();
  assert.equal(gate.capacity, 10);
  assert.equal(host.view().ratio, 0.96);
  // Hébergeur injoignable : on garde la dernière mesure.
  host.fetcher = async () => { throw new Error('réseau'); };
  await host.tick();
  assert.equal(gate.capacity, 10);
  // Sans réglage cPanel : rien ne bouge.
  assert.equal(new HostLoad({ gate: new Gate() }).configured, false);
  // Sur le même compte : la commande uapi, sans jeton (réponse en ligne de commande : « result »).
  const localGate = new Gate({ capacity: 40 });
  const local = new HostLoad({ cpanel: { local: true }, gate: localGate, runner: async () => ({ result: { data: [{ id: 'lvecpu', usage: 88, maximum: 100 }] } }) });
  assert.equal(local.configured, true);
  await local.tick();
  assert.equal(localGate.capacity, 20);
  // Le direct ne prend que la moitié des connexions du compte : le reste du site répond toujours.
  const events = { maxClients: 2000 };
  await new HostLoad({ cpanel: { local: true }, gate: new Gate(), events, runner: async () => lune }).tick();
  assert.equal(events.maxClients, 40);
});

test('priorité : licence ouverte et tickets du mois dans ce que couvre le soutien', async () => {
  let scans = 400;
  const plans = new Plans({ config: { publicDir }, store: { lotStats: async () => [{ scan: scans }] }, accounts: {} });
  const year = Date.now() + 365 * 86_400_000;
  const supporter = { id: 's', lots: [1], premiumUntil: year, support: 1, supportUntil: year }; // 1 € par mois
  assert.equal(await plans.allowance(1), 500);
  assert.equal(await plans.allowance(0.25), 125);
  assert.equal(await plans.allowance(15), null); // sans limite
  assert.equal(await plans.prioritized(supporter), true); // 400 tickets sur 500
  scans = 900;
  assert.equal(await plans.prioritized({ ...supporter, id: 's2' }), false); // au-delà : sans priorité, jamais bloqué
  assert.equal(await plans.prioritized({ id: 'ancien', lots: [1], premiumUntil: year }), true); // licence d'avant : sans limite
  assert.equal(await plans.prioritized({ id: 'gratuit', lots: [1], premiumUntil: 0 }), false);
});
