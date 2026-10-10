// Bulletin de santé du service, mois par mois, en chiffres anonymes (aucune adresse, aucun ticket,
// aucun compte) : charge de l'hébergement (la plus haute et la moyenne, mesurées une fois par
// minute), minutes où une limite a été touchée, demandes passées en priorité, pages envoyées vers la
// vérification toutes les 5 s faute de place en direct, le plus de pages en direct à la fois, et
// l'affluence réelle : une page de client ouverte relit son ticket toutes les 30 s, donc les
// lectures d'une minute divisées par deux donnent les clients qui attendent page ouverte ; les
// minutes où au moins un client attend font les heures d'affluence.
import { promises as fs } from 'node:fs';
import path from 'node:path';

const month = (ms = Date.now()) => new Date(ms).toISOString().slice(0, 7);
const ADDED = ['samples', 'sum', 'limits', 'priority', 'full', 'busy'];
const HIGHEST = ['peak', 'live', 'pages', 'pagesQueues'];
const empty = () => Object.fromEntries([...ADDED, ...HIGHEST].map((key) => [key, 0]));
// Par jour (pour la courbe) : charge et affluence seulement.
const DAY_ADDED = ['samples', 'sum', 'busy'];
const DAY_HIGHEST = ['peak', 'pages'];
const emptyDay = () => Object.fromEntries([...DAY_ADDED, ...DAY_HIGHEST].map((key) => [key, 0]));

export class Health {
  #pending = empty();
  #limited = false; // une limite touchée depuis la dernière minute
  #reads = 0; // lectures de tickets depuis la dernière minute
  #reading = new Set(); // files de ces lectures (en mémoire seulement, pour les compter)
  #writing = Promise.resolve();

  constructor(dir) {
    this.dir = dir;
  }

  file(name = month()) {
    return path.join(this.dir, `${name}.json`);
  }

  /** Charge mesurée chez l'hébergeur (part de la limite la plus haute). */
  load(ratio) {
    this.#pending.samples++;
    this.#pending.sum += ratio;
    this.#pending.peak = Math.max(this.#pending.peak, ratio);
    if (ratio >= 0.75) this.#limited = true; // la porte se resserre : les soutiens passent devant
  }

  /** La porte d'entrée est pleine : les demandes attendent leur tour. */
  limit() {
    this.#limited = true;
  }

  /** Une demande d'une file prioritaire (soutien) est passée devant. */
  priority() {
    this.#pending.priority++;
  }

  /** Plus de place en direct : la page vérifiera toutes les 5 s. */
  full() {
    this.#pending.full++;
    this.#limited = true;
  }

  /** Une page de client a relu son ticket (toutes les 30 s tant qu'elle est ouverte). */
  read(lot) {
    this.#reads++;
    this.#reading.add(lot);
  }

  /** Pages ouvertes en direct en ce moment. */
  live(count) {
    this.#pending.live = Math.max(this.#pending.live, count);
  }

  /** Chaque minute : compte la minute si une limite a été touchée, puis écrit le mois. */
  async minute() {
    if (this.#limited) this.#pending.limits++;
    this.#limited = false;
    const pages = Math.round(this.#reads / 2);
    if (pages > 0) this.#pending.busy++;
    if (pages > this.#pending.pages) {
      this.#pending.pages = pages;
      this.#pending.pagesQueues = this.#reading.size;
    }
    this.#reads = 0;
    this.#reading.clear();
    await this.flush();
  }

  /** Ajoute ce qui a été vu au fichier du mois (plusieurs processus peuvent écrire tour à tour). */
  flush() {
    const delta = this.#pending;
    this.#pending = empty();
    // Une écriture ratée (disque plein…) ne bloque pas les suivantes.
    this.#writing = this.#writing.catch(() => {}).then(async () => {
      const stats = await this.#read(month());
      for (const key of ADDED) stats[key] += delta[key];
      for (const key of HIGHEST) stats[key] = Math.max(stats[key], delta[key]);
      // Le même compte, jour par jour : la courbe de charge depuis le lancement.
      const today = new Date().toISOString().slice(0, 10);
      const d = { ...emptyDay(), ...stats.days?.[today] };
      for (const key of DAY_ADDED) d[key] += delta[key];
      for (const key of DAY_HIGHEST) d[key] = Math.max(d[key], delta[key]);
      stats.days = { ...stats.days, [today]: d };
      await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
      await fs.writeFile(this.file(), JSON.stringify(stats), { mode: 0o600 });
    });
    return this.#writing;
  }

  /** Les derniers jours (au plus `days`), du plus ancien au plus récent : charge la plus haute et moyenne, affluence. */
  async history(days = 365) {
    await this.flush();
    const since = new Date(Date.now() - (days - 1) * 86_400_000).toISOString().slice(0, 10);
    const months = new Set();
    for (let t = Date.parse(`${since.slice(0, 7)}-01T00:00:00Z`); t <= Date.now(); t += 28 * 86_400_000) months.add(month(t));
    months.add(month());
    const out = [];
    for (const name of [...months].sort()) {
      for (const [day, d] of Object.entries((await this.#read(name)).days ?? {})) {
        if (day >= since && d.samples) out.push({ day, peak: Math.round(d.peak * 100) / 100, average: Math.round((d.sum / d.samples) * 100) / 100, pages: d.pages, busy: d.busy });
      }
    }
    return out.sort((a, b) => a.day.localeCompare(b.day));
  }

  /** Le mois en cours, avec ce qui n'est pas encore écrit. */
  async month() {
    await this.flush();
    return this.#read(month());
  }

  async #read(name) {
    try {
      return { ...empty(), ...JSON.parse(await fs.readFile(this.file(name), 'utf8')) };
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      return empty();
    }
  }
}
