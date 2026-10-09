import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import * as base32 from './base32.js';

const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const DAY = 86_400_000;
export const PRO_MONTH = 31 * DAY;

/**
 * Comptes « zéro connaissance » : un identifiant et un mot de passe qui ne quittent jamais le
 * navigateur. Le serveur ne garde que des empreintes et un coffre chiffré (les lots du compte),
 * qu'il ne peut pas ouvrir.
 *
 *   data/accounts/<id>.json            { id, identHash, verifier, recoveryVerifier, wrapPw, wrapRec,
 *                                        vault, version, premiumUntil, created }
 *   data/keys/acc-<empreinte>          connexion (empreinte du jeton dérivé du mot de passe) → id
 *   data/keys/rec-<empreinte>          secours (empreinte du jeton dérivé de la clé de secours) → id
 *   data/keys/ident-<hmac>             unicité de l'identifiant (jamais stocké en clair) → id
 *   data/stripe/customers/<cus_…>      client Stripe → id (renouvellements des dons mensuels)
 *   data/stripe/events/<evt_…>         événements déjà traités (aucun rejeu possible)
 */
export class Accounts {
  #identKey;
  #proCache = new Map();

  constructor({ dataDir, statusKey }) {
    this.dir = path.join(dataDir, 'accounts');
    this.keysDir = path.join(dataDir, 'keys');
    this.customersDir = path.join(dataDir, 'stripe', 'customers');
    this.eventsDir = path.join(dataDir, 'stripe', 'events');
    this.#identKey = statusKey;
  }

  async init() {
    for (const dir of [this.dir, this.keysDir, this.customersDir, this.eventsDir]) await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  }

  identHash(ident) {
    return createHmac('sha256', this.#identKey).update(`ident|${ident}`).digest('hex');
  }

  file(id) {
    return path.join(this.dir, `${id}.json`);
  }

  async get(id) {
    if (typeof id !== 'string' || !/^[A-Z2-7]{24}$/.test(id)) return null;
    try {
      return JSON.parse(await fs.readFile(this.file(id), 'utf8'));
    } catch {
      return null;
    }
  }

  async save(account) {
    const tmp = `${this.file(account.id)}.${randomBytes(4).toString('hex')}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(account), { mode: 0o600 });
    await fs.rename(tmp, this.file(account.id));
    this.#proCache.delete(account.id);
  }

  async #index(name, id) {
    await fs.writeFile(path.join(this.keysDir, name), id, { flag: 'wx', mode: 0o600 });
  }

  async #unindex(name) {
    await fs.rm(path.join(this.keysDir, name), { force: true });
  }

  /** Renvoie null si l'identifiant est déjà pris. */
  async create({ ident, verifier, recoveryVerifier, wrapPw, wrapRec, vault }) {
    const id = base32.encode(randomBytes(15));
    const identHash = this.identHash(ident);
    try {
      await this.#index(`ident-${identHash}`, id);
    } catch (err) {
      if (err.code === 'EEXIST') return null;
      throw err;
    }
    const account = { id, identHash, verifier, recoveryVerifier, wrapPw, wrapRec, vault, version: 1, premiumUntil: 0, created: Date.now() };
    await this.save(account);
    await this.#index(`acc-${verifier}`, id);
    await this.#index(`rec-${recoveryVerifier}`, id);
    return account;
  }

  /** Compte correspondant à un jeton de connexion (`acc`) ou de secours (`rec`). */
  async byToken(kind, token) {
    if (typeof token !== 'string' || !/^[\w-]{43}$/.test(token)) return null;
    let id;
    try {
      id = await fs.readFile(path.join(this.keysDir, `${kind}-${sha256(token)}`), 'utf8');
    } catch {
      return null;
    }
    const account = await this.get(id);
    if (account) {
      const stat = await fs.stat(this.file(id)).catch(() => null);
      if (stat && Date.now() - stat.mtimeMs > DAY) await fs.utimes(this.file(id), new Date(), new Date()).catch(() => {});
    }
    return account;
  }

  async setPassword(account, verifier, wrapPw) {
    await this.#unindex(`acc-${account.verifier}`);
    await this.#index(`acc-${verifier}`, account.id);
    Object.assign(account, { verifier, wrapPw });
    await this.save(account);
  }

  async setRecovery(account, recoveryVerifier, wrapRec) {
    await this.#unindex(`rec-${account.recoveryVerifier}`);
    await this.#index(`rec-${recoveryVerifier}`, account.id);
    Object.assign(account, { recoveryVerifier, wrapRec });
    await this.save(account);
  }

  /** Écriture du coffre avec contrôle de version (deux téléphones ne s'écrasent pas). */
  async setVault(account, vault, version) {
    if (version !== account.version) return null;
    account.vault = vault;
    account.version += 1;
    await this.save(account);
    return account.version;
  }

  async remove(account) {
    await this.#unindex(`acc-${account.verifier}`);
    await this.#unindex(`rec-${account.recoveryVerifier}`);
    await this.#unindex(`ident-${account.identHash}`);
    await fs.rm(this.file(account.id), { force: true });
    this.#proCache.delete(account.id);
  }

  /* ------------------------------------------------------------------ Pro */

  isPro(account) {
    return (account?.premiumUntil ?? 0) > Date.now();
  }

  /** Statut Pro d'un compte, gardé 30 s en mémoire (vérifié seulement en cas d'affluence). */
  async isProId(id) {
    const cached = this.#proCache.get(id);
    if (cached && Date.now() - cached.at < 30_000) return cached.pro;
    const pro = this.isPro(await this.get(id));
    this.#proCache.set(id, { at: Date.now(), pro });
    return pro;
  }

  /** Prolonge le Pro jusqu'à `until` (jamais de raccourcissement). */
  async extendPro(id, until) {
    const account = await this.get(id);
    if (!account) return false;
    account.premiumUntil = Math.max(account.premiumUntil ?? 0, until);
    await this.save(account);
    return true;
  }

  /** Lots rattachés au compte (numéros seulement) : sert à mesurer l'usage pour le prix conseillé. */
  async addLot(account, lotId) {
    account.lots ??= [];
    if (!account.lots.includes(lotId)) {
      account.lots.push(lotId);
      await this.save(account);
    }
  }

  async linkCustomer(customerId, accountId) {
    if (!/^cus_\w{1,64}$/.test(customerId)) return;
    await fs.writeFile(path.join(this.customersDir, customerId), accountId, { mode: 0o600 });
  }

  async accountOfCustomer(customerId) {
    if (typeof customerId !== 'string' || !/^cus_\w{1,64}$/.test(customerId)) return null;
    return fs.readFile(path.join(this.customersDir, customerId), 'utf8').catch(() => null);
  }

  /** true si l'événement Stripe a déjà été traité (Stripe peut renvoyer le même plusieurs fois). */
  async alreadyHandled(eventId) {
    if (!/^evt_\w{1,64}$/.test(eventId)) return true;
    try {
      await fs.writeFile(path.join(this.eventsDir, eventId), '', { flag: 'wx', mode: 0o600 });
      return false;
    } catch (err) {
      if (err.code === 'EEXIST') return true;
      throw err;
    }
  }
}
