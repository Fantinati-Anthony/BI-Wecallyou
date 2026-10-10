// Bulletin de santé du service, mois par mois, en chiffres anonymes (aucune adresse, aucun ticket,
// aucun compte) : charge de l'hébergement (la plus haute et la moyenne, mesurées une fois par
// minute), minutes où une limite a été touchée, demandes passées en priorité, pages envoyées vers la
// vérification toutes les 5 s faute de place en direct, et le plus de pages en direct à la fois.
import { promises as fs } from 'node:fs';
import path from 'node:path';

const month = (ms = Date.now()) => new Date(ms).toISOString().slice(0, 7);
const ADDED = ['samples', 'sum', 'limits', 'priority', 'full'];
const HIGHEST = ['peak', 'live'];
const empty = () => Object.fromEntries([...ADDED, ...HIGHEST].map((key) => [key, 0]));

export class Health {
  #pending = empty();
  #limited = false; // une limite touchée depuis la dernière minute
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

  /** Pages ouvertes en direct en ce moment. */
  live(count) {
    this.#pending.live = Math.max(this.#pending.live, count);
  }

  /** Chaque minute : compte la minute si une limite a été touchée, puis écrit le mois. */
  async minute() {
    if (this.#limited) this.#pending.limits++;
    this.#limited = false;
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
      await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
      await fs.writeFile(this.file(), JSON.stringify(stats), { mode: 0o600 });
    });
    return this.#writing;
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
