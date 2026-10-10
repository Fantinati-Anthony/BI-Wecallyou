import fs from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_LIFETIME, LIFETIMES } from './store.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const RETENTION = Object.freeze({
  contactAfterCall: 30 * MINUTE, // une coordonnée sert encore 30 min après l'appel (rappel possible), pas plus
  orphan: 31 * DAY, // filet de sécurité : rien ne dépasse la plus longue durée de vie (30 jours, Pro)
  stats: 90 * DAY, // statistiques anonymes du lot (gratuit)
  statsPro: 365 * DAY, // statistiques anonymes du lot (Pro)
  lot: 400 * DAY, // un lot jamais réutilisé pendant 400 jours est supprimé
  closed: DAY, // sans abonnement, une file fermée depuis 24 h est supprimée avec tout ce qui la concerne
  unopened: 30 * DAY, // sans abonnement, une file jamais ouverte (essai) est supprimée 30 jours après sa création
});

async function list(dir) {
  try {
    return await fs.readdir(dir);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

async function age(file, now) {
  try {
    return now - (await fs.stat(file)).mtimeMs;
  } catch {
    return -1;
  }
}

const removeIfEmpty = (dir) => fs.rmdir(dir).catch(() => {});

/** Comptes inutilisés depuis 400 jours, et traces d'événements Stripe de plus de 30 jours. */
async function purgeAccounts(accounts, now, done) {
  for (const name of await list(accounts.eventsDir)) {
    if ((await age(path.join(accounts.eventsDir, name), now)) > 30 * DAY) await fs.rm(path.join(accounts.eventsDir, name), { force: true });
  }
  for (const name of await list(accounts.dir)) {
    if (!name.endsWith('.json')) continue;
    if ((await age(path.join(accounts.dir, name), now)) > RETENTION.lot) {
      const account = await accounts.get(name.slice(0, -5));
      if (account && !accounts.isPro(account)) {
        await accounts.remove(account);
        done.accounts++;
      }
    }
  }
}

/**
 * Efface tout ce qui a fait son temps. Lancé toutes les 10 minutes par le serveur (ou par cron).
 *  1. Les tickets arrivés en fin de vie (durée du lot, comptée depuis le premier scan).
 *  2. Les coordonnées chiffrées, 30 min après l'appel du ticket.
 *  3. Tout reste orphelin, les statistiques trop anciennes (90 jours, un an en Pro), les lots oubliés.
 * « plans » donne le statut Pro des lots (durées longues, statistiques sur un an).
 */
export async function purge(store, now = Date.now(), accounts = null, plans = null) {
  const done = { tickets: 0, contacts: 0, orphans: 0, stats: 0, lots: 0, accounts: 0 };
  if (accounts) await purgeAccounts(accounts, now, done);
  const lifetimes = new Map();
  /** Durée de vie appliquée au lot : une durée Pro retombe à 48 h une fois le Pro et sa marge finis. */
  const lifetimeOf = async (id) => {
    if (!lifetimes.has(id)) {
      const lot = await store.lot(id);
      const hours = LIFETIMES.includes(lot?.ttl) ? lot.ttl : DEFAULT_LIFETIME;
      lifetimes.set(id, (plans ? await plans.lifetimeHours(lot, hours) : Math.min(hours, 48)) * HOUR);
    }
    return lifetimes.get(id);
  };

  // 1. Fin de vie des tickets.
  for (const lot of await list(store.ticketsDir)) {
    for (const name of await list(path.join(store.ticketsDir, lot))) {
      if (!name.endsWith('.log')) continue;
      const n = Number(name.slice(0, -4));
      const first = (await store.events(Number(lot), n))[0]?.[0] ?? 0;
      if (now - first > (await lifetimeOf(Number(lot)))) {
        await store.forgetTicket(Number(lot), n);
        done.tickets++;
      }
    }
    await removeIfEmpty(path.join(store.ticketsDir, lot));
  }

  // 2. Coordonnées : effacées 30 min après l'appel, et jamais au-delà de la durée de vie du lot.
  for (const lot of await list(store.subsDir)) {
    for (const n of await list(path.join(store.subsDir, lot))) {
      const dir = path.join(store.subsDir, lot, n);
      const calledAt = await store.calledAt(Number(lot), Number(n));
      for (const id of await list(dir)) {
        const file = path.join(dir, id);
        const fileAge = await age(file, now);
        const registeredBeforeCall = calledAt !== null && now - fileAge <= calledAt;
        const tooOld = fileAge > Math.min((await lifetimeOf(Number(lot))) + HOUR, RETENTION.orphan);
        if (tooOld || (registeredBeforeCall && now - calledAt > RETENTION.contactAfterCall)) {
          await fs.rm(file, { force: true });
          done.contacts++;
        }
      }
      await removeIfEmpty(dir);
    }
    await removeIfEmpty(path.join(store.subsDir, lot));
  }

  for (const lot of await list(store.callsDir)) {
    for (const n of await list(path.join(store.callsDir, lot))) {
      if ((await age(path.join(store.callsDir, lot, n), now)) > Math.min((await lifetimeOf(Number(lot))) + HOUR, RETENTION.orphan)) {
        await store.forgetTicket(Number(lot), Number(n));
        done.orphans++;
      }
    }
    await removeIfEmpty(path.join(store.callsDir, lot));
  }

  for (const name of await list(store.etatDir)) {
    if (name.endsWith('.txt') && (await age(path.join(store.etatDir, name), now)) > RETENTION.orphan) {
      await fs.rm(path.join(store.etatDir, name), { force: true });
      done.orphans++;
    }
  }

  // Statistiques de plus de 90 jours (un an pour un lot Pro, ou dans sa marge de fin).
  for (const lot of await list(store.lotStatsDir)) {
    const pro = plans ? (await plans.status(await store.lot(Number(lot)))).grace : false;
    for (const name of await list(path.join(store.lotStatsDir, lot))) {
      if ((await age(path.join(store.lotStatsDir, lot, name), now)) > (pro ? RETENTION.statsPro : RETENTION.stats)) {
        await fs.rm(path.join(store.lotStatsDir, lot, name), { force: true });
        done.stats++;
      }
    }
    await removeIfEmpty(path.join(store.lotStatsDir, lot));
  }

  // Files : sans abonnement, supprimées 24 h après leur fermeture (30 jours après leur création si elles
  // n'ont jamais été ouvertes) ; avec un abonnement, gardées tant qu'il dure. Et les lots oubliés depuis 400 jours.
  for (const name of await list(store.lotsDir)) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(store.lotsDir, name);
    const lot = JSON.parse(await fs.readFile(file, 'utf8'));
    const kept = plans ? (await plans.status(lot)).grace : false;
    const over = lot.opened ? now - (lot.openUntil ?? 0) > RETENTION.closed : now - (lot.created ?? now) > RETENTION.unopened;
    if ((!kept && over) || (await age(file, now)) > RETENTION.lot) {
      await store.dropLot(lot);
      done.lots++;
    }
  }

  return done;
}
