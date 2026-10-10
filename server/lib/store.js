import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, createHmac, randomBytes, randomInt } from 'node:crypto';

export const MAX_SUBS_PER_TICKET = 3;

/** Durée de vie d'un ticket à partir de son premier scan (réglable par lot, en heures). */
export const FREE_LIFETIMES = [1, 3, 6, 12, 24, 48];
export const PRO_LIFETIMES = [72, 168, 360, 720]; // 3, 7, 15 et 30 jours : lots Pro (pressing, SAV…)
export const LIFETIMES = [...FREE_LIFETIMES, ...PRO_LIFETIMES];
export const DEFAULT_LIFETIME = 6;

/** Événements du journal d'un ticket et compteur statistique correspondant. */
export const EVENTS = ['scan', 'sub', 'unsub', 'call', 'recall', 'push', 'send', 'seen'];

const DAY = 86_400_000;

/**
 * Une file vit en trois temps. À sa création, elle est à l'essai : tout marche, rien n'est compté.
 * Ouverte (scan de la fiche de démarrage), elle sert 24 h ; la première ouverture efface l'essai.
 * Puis elle est fermée jusqu'à ce qu'on la rouvre pour 24 h, sans rien effacer.
 */
export const OPEN_FOR = DAY;
export function lotState(lot, now = Date.now()) {
  if (!lot.opened) return 'test';
  return now < (lot.openUntil ?? 0) ? 'open' : 'closed';
}
const MAX_SERVICE_GAP = 20 * 60_000;
const GROUP_WINDOW = 3000;
const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const ignoreMissing = (err) => {
  if (err.code !== 'ENOENT') throw err;
};
const today = (ms = Date.now()) => new Date(ms).toISOString().slice(0, 10);

/**
 * Stockage en simples fichiers. Le serveur n'y garde jamais une coordonnée lisible.
 * Un ticket imprimé n'occupe rien : il n'existe ici qu'à partir de son premier scan,
 * et tout ce qui le concerne disparaît à la fin de sa durée de vie.
 *
 *   data/lots/<id>.json                lot : nom, canaux, clés PUBLIQUES, clés privées chiffrées
 *   data/keys/<vérificateur>           index « jeton du lot → id » (empreinte, pas le jeton)
 *   data/tickets/<lot>/<n>.log         journal du ticket (scan, inscription, appel…), sans donnée perso
 *   data/subs/<lot>/<n>/<id>           inscriptions : blocs chiffrés pour le seul lot (illisibles ici)
 *   data/calls/<lot>/<n>               heure d'appel d'un ticket
 *   data/stats/lots/<lot>/<jour>.json  statistiques anonymes du lot, gardées 90 jours
 *   data/stats/<AAAA-MM>.json          compteurs globaux (lots et tickets créés dans le mois)
 *   data/stats/total/<AAAA-MM>.json    totaux du mois, toutes files confondues (scans, appels, files actives)
 *   data/stats/health/<AAAA-MM>.json   bulletin de santé du mois (charge, limites, priorité), anonyme
 *   public/etat/<id>.txt               « prêt » : lu directement par la page client (secours)
 */
export class Store {
  #statusKey;
  #queueCache = new Map();
  #counted = new Map(); // lot → { at, value } : le lot compte-t-il (ouvert au moins une fois) ? gardé 1 min
  #votesWrite = Promise.resolve(); // les votes s'écrivent l'un après l'autre
  #pendingStats = new Map(); // « lot|jour » → compteurs à ajouter (écrits par lots toutes les 10 s)
  #flushing = Promise.resolve(); // une écriture des statistiques à la fois : aucun compteur perdu

  constructor({ dataDir, publicDir, etatDir, statusKey }) {
    this.dataDir = dataDir;
    this.lotsDir = path.join(dataDir, 'lots');
    this.keysDir = path.join(dataDir, 'keys');
    this.ticketsDir = path.join(dataDir, 'tickets');
    this.subsDir = path.join(dataDir, 'subs');
    this.callsDir = path.join(dataDir, 'calls');
    this.statsDir = path.join(dataDir, 'stats');
    this.lotStatsDir = path.join(dataDir, 'stats', 'lots');
    this.etatDir = etatDir ?? path.join(publicDir, 'etat');
    this.#statusKey = statusKey;
  }

  async init() {
    for (const dir of [this.lotsDir, this.keysDir, this.ticketsDir, this.subsDir, this.callsDir, this.lotStatsDir]) {
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    }
    await fs.mkdir(this.etatDir, { recursive: true });
    this.flushTimer = setInterval(() => this.flushStats().catch((err) => console.error('stats', err)), 10_000);
    this.flushTimer.unref();
  }

  /* ------------------------------------------------------ journal d'un ticket */

  logFile(lot, n) {
    return path.join(this.ticketsDir, String(lot), `${n}.log`);
  }

  /** Événements d'un ticket : [[horodatage, type, détail], …] (vide si le ticket n'est pas actif). */
  async events(lot, n) {
    let raw;
    try {
      raw = await fs.readFile(this.logFile(lot, n), 'utf8');
    } catch (err) {
      ignoreMissing(err);
      return [];
    }
    return raw
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [at, type, detail = ''] = line.split(' ');
        return [Number(at), type, detail];
      });
  }

  /** Ajoute un événement au journal (le premier active le ticket) et compte la statistique (pas à l'essai). */
  async event(lot, n, type, detail = '') {
    if (!EVENTS.includes(type) || !/^[a-z]{0,8}$/.test(detail)) throw new Error(`événement invalide : ${type}`);
    await fs.mkdir(path.join(this.ticketsDir, String(lot)), { recursive: true, mode: 0o700 });
    await fs.appendFile(this.logFile(lot, n), `${Date.now()} ${type} ${detail}\n`, { mode: 0o600 });
    if (await this.counts(lot)) this.count(lot, detail ? `${type}_${detail}` : type);
  }

  /** Les statistiques ne comptent que les files ouvertes au moins une fois (l'essai ne compte pas). */
  async counts(lot) {
    const cached = this.#counted.get(lot);
    if (cached && Date.now() - cached.at < 60_000) return cached.value;
    const value = Boolean((await this.lot(lot))?.opened);
    this.#counted.set(lot, { at: Date.now(), value });
    return value;
  }

  /**
   * Fin de l'essai : tickets, numéros de l'affiche, inscriptions, appels, états « prêt » et
   * statistiques du lot effacés. Le lot lui-même (nom, réglages, clés) ne change pas.
   */
  async resetLot(lot) {
    const dirs = [this.ticketsDir, this.subsDir, this.callsDir].map((dir) => path.join(dir, String(lot)));
    const numbers = new Set();
    for (const dir of dirs) {
      for (const name of await fs.readdir(dir).catch(() => [])) numbers.add(Number.parseInt(name, 10));
    }
    for (const n of numbers) if (Number.isInteger(n)) await fs.rm(this.statusFile(this.statusId(lot, n)), { force: true });
    for (const dir of [...dirs, path.join(this.lotStatsDir, String(lot))]) await fs.rm(dir, { recursive: true, force: true });
    for (const key of this.#pendingStats.keys()) if (key.startsWith(`${lot}|`)) this.#pendingStats.delete(key);
    this.forgetQueue(lot);
  }

  /** Suppression d'une file et de tout ce qui la concerne. */
  async dropLot(lot) {
    await this.resetLot(lot.id);
    await fs.rm(path.join(this.keysDir, lot.verifier), { force: true });
    await fs.rm(this.lotFile(lot.id), { force: true });
    this.#counted.delete(lot.id);
  }

  /**
   * Réserve un numéro pour l'affiche : création exclusive d'un fichier, sûre même si plusieurs
   * processus du serveur répondent en même temps. false si le numéro est déjà pris.
   */
  async claimNumber(lot, n) {
    await fs.mkdir(path.join(this.ticketsDir, String(lot)), { recursive: true, mode: 0o700 });
    try {
      const handle = await fs.open(path.join(this.ticketsDir, String(lot), `${n}.claim`), 'wx', 0o600);
      await handle.close();
      return true;
    } catch (err) {
      if (err.code === 'EEXIST') return false;
      throw err;
    }
  }

  async isActive(lot, n) {
    try {
      await fs.access(this.logFile(lot, n));
      return true;
    } catch {
      return false;
    }
  }

  /** Tickets actifs d'un lot avec leur journal (historique du jour dans l'espace commerçant). */
  async history(lot) {
    let names;
    try {
      names = await fs.readdir(path.join(this.ticketsDir, String(lot)));
    } catch (err) {
      ignoreMissing(err);
      return [];
    }
    const list = [];
    for (const name of names.filter((f) => f.endsWith('.log'))) {
      const n = Number(name.slice(0, -4));
      list.push({ n, events: await this.events(lot, n) });
    }
    return list.sort((a, b) => (b.events.at(-1)?.[0] ?? 0) - (a.events.at(-1)?.[0] ?? 0));
  }

  /** Fin de vie d'un ticket : journal, inscriptions, appel et fichier d'état disparaissent. */
  async forgetTicket(lot, n) {
    await fs.rm(this.logFile(lot, n), { force: true });
    await fs.rm(path.join(this.ticketsDir, String(lot), `${n}.claim`), { force: true }); // numéro d'affiche libéré
    await fs.rm(this.subsPath(lot, n), { recursive: true, force: true });
    await fs.rm(this.callFile(lot, n), { force: true });
    await fs.rm(this.statusFile(this.statusId(lot, n)), { force: true });
    this.forgetQueue(lot);
  }

  /* ------------------------------------------------- statistiques du lot */

  count(lot, key, value = 1) {
    const id = `${lot}|${today()}`;
    const pending = this.#pendingStats.get(id) ?? {};
    pending[key] = (pending[key] ?? 0) + value;
    this.#pendingStats.set(id, pending);
  }

  /** Totaux du service pour un mois (« 2026-10 ») : compteurs de toutes les files, et files actives. */
  totalsFile(month) {
    return path.join(this.statsDir, 'total', `${month}.json`);
  }

  flushStats() {
    this.#flushing = this.#flushing.catch(() => {}).then(() => this.#flushStats());
    return this.#flushing;
  }

  async #flushStats() {
    const batch = [...this.#pendingStats];
    this.#pendingStats.clear();
    const totals = new Map(); // mois → compteurs à ajouter
    for (const [id, delta] of batch) {
      const [lot, day] = id.split('|');
      const month = day.slice(0, 7);
      const dir = path.join(this.lotStatsDir, lot);
      const file = path.join(dir, `${day}.json`);
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      let stats = null;
      try {
        stats = JSON.parse(await fs.readFile(file, 'utf8'));
      } catch (err) {
        ignoreMissing(err);
      }
      const sum = totals.get(month) ?? {};
      totals.set(month, sum);
      // Premier jour d'activité de la file ce mois-ci : une file active de plus.
      if (!stats && !(await fs.readdir(dir)).some((name) => name.startsWith(month))) sum.queues = (sum.queues ?? 0) + 1;
      stats ??= {};
      for (const [key, value] of Object.entries(delta)) {
        stats[key] = (stats[key] ?? 0) + value;
        sum[key] = (sum[key] ?? 0) + value;
      }
      await fs.writeFile(file, JSON.stringify(stats), { mode: 0o600 });
    }
    for (const [month, delta] of totals) {
      const file = this.totalsFile(month);
      await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      const sum = await this.totals(month, false);
      for (const [key, value] of Object.entries(delta)) sum[key] = (sum[key] ?? 0) + value;
      await fs.writeFile(file, JSON.stringify(sum), { mode: 0o600 });
    }
  }

  /** Totaux d'un mois, après avoir écrit ce qui attend (sauf pendant l'écriture elle-même). */
  async totals(month, flush = true) {
    if (flush) await this.flushStats();
    try {
      return JSON.parse(await fs.readFile(this.totalsFile(month), 'utf8'));
    } catch (err) {
      ignoreMissing(err);
      return {};
    }
  }

  /** Statistiques des derniers jours : [{ day, …compteurs }], du plus récent au plus ancien. */
  async lotStats(lot, days = 30) {
    await this.flushStats();
    const out = [];
    for (let i = 0; i < days; i++) {
      const day = today(Date.now() - i * DAY);
      try {
        out.push({ day, ...JSON.parse(await fs.readFile(path.join(this.lotStatsDir, String(lot), `${day}.json`), 'utf8')) });
      } catch (err) {
        ignoreMissing(err);
      }
    }
    return out;
  }

  /** Nom du fichier d'état d'un ticket : impossible à deviner sans la clé du serveur. */
  statusId(lot, n) {
    return createHmac('sha256', this.#statusKey).update(`etat|${lot}|${n}`).digest('hex').slice(0, 32);
  }

  statusFile(statusId) {
    return path.join(this.etatDir, `${statusId}.txt`);
  }

  /* ----------------------------------------------------------------- lots */

  lotFile(id) {
    return path.join(this.lotsDir, `${id}.json`);
  }

  async createLot(fields) {
    for (let attempt = 0; attempt < 20; attempt++) {
      const id = randomInt(1, 2 ** 31);
      const lot = { id, ...fields, created: Date.now() };
      try {
        await fs.writeFile(this.lotFile(id), JSON.stringify(lot), { flag: 'wx', mode: 0o600 });
      } catch (err) {
        if (err.code === 'EEXIST') continue;
        throw err;
      }
      try {
        await fs.writeFile(path.join(this.keysDir, fields.verifier), String(id), { flag: 'wx', mode: 0o600 });
      } catch (err) {
        await fs.unlink(this.lotFile(id));
        throw err;
      }
      return lot;
    }
    throw new Error('Impossible de trouver un identifiant de lot libre');
  }

  async lot(id) {
    try {
      return JSON.parse(await fs.readFile(this.lotFile(id), 'utf8'));
    } catch (err) {
      ignoreMissing(err);
      return null;
    }
  }

  /** Retrouve un lot à partir du jeton envoyé par le commerçant (dérivé de sa clé de lot). */
  async lotByAuth(authToken) {
    if (typeof authToken !== 'string' || !/^[\w-]{43}$/.test(authToken)) return null;
    let id;
    try {
      id = Number(await fs.readFile(path.join(this.keysDir, sha256(authToken)), 'utf8'));
    } catch (err) {
      ignoreMissing(err);
      return null;
    }
    const lot = await this.lot(id);
    if (lot) await this.#touch(this.lotFile(id));
    return lot;
  }

  async saveLot(lot) {
    this.#counted.set(lot.id, { at: Date.now(), value: Boolean(lot.opened) });
    const tmp =`${this.lotFile(lot.id)}.${randomBytes(4).toString('hex')}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(lot), { mode: 0o600 });
    await fs.rename(tmp, this.lotFile(lot.id));
  }

  /** La date de modification du fichier sert de « dernière utilisation » (lots inactifs effacés). */
  async #touch(file) {
    const stat = await fs.stat(file).catch(() => null);
    if (stat && Date.now() - stat.mtimeMs > DAY) {
      const now = new Date();
      await fs.utimes(file, now, now).catch(() => {});
    }
  }

  /* ---------------------------------------------------------- inscriptions */

  subsPath(lot, n) {
    return path.join(this.subsDir, String(lot), String(n));
  }

  /** Enregistre un bloc chiffré. Renvoie la clé d'annulation remise au client, ou null si complet. */
  async addSub(lot, n, blob) {
    const dir = this.subsPath(lot, n);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    if ((await fs.readdir(dir)).length >= MAX_SUBS_PER_TICKET) return null;
    const rid = randomBytes(16).toString('base64url');
    await fs.writeFile(path.join(dir, sha256(rid).slice(0, 32)), blob, { flag: 'wx', mode: 0o600 });
    return rid;
  }

  async removeSub(lot, n, rid) {
    if (typeof rid !== 'string' || !/^[\w-]{22}$/.test(rid)) return false;
    return this.dropSub(lot, n, sha256(rid).slice(0, 32));
  }

  async dropSub(lot, n, id) {
    if (typeof id !== 'string' || !/^[0-9a-f]{32}$/.test(id)) return false;
    try {
      await fs.unlink(path.join(this.subsPath(lot, n), id));
      return true;
    } catch (err) {
      ignoreMissing(err);
      return false;
    }
  }

  async subs(lot, n) {
    const dir = this.subsPath(lot, n);
    let names;
    try {
      names = await fs.readdir(dir);
    } catch (err) {
      ignoreMissing(err);
      return [];
    }
    const subs = [];
    for (const id of names) {
      try {
        const file = path.join(dir, id);
        const [blob, stat] = await Promise.all([fs.readFile(file, 'utf8'), fs.stat(file)]);
        subs.push({ id, blob, at: Math.round(stat.mtimeMs) });
      } catch (err) {
        ignoreMissing(err); // effacé entre-temps par la purge
      }
    }
    return subs.sort((a, b) => a.at - b.at);
  }

  /** Tickets d'un lot ayant au moins une inscription, avec leurs blocs chiffrés. */
  async waiting(lot) {
    let numbers;
    try {
      numbers = await fs.readdir(path.join(this.subsDir, String(lot)));
    } catch (err) {
      ignoreMissing(err);
      return [];
    }
    const list = [];
    for (const name of numbers) {
      const n = Number(name);
      const subs = await this.subs(lot, n);
      if (subs.length === 0) continue;
      list.push({ n, subs, calledAt: await this.calledAt(lot, n) });
    }
    return list.sort((a, b) => a.subs[0].at - b.subs[0].at);
  }

  /* ----------------------------------------------------------------- appels */

  callFile(lot, n) {
    return path.join(this.callsDir, String(lot), String(n));
  }

  async calledAt(lot, n) {
    try {
      return Math.round((await fs.stat(this.callFile(lot, n))).mtimeMs);
    } catch (err) {
      ignoreMissing(err);
      return null;
    }
  }

  /**
   * Marque le ticket comme appelé et publie le fichier d'état. Renvoie l'heure d'un appel précédent.
   * `info` = { m: message envoyé, tag: repère court pour l'écran (ex. « Terrain 3 ») } : du texte
   * écrit par le commerçant, jamais une donnée de client.
   */
  async call(lot, n, info = {}) {
    const previous = await this.calledAt(lot, n);
    await fs.mkdir(path.dirname(this.callFile(lot, n)), { recursive: true, mode: 0o700 });
    await fs.writeFile(this.callFile(lot, n), JSON.stringify(info), { mode: 0o600 }); // date du fichier = heure de l'appel
    await fs.writeFile(this.statusFile(this.statusId(lot, n)), 'pret');
    this.forgetQueue(lot);
    return previous;
  }

  /** Message et repère de l'appel d'un ticket ({} s'il n'en a pas, null s'il n'est pas appelé). */
  async callInfo(lot, n) {
    try {
      const raw = await fs.readFile(this.callFile(lot, n), 'utf8');
      return raw ? JSON.parse(raw) : {};
    } catch (err) {
      if (err instanceof SyntaxError) return {};
      ignoreMissing(err);
      return null;
    }
  }

  /**
   * Rythme des appels d'un lot (aucune donnée personnelle) : dernier numéro appelé, derniers appels
   * et intervalle moyen entre deux appels, d'où la position et l'attente estimée des clients.
   * Gardé 2 s en mémoire : des centaines de pages ouvertes ne relisent pas le disque à chaque fois.
   */
  async queue(lot) {
    const cached = this.#queueCache.get(lot);
    if (cached && Date.now() - cached.at < 2000) return cached.value;
    const dir = path.join(this.callsDir, String(lot));
    let names = [];
    try {
      names = await fs.readdir(dir);
    } catch (err) {
      ignoreMissing(err);
    }
    const calls = [];
    for (const name of names) {
      const stat = await fs.stat(path.join(dir, name)).catch(() => null);
      if (stat) calls.push({ n: Number(name), at: Math.round(stat.mtimeMs) });
    }
    calls.sort((a, b) => b.at - a.at);
    // Un appel de groupe (plusieurs tickets à la seconde) compte pour un seul passage.
    const moments = calls.filter((c, i) => i === 0 || calls[i - 1].at - c.at > GROUP_WINDOW);
    const intervals = [];
    for (let i = 0; i + 1 < moments.length && intervals.length < 10; i++) {
      const gap = moments[i].at - moments[i + 1].at;
      if (gap <= MAX_SERVICE_GAP) intervals.push(gap); // une pause (> 20 min) ne fausse pas la moyenne
    }
    const recent = calls.slice(0, 30);
    for (const call of recent) {
      const info = (await this.callInfo(lot, call.n)) ?? {};
      call.tag = info.tag ?? '';
      call.batch = info.b ?? '';
    }
    const value = {
      last: calls[0] ?? null,
      recent,
      calls: calls.length,
      avgMs: intervals.length >= 2 ? Math.round(intervals.reduce((a, b) => a + b, 0) / intervals.length) : null,
    };
    this.#queueCache.set(lot, { at: Date.now(), value });
    return value;
  }

  forgetQueue(lot) {
    this.#queueCache.delete(lot);
  }

  /* ------------------------------------------------------ compteurs globaux */

  statsFile(date = new Date()) {
    return path.join(this.statsDir, `${date.toISOString().slice(0, 7)}.json`);
  }

  async stats() {
    try {
      return JSON.parse(await fs.readFile(this.statsFile(), 'utf8'));
    } catch (err) {
      ignoreMissing(err);
      return { lots: 0, tickets: 0 };
    }
  }

  async countLot(tickets) {
    const stats = await this.stats();
    stats.lots += 1;
    stats.tickets += tickets;
    await fs.writeFile(this.statsFile(), JSON.stringify(stats));
  }

  async countTickets(tickets) {
    const stats = await this.stats();
    stats.tickets += tickets;
    await fs.writeFile(this.statsFile(), JSON.stringify(stats));
  }

  /* ------------------------------------------- votes (« Votez pour la suite ») */

  get votesFile() {
    return path.join(this.dataDir, 'votes.json');
  }

  /** Les voix de chaque compte : { identifiant du compte : [idées] }. */
  async votes() {
    try {
      return JSON.parse(await fs.readFile(this.votesFile, 'utf8'));
    } catch (err) {
      ignoreMissing(err);
      return {};
    }
  }

  /** Change les voix d'un compte (change(anciennes) → nouvelles), une écriture à la fois ; rend toutes les voix. */
  updateVotes(account, change) {
    const run = this.#votesWrite.then(async () => {
      const all = await this.votes();
      const next = change(all[account] ?? []);
      if (next.length) all[account] = next;
      else delete all[account];
      const tmp = `${this.votesFile}.${randomBytes(4).toString('hex')}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(all), { mode: 0o600 });
      await fs.rename(tmp, this.votesFile);
      return all;
    });
    this.#votesWrite = run.catch(() => {});
    return run;
  }
}
