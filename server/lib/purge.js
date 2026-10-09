import fs from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_LIFETIME, LIFETIMES } from './store.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const RETENTION = Object.freeze({
  contactAfterCall: 30 * MINUTE, // une coordonnée sert encore 30 min après l'appel (rappel possible), pas plus
  orphan: 48 * HOUR, // filet de sécurité : rien de ce qui concerne un ticket ne dépasse 48 h
  stats: 90 * DAY, // statistiques anonymes du lot
  lot: 400 * DAY, // un lot jamais réutilisé pendant 400 jours est supprimé
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

/**
 * Efface tout ce qui a fait son temps. Lancé toutes les 10 minutes par le serveur (ou par cron).
 *  1. Les tickets arrivés en fin de vie (durée du lot, comptée depuis le premier scan).
 *  2. Les coordonnées chiffrées, 30 min après l'appel du ticket.
 *  3. Tout reste orphelin de plus de 48 h, les statistiques de plus de 90 jours, les lots oubliés.
 */
export async function purge(store, now = Date.now()) {
  const done = { tickets: 0, contacts: 0, orphans: 0, stats: 0, lots: 0 };
  const lifetimes = new Map();
  const lifetimeOf = async (lot) => {
    if (!lifetimes.has(lot)) {
      const hours = (await store.lot(lot))?.ttl;
      lifetimes.set(lot, (LIFETIMES.includes(hours) ? hours : DEFAULT_LIFETIME) * HOUR);
    }
    return lifetimes.get(lot);
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

  // 2. Coordonnées : effacées 30 min après l'appel ; 3. orphelines : 48 h maximum.
  for (const lot of await list(store.subsDir)) {
    for (const n of await list(path.join(store.subsDir, lot))) {
      const dir = path.join(store.subsDir, lot, n);
      const calledAt = await store.calledAt(Number(lot), Number(n));
      for (const id of await list(dir)) {
        const file = path.join(dir, id);
        const fileAge = await age(file, now);
        const registeredBeforeCall = calledAt !== null && now - fileAge <= calledAt;
        if (fileAge > RETENTION.orphan || (registeredBeforeCall && now - calledAt > RETENTION.contactAfterCall)) {
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
      if ((await age(path.join(store.callsDir, lot, n), now)) > RETENTION.orphan) {
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

  // Statistiques de plus de 90 jours.
  for (const lot of await list(store.lotStatsDir)) {
    for (const name of await list(path.join(store.lotStatsDir, lot))) {
      if ((await age(path.join(store.lotStatsDir, lot, name), now)) > RETENTION.stats) {
        await fs.rm(path.join(store.lotStatsDir, lot, name), { force: true });
        done.stats++;
      }
    }
    await removeIfEmpty(path.join(store.lotStatsDir, lot));
  }

  // Lots inutilisés depuis 400 jours.
  for (const name of await list(store.lotsDir)) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(store.lotsDir, name);
    if ((await age(file, now)) > RETENTION.lot) {
      const lot = JSON.parse(await fs.readFile(file, 'utf8'));
      await fs.rm(path.join(store.keysDir, lot.verifier), { force: true });
      await fs.rm(path.join(store.lotStatsDir, String(lot.id)), { recursive: true, force: true });
      await fs.rm(file, { force: true });
      done.lots++;
    }
  }

  return done;
}
