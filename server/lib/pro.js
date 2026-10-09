import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { PRO_LIFETIMES } from './store.js';

const DAY = 86_400_000;
export const PRO_GRACE = 30 * DAY; // à la fin du Pro, les tickets longue durée déjà en cours vont à leur terme
export const STATS_DAYS = { free: 90, pro: 365 };

/** Paliers conseillés selon les tickets actifs (scannés) sur 30 jours : un ticket imprimé ne coûte rien. */
export const DEFAULT_TIERS = [
  { upTo: 500, month: 1 },
  { upTo: 5000, month: 3 },
  { upTo: 20000, month: 8 },
  { upTo: null, month: 15 },
];

/**
 * Offre Pro (abonnement, distinct du don) : marque masquée, tickets jusqu'à 30 jours, statistiques
 * sur un an et export, priorité en affluence. Tout le code reste public : une installation
 * indépendante peut tout débloquer pour tout le monde (`allPro` dans config.json).
 */
export class Plans {
  #tiers = null;

  constructor({ config, store, accounts }) {
    this.config = config;
    this.store = store;
    this.accounts = accounts;
  }

  /** Paliers publiés dans soutien.json (même source que la page affichée), sinon ceux par défaut. */
  async tiers() {
    if (!this.#tiers) {
      try {
        const support = JSON.parse(await readFile(path.join(this.config.publicDir, 'soutien.json'), 'utf8'));
        this.#tiers = support.pro?.tiers ?? DEFAULT_TIERS;
      } catch {
        this.#tiers = DEFAULT_TIERS;
      }
      setTimeout(() => (this.#tiers = null), 60_000).unref();
    }
    return this.#tiers;
  }

  /** Statut d'un lot : Pro, ou dans la marge qui suit la fin du Pro. */
  async status(lot) {
    if (this.config.allPro) return { pro: true, grace: true, until: null };
    const account = lot?.owner ? await this.accounts.get(lot.owner) : null;
    const until = account?.premiumUntil ?? 0;
    return { pro: until > Date.now(), grace: until + PRO_GRACE > Date.now(), until: until || null };
  }

  /** Durée de vie réellement appliquée : les durées Pro retombent à 48 h une fois la marge passée. */
  async lifetimeHours(lot, ttl) {
    if (!PRO_LIFETIMES.includes(ttl)) return ttl;
    return (await this.status(lot)).grace ? ttl : 48;
  }

  /** Tickets actifs (premier scan) sur 30 jours, tous les lots du compte confondus, et prix conseillé. */
  async usage(account) {
    let active = 0;
    for (const lot of account.lots ?? []) {
      for (const day of await this.store.lotStats(lot, 30)) active += day.scan ?? 0;
    }
    const tiers = await this.tiers();
    const tier = tiers.find((t) => t.upTo === null || active <= t.upTo) ?? tiers.at(-1);
    return { active, suggested: tier.month };
  }
}
