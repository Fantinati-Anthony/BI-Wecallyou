// Test de charge de WeCall.You, sans dépendance.
//
//   node charge.js                       en local : lance un serveur à part, simule des clients qui
//                                        attendent (page ouverte, connexion en direct) et des appels,
//                                        palier par palier, et mesure ce qu'un seul cœur encaisse.
//   node charge.js --site https://…      sur le vrai site, en douceur : ouvre des connexions en direct
//                                        par paliers (sans créer de file, de ticket ni de donnée),
//                                        mesure les temps de réponse et la charge de l'hébergement,
//                                        et s'arrête à la première erreur.
//
// Résultat : un tableau par palier (clients en direct, temps de réponse, délai d'appel, erreurs,
// processeur, mémoire) et une conclusion.
import { fork } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes, randomInt } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);

/* ------------------------------------------------------------------------------ outils */

const ms = (start) => Number(process.hrtime.bigint() - start) / 1e6;
const now = () => process.hrtime.bigint();
const pct = (values, p) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
};
const fmt = (v) => (v === null || v === undefined ? '–' : `${Math.round(v)}`);
const fakeIp = () => `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`;
const pause = (t) => new Promise((resolve) => setTimeout(resolve, t));

/** Lance `count` tâches avec au plus `width` en même temps. */
async function pool(count, width, task) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(width, count) }, async () => {
      while (next < count) await task(next++);
    }),
  );
}

/**
 * Connexion en direct (comme la page d'un client) : opened se résout à l'ouverture ou au refus,
 * open dit si elle tient encore, onEvent est appelé à l'arrivée de l'appel, close() la ferme.
 */
function liveConnection(url, headers, onEvent) {
  const controller = new AbortController();
  const live = { open: false, close: () => controller.abort() };
  live.opened = fetch(url, { headers: { Accept: 'text/event-stream', ...headers }, signal: controller.signal })
    .then(async (res) => {
      if (!res.ok || !res.headers.get('content-type')?.includes('text/event-stream')) {
        await res.body?.cancel().catch(() => {});
        return { ok: false, status: res.status };
      }
      live.open = true;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      (async () => {
        let buffer = '';
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            if (buffer.includes('event: ready')) {
              onEvent?.();
              buffer = '';
            }
          }
        } catch {
          // fermée par nous ou par le serveur
        }
        live.open = false;
      })();
      return { ok: true, status: res.status };
    })
    .catch(() => ({ ok: false, status: 0 }));
  return live;
}

function table(rows, columns) {
  const widths = columns.map(([key, title]) => Math.max(title.length, ...rows.map((row) => String(row[key]).length)));
  const line = (cells) => cells.map((cell, i) => String(cell).padStart(widths[i])).join('  ');
  console.log(line(columns.map(([, title]) => title)));
  for (const row of rows) console.log(line(columns.map(([key]) => row[key])));
}

/* ---------------------------------------------------------------------------- en local */

async function benchLocal() {
  const wc = await import('../public/assets/crypto.js');
  const tmp = mkdtempSync(path.join(tmpdir(), 'wcy-charge-'));
  const port = randomInt(40000, 50000);
  const configFile = path.join(tmp, 'config.json');
  writeFileSync(
    configFile,
    JSON.stringify({
      domain: `localhost:${port}`,
      brand: 'WeCall.You',
      contact: 'mailto:test@example.org',
      dataDir: path.join(tmp, 'data'),
      publicDir: path.resolve(HERE, '../public'),
      serveStatic: false,
      basePath: '/api',
      port,
      tokenKey: randomBytes(16).toString('hex'),
      statusKey: randomBytes(32).toString('hex'),
    }),
  );
  const child = fork(fileURLToPath(import.meta.url), ['--serve'], { env: { ...process.env, TN_CONFIG: configFile }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  const stats = () => new Promise((resolve) => {
    child.once('message', resolve);
    child.send('stats');
  });
  const base = `http://127.0.0.1:${port}/api`;
  try {
    for (let i = 0; i < 100; i++) {
      if (await fetch(`${base}/info`).then((r) => r.ok).catch(() => false)) break;
      await pause(100);
    }
    const STEPS = [100, 250, 500, 1000, 1600]; // au-delà de 1 600 (80 % de 2 000), le direct est gardé aux files prioritaires
    const total = STEPS.at(-1);
    // Une file de test, et ses tickets (par cahiers de 1 200).
    const lot = await wc.createLot();
    const made = await (await fetch(`${base}/lots`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Test de charge', channels: ['push'], from: 1, to: total, ...lot.request }) })).json();
    if (!made.ok) throw new Error(`création de la file : ${made.error}`);
    const auth = { Authorization: `Lot ${lot.authToken}`, 'Content-Type': 'application/json' };
    const tickets = [];
    for (let from = 1; from <= total; from += 1200) {
      const res = await (await fetch(`${base}/lot/tickets`, { method: 'POST', headers: auth, body: JSON.stringify({ from, to: Math.min(total, from + 1199) }) })).json();
      tickets.push(...res.tickets);
    }

    console.log(`\nTest de charge en local : un processus Node (${process.version}), jusqu'à ${total} clients en direct.\n`);
    const clients = []; // { n, close, calledAt, eventAt }
    const rows = [];
    for (const step of STEPS) {
      // 1. De nouveaux clients arrivent : ils ouvrent leur ticket, puis gardent la page ouverte.
      const pageTimes = [];
      let errors = 0;
      const start = clients.length;
      const before = await stats();
      const stepStart = now();
      await pool(step - start, 50, async (i) => {
        const ticket = tickets[start + i];
        const ip = fakeIp(); // chaque client a sa propre adresse, comme dans la vraie vie
        const t0 = now();
        const res = await fetch(`${base}/t/${ticket.c}`, { headers: { 'X-Forwarded-For': ip } }).catch(() => null);
        const data = res?.ok ? await res.json() : null;
        pageTimes.push(ms(t0));
        if (!data?.ok) return void errors++;
        const client = { n: ticket.n, calledAt: null, eventAt: null };
        const live = liveConnection(`${base}/events/${data.status}`, { 'X-Forwarded-For': ip }, () => (client.eventAt ??= now()));
        client.close = live.close;
        if (!(await live.opened).ok) errors++;
        clients.push(client);
      });
      // 2. Le commerçant appelle 20 clients, deux par seconde : délai jusqu'à leur téléphone.
      const callTimes = [];
      const waiting = clients.filter((c) => !c.calledAt);
      const called = [];
      for (let i = 0; i < 20 && waiting.length; i++) {
        const client = waiting.splice(randomInt(waiting.length), 1)[0];
        client.calledAt = now();
        const t0 = now();
        const res = await fetch(`${base}/call`, { method: 'POST', headers: auth, body: JSON.stringify({ n: client.n }) }).catch(() => null);
        callTimes.push(ms(t0));
        if (!res?.ok) errors++;
        called.push(client);
        await pause(500);
      }
      await pause(1500);
      const delays = called.map((c) => (c.eventAt ? Number(c.eventAt - c.calledAt) / 1e6 : null));
      const missed = delays.filter((d) => d === null).length;
      const after = await stats();
      const wall = ms(stepStart) * 1000; // en microsecondes, comme cpuUsage
      const cpu = ((after.cpu.user - before.cpu.user + after.cpu.system - before.cpu.system) / wall) * 100;
      rows.push({
        clients: clients.length,
        page50: fmt(pct(pageTimes, 50)),
        page95: fmt(pct(pageTimes, 95)),
        call95: fmt(pct(callTimes, 95)),
        event95: fmt(pct(delays.filter((d) => d !== null), 95)),
        errors: errors + missed,
        cpu: `${Math.round(cpu)} %`,
        rss: `${Math.round(after.rss / 1048576)} Mo`,
      });
      if (errors + missed > step * 0.01 || pct(pageTimes, 95) > 1000) break; // ça décroche : on s'arrête
    }
    table(rows, [
      ['clients', 'Clients en direct'],
      ['page50', 'Page ticket (ms, médiane)'],
      ['page95', 'Page ticket (ms, 95 %)'],
      ['call95', 'Appel (ms, 95 %)'],
      ['event95', 'Appel → téléphone (ms, 95 %)'],
      ['errors', 'Erreurs'],
      ['cpu', 'Processeur'],
      ['rss', 'Mémoire'],
    ]);
    const last = rows.at(-1);
    console.log(`\nConclusion : ${last.clients} clients en direct tenus par un seul processus, appel reçu en ${last.event95} ms (95 %), ${last.errors} erreur(s).`);
    console.log('Le processeur indique la part d’un cœur utilisée pendant le palier (arrivées et appels compris).\n');
    for (const client of clients) client.close?.();
  } finally {
    child.kill();
    await pause(200);
    rmSync(tmp, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------------- sur le vrai site */

async function probeSite(site) {
  if (!/^https?:\/\/[^/]+$/.test(site ?? '')) {
    console.error('Usage : node charge.js --site https://wecall.you');
    process.exit(1);
  }
  const base = `${site}/api`;
  const STEPS = [10, 25, 50, 80, 120, 200, 300];
  const conns = [];
  const rows = [];
  console.log(`\nTest en douceur de ${site} : connexions en direct par paliers (environ une minute chacun),`);
  console.log('sans aucune donnée créée. Arrêt au premier signe de fatigue.\n');
  try {
    for (const step of STEPS) {
      let refused = 0;
      const statuses = new Set();
      await pool(step - conns.length, 10, async () => {
        // Une connexion en direct comme celle d'une page de client (identifiant au hasard : rien n'est écrit).
        const live = liveConnection(`${base}/events/${randomBytes(16).toString('hex')}`, {});
        conns.push(live);
        const result = await live.opened;
        if (!result.ok) {
          refused++;
          statuses.add(result.status);
        }
      });
      // Temps de réponse d'une requête ordinaire pendant que les connexions sont ouvertes, jusqu'à
      // une mesure de charge prise avec elles (l'hébergement n'est relu qu'une fois par minute).
      const reached = Date.now();
      const times = [];
      let failed = 0;
      let load = null;
      for (;;) {
        const t0 = now();
        const info = await fetch(`${base}/info`).then((res) => (res.ok ? res.json() : null)).catch(() => null);
        times.push(ms(t0));
        if (!info) failed++;
        const fresh = info?.load && info.load.at > reached;
        if (fresh) load = info.load.ratio;
        if (times.length >= 5 && (fresh || !info?.load || Date.now() - reached > 75_000)) break;
        await pause(3000);
      }
      const held = conns.filter((conn) => conn.open).length;
      const row = {
        live: step,
        held,
        refused: `${refused}${statuses.size ? ` (${[...statuses].join(', ')})` : ''}`,
        p50: fmt(pct(times, 50)),
        p95: fmt(pct(times, 95)),
        failed,
        load: load === null ? '–' : `${Math.round(load * 100)} %`,
      };
      rows.push(row);
      console.log(`  ${step} : ${held} tenues, réponse ${row.p95} ms, charge ${row.load}`);
      if (refused || held < step || failed || pct(times, 95) > 1500 || (load ?? 0) >= 0.75) break;
    }
  } finally {
    for (const conn of conns) conn.close();
  }
  console.log('');
  table(rows, [
    ['live', 'Connexions demandées'],
    ['held', 'Tenues'],
    ['refused', 'Refusées'],
    ['p50', 'Réponse (ms, médiane)'],
    ['p95', 'Réponse (ms, 95 %)'],
    ['failed', 'Requêtes en échec'],
    ['load', 'Charge de l’hébergement'],
  ]);
  const last = rows.at(-1);
  console.log(`\nConclusion : ${last.held} connexions en direct tenues sur ${last.live}, réponse en ${last.p95} ms (95 %), charge ${last.load}.`);
  console.log('Toutes les connexions sont fermées. Aucune file, aucun ticket, aucune donnée n’a été créé.\n');
}

/* ------------------------------------------------------- serveur à mesurer (processus à part) */

if (args.includes('--serve')) {
  // Le vrai serveur, plus de quoi rendre compte de son processeur et de sa mémoire.
  process.on('message', (message) => {
    if (message === 'stats') process.send({ cpu: process.cpuUsage(), rss: process.memoryUsage().rss });
  });
  await import('./start.js');
} else if (args.includes('--site')) {
  await probeSite(args[args.indexOf('--site') + 1]);
} else {
  await benchLocal();
}
