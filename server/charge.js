// Test de charge de WeCall.You, sans dépendance.
//
//   node charge.js                       en local : lance un serveur à part, simule des clients qui
//                                        attendent (page ouverte, connexion en direct) et des appels,
//                                        palier par palier, et mesure ce qu'un seul cœur encaisse.
//   node charge.js --site https://…      sur le vrai site, une vraie journée en accéléré : 3 snacks
//     [--snacks 3] [--clients 50]        de 50 clients (réglable) arrivent en une minute et attendent
//     [--minutes 3]                      3 min, avec exactement les requêtes des vraies pages ; mesure
//                                        les temps de réponse et la charge de l'hébergement. Rien
//                                        n'est créé, et le test refuse de tourner si le site ne
//                                        limite pas le direct.
//
// Résultat : un tableau et une conclusion.
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
      etatDir: path.join(tmp, 'etat'),
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

/** Ticket au bon format mais inconnu : le serveur fait le même chemin et répond « invalide », sans rien écrire. */
const fakeToken = () => Array.from({ length: 26 }, () => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'[randomInt(32)]).join('');
const fakeStatus = () => randomBytes(16).toString('hex');
const KINDS = [
  ['page', 'Arrivée : page du ticket (Apache)'],
  ['ticket', 'Ticket et place dans la file (Node)'],
  ['etat', 'Vérification toutes les 5 s (Apache)'],
  ['shop', 'Page du commerçant (Node)'],
];

async function scenario(site, snacks, perSnack, minutes) {
  if (!/^https?:\/\/[^/]+$/.test(site ?? '') || !(snacks >= 1) || !(perSnack >= 1) || !(minutes > 0)) {
    console.error('Usage : node charge.js --site https://wecall.you [--snacks 3] [--clients 50] [--minutes 3]');
    process.exit(1);
  }
  const api = `${site}/api`;
  const total = snacks * perSnack;
  const stats = new Map(KINDS.map(([kind]) => [kind, { times: [], failed: 0 }]));
  const loads = new Map(); // mesures de l'hébergement, une par minute : date → part de la limite la plus haute
  const timers = [];
  const conns = [];
  let polling = 0;

  /** Une requête comme celles des vraies pages ; `expected` : statuts normaux (404 = ticket inconnu ou pas encore appelé). */
  const hit = async (kind, url, expected = [200]) => {
    const t0 = now();
    const res = await fetch(url).catch(() => null);
    const body = res?.headers.get('content-type')?.includes('json') ? await res.json().catch(() => null) : await res?.arrayBuffer().catch(() => null);
    stats.get(kind).times.push(ms(t0));
    if (!res || !expected.includes(res.status)) stats.get(kind).failed++;
    if (body?.load) loads.set(body.load.at, body.load.ratio);
  };
  const all = () => [...stats.values()].reduce((sum, s) => ({ times: sum.times.concat(s.times), failed: sum.failed + s.failed }), { times: [], failed: 0 });

  // Sécurité : sans plafond du direct, des centaines de pages en direct prendraient toutes les
  // connexions de la lune et le site ne répondrait plus. On vérifie d'abord, sans danger (45 au plus).
  const check = [];
  for (let i = 0; i < 45; i++) {
    const live = liveConnection(`${api}/events/${fakeStatus()}`, {});
    check.push(live);
    if (!(await live.opened).ok) break;
  }
  const uncapped = check.filter((live) => live.open).length > 40;
  for (const live of check) live.close();
  if (uncapped) {
    console.error('\nLe site ne limite pas encore le direct : mettez la lune à jour (git pull, puis redémarrer l’application) avant ce test.\n');
    process.exit(1);
  }
  await pause(2000);

  console.log(`\n${snacks} snacks × ${perSnack} clients sur ${site} : les ${total} clients arrivent en une minute, puis attendent ${minutes} min.`);
  console.log('Chaque client fait comme la vraie page ; chaque commerçant rafraîchit la sienne toutes les 10 s.');
  console.log('Rien n’est créé : tickets et fichiers d’état sont inconnus du serveur, qui répond sans rien écrire.\n');

  const client = async () => {
    const token = fakeToken();
    const status = fakeStatus();
    await Promise.all([hit('page', `${site}/${token}`), hit('page', `${site}/assets/t.js`), hit('page', `${site}/assets/style.css`)]);
    await hit('ticket', `${api}/t/${token}`, [404]);
    const live = liveConnection(`${api}/events/${status}`, {});
    conns.push(live);
    if (!(await live.opened).ok) {
      // Direct plein : la page vérifie toutes les 5 s le fichier d'état (404 tant que le client n'est pas appelé).
      polling++;
      timers.push(setInterval(() => hit('etat', `${site}/etat/${status}.txt`, [200, 404]), 5000));
    }
    timers.push(setInterval(() => hit('ticket', `${api}/t/${token}`, [404]), 30_000));
  };

  const start = Date.now();
  const progress = setInterval(() => {
    const { times, failed } = all();
    const latest = [...loads.entries()].sort(([a], [b]) => b - a)[0]?.[1];
    console.log(`  ${Math.round((Date.now() - start) / 1000)} s : ${conns.length} clients (${conns.filter((c) => c.open).length} en direct, ${polling} toutes les 5 s), ${times.length} requêtes, ${failed} en échec, réponse ${fmt(pct(times, 95))} ms (95 %), charge ${latest === undefined ? '–' : `${Math.round(latest * 100)} %`}`);
  }, 20_000);
  try {
    for (let s = 0; s < snacks; s++) timers.push(setInterval(() => Promise.all([hit('shop', `${api}/info`), hit('shop', `${api}/info`)]), 10_000));
    const arrivals = [];
    for (let i = 0; i < total; i++) {
      arrivals.push(client());
      await pause(60_000 / total);
    }
    await Promise.all(arrivals);
    const hold = Date.now();
    while (Date.now() - hold < minutes * 60_000) {
      await pause(1000);
      const { times, failed } = all();
      if (times.length >= 100 && failed / times.length > 0.02) break; // ça décroche : on arrête tout de suite
    }
  } finally {
    clearInterval(progress);
    for (const timer of timers) clearInterval(timer);
    for (const conn of conns) conn.close();
  }

  console.log('');
  table(
    KINDS.map(([kind, title]) => {
      const { times, failed } = stats.get(kind);
      return { title, count: times.length, p50: fmt(pct(times, 50)), p95: fmt(pct(times, 95)), failed };
    }),
    [['title', 'Requêtes'], ['count', 'Nombre'], ['p50', 'Réponse (ms, médiane)'], ['p95', 'Réponse (ms, 95 %)'], ['failed', 'En échec']],
  );
  const { times, failed } = all();
  const measured = [...loads.entries()].filter(([at]) => at > start + 60_000).map(([, ratio]) => ratio);
  const peak = measured.length ? Math.max(...measured) : null;
  console.log(`\nCharge de l’hébergement pendant l’attente : ${measured.length ? measured.map((r) => `${Math.round(r * 100)} %`).join(', ') : 'non mesurée'}`);
  console.log(`(la plus haute des limites de la lune : connexions, processeur, mémoire… le détail est dans cPanel › Utilisation des ressources)`);
  const holds = failed / Math.max(1, times.length) <= 0.01 && pct(times, 95) <= 1000 && (peak ?? 0) < 0.75;
  console.log(`\nVerdict : ${holds ? 'la lune tient' : 'la lune peine'} avec ${snacks} snacks × ${perSnack} clients : ${times.length} requêtes, ${failed} en échec, réponse en ${fmt(pct(times, 95))} ms (95 %), charge la plus haute ${peak === null ? '–' : `${Math.round(peak * 100)} %`}.`);
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
  const opt = (name, fallback) => (args.includes(`--${name}`) ? Number(args[args.indexOf(`--${name}`) + 1]) : fallback);
  await scenario(args[args.indexOf('--site') + 1], opt('snacks', 3), opt('clients', 50), opt('minutes', 3));
} else {
  await benchLocal();
}
