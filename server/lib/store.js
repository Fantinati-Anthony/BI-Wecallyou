import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, createHmac, randomBytes, randomInt } from 'node:crypto';

export const MAX_SUBS_PER_TICKET = 3;

/** Durée de vie d'un ticket à partir de son premier scan (réglable par lot, en heures). */
export const LIFETIMES = [1, 3, 6, 12, 24, 48];
export const DEFAULT_LIFETIME = 6;

/** Événements du journal d'un ticket et compteur statistique correspondant. */
export const EVENTS = ['scan', 'sub', 'unsub', 'call', 'recall', 'push', 'send', 'seen'];

const DAY = 86_400_000;
const MAX_SERVICE_GAP = 20 * 60_000;
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
 *   public/etat/<id>.txt               « prêt » : lu directement par la page client (secours)
 */
export class Store {
  #statusKey;
  #queueCache = new Map();
  #pendingStats = new Map(); // « lot|jour » → compteurs à ajouter (écrits par lots toutes les 10 s)

  constructor({ dataDir, publicDir, statusKey }) {
    this.dataDir = dataDir;
    this.lotsDir = path.join(dataDir, 'lots');
    this.keysDir = path.join(dataDir, 'keys');
    this.ticketsDir = path.join(dataDir, 'tickets');
    this.subsDir = path.join(dataDir, 'subs');
    this.callsDir = path.join(dataDir, 'calls');
    this.statsDir = path.join(dataDir, 'stats');
    this.lotStatsDir = path.join(dataDir, 'stats', 'lots');
    this.etatDir = path.join(publicDir, 'etat');
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

  /** Ajoute un événement au journal (le premier active le ticket) et compte la statistique. */
  async event(lot, n, type, detail = '') {
    if (!EVENTS.includes(type) || !/^[a-z]{0,8}$/.test(detail)) throw new Error(`événement invalide : ${type}`);
    await fs.mkdir(path.join(this.ticketsDir, String(lot)), { recursive: true, mode: 0o700 });
    await fs.appendFile(this.logFile(lot, n), `${Date.now()} ${type} ${detail}\n`, { mode: 0o600 });
    this.count(lot, detail ? `${type}_${detail}` : type);
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

  async flushStats() {
    const batch = [...this.#pendingStats];
    this.#pendingStats.clear();
    for (const [id, delta] of batch) {
      const [lot, day] = id.split('|');
      const dir = path.join(this.lotStatsDir, lot);
      const file = path.join(dir, `${day}.json`);
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      let stats = {};
      try {
        stats = JSON.parse(await fs.readFile(file, 'utf8'));
      } catch (err) {
        ignoreMissing(err);
      }
      for (const [key, value] of Object.entries(delta)) stats[key] = (stats[key] ?? 0) + value;
      await fs.writeFile(file, JSON.stringify(stats), { mode: 0o600 });
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
    const tmp = `${this.lotFile(lot.id)}.${randomBytes(4).toString('hex')}.tmp`;
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

  /** Marque le ticket comme appelé et publie le fichier d'état. Renvoie l'heure d'un appel précédent. */
  async call(lot, n) {
    const previous = await this.calledAt(lot, n);
    await fs.mkdir(path.dirname(this.callFile(lot, n)), { recursive: true, mode: 0o700 });
    await fs.writeFile(this.callFile(lot, n), ''); // la date du fichier = l'heure de l'appel
    await fs.writeFile(this.statusFile(this.statusId(lot, n)), 'pret');
    this.forgetQueue(lot);
    return previous;
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
    const intervals = [];
    for (let i = 0; i + 1 < calls.length && intervals.length < 10; i++) {
      const gap = calls[i].at - calls[i + 1].at;
      if (gap <= MAX_SERVICE_GAP) intervals.push(gap); // une pause (> 20 min) ne fausse pas la moyenne
    }
    const value = {
      last: calls[0] ?? null,
      recent: calls.slice(0, 6).map((c) => c.n),
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
}
