// Charge réelle de l'hébergement, lue chez l'hébergeur (cPanel, API « ResourceUsage ») : la part
// la plus haute des limites du compte (processeur, mémoire, processus, entrées/sorties). Quand elle
// approche du plafond, la porte d'entrée se resserre : les tickets des soutiens passent devant, les
// autres attendent quelques secondes. Sans réglage « cpanel » dans config.json, rien ne change.
// Chaque page ouverte en direct occupe une connexion du compte pendant toute l'attente (mesuré sur
// une lune : 80 au total, et le site ne répond plus quand elles sont toutes prises). Le direct n'en
// prend donc que la moitié ; au-delà, les pages vérifient toutes les 5 s un fichier servi par Apache.
// « cpanel »: { "local": true } : l'application tourne sur le même compte, elle lance la commande
// uapi elle-même, sans jeton (le plus sûr). Sinon { host, user, token } : l'API par HTTPS.
import { execFile } from 'node:child_process';

/** Lecture locale : « uapi ResourceUsage get_usages », comme dans le terminal du compte. */
const runOne = (bin) =>
  new Promise((resolve, reject) => {
    execFile(bin, ['--output=json', 'ResourceUsage', 'get_usages'], { timeout: 8000 }, (err, stdout) => {
      if (err) return reject(err);
      try {
        resolve(JSON.parse(stdout));
      } catch (parseError) {
        reject(parseError);
      }
    });
  });
// L'application lancée par cPanel n'a pas toujours le même PATH que le terminal : chemins complets d'abord.
const UAPI = ['/usr/bin/uapi', '/usr/local/cpanel/bin/uapi', 'uapi'];
const runUapi = async () => {
  let last;
  for (const bin of UAPI) {
    try {
      return await runOne(bin);
    } catch (err) {
      last = err;
      if (err.code !== 'ENOENT') throw err;
    }
  }
  throw last;
};

const EVERY = 60_000; // une mesure par minute
const STALE = 5 * EVERY; // une mesure trop ancienne ne resserre plus rien

const itemsOf = (json) => {
  const items = json?.result?.data ?? json?.data ?? [];
  return Array.isArray(items) ? items : [];
};

/** Part la plus haute des limites CloudLinux (« lve… ») dans une réponse de ResourceUsage::get_usages. */
export function loadOf(json) {
  const ratios = itemsOf(json)
    .filter((item) => /^lve/i.test(String(item?.id ?? '')) && Number(item.maximum) > 0 && Number.isFinite(Number(item.usage)))
    .map((item) => Number(item.usage) / Number(item.maximum));
  return ratios.length ? Math.min(1, Math.max(0, ...ratios)) : null;
}

/** Connexions simultanées permises au compte (CloudLinux « lveep »), ou null. */
export function entryLimit(json) {
  const max = Number(itemsOf(json).find((item) => item?.id === 'lveep')?.maximum);
  return max > 0 ? max : null;
}

/** Places à la porte selon la charge : toutes sous 75 %, puis de moins en moins jusqu'au quart au plafond. */
export function squeeze(base, ratio) {
  if (ratio == null || ratio < 0.75) return base;
  const factor = ratio >= 0.95 ? 0.25 : ratio >= 0.85 ? 0.5 : 0.75;
  return Math.max(2, Math.round(base * factor));
}

export class HostLoad {
  ratio = null;
  at = 0;

  /** cpanel : { local: true } ou { host, user, token } ; gate : la porte dont on règle les places ;
   *  events : le temps réel, dont on règle le nombre de pages en direct ; health : le bulletin du mois. */
  constructor({ cpanel, gate, events = null, health = null, fetcher = globalThis.fetch, runner = runUapi }) {
    this.cpanel = cpanel ?? null;
    this.gate = gate;
    this.base = gate.capacity;
    this.events = events;
    this.health = health;
    this.live = events?.maxClients;
    this.fetcher = fetcher;
    this.runner = runner;
  }

  get configured() {
    return Boolean(this.cpanel?.local || (this.cpanel?.host && this.cpanel?.user && this.cpanel?.token));
  }

  async read() {
    if (this.cpanel.local) return this.runner();
    const { host, user, token } = this.cpanel;
    const res = await this.fetcher(`https://${host}:2083/execute/ResourceUsage/get_usages`, {
      headers: { Authorization: `cpanel ${user}:${token}` },
      signal: AbortSignal.timeout(8000),
    });
    return res.json();
  }

  get fresh() {
    return this.ratio !== null && Date.now() - this.at < STALE;
  }

  start() {
    if (!this.configured) return;
    this.tick();
    this.timer = setInterval(() => this.tick(), EVERY);
    this.timer.unref();
  }

  stop() {
    clearInterval(this.timer);
  }

  async tick() {
    try {
      const json = await this.read();
      const ratio = loadOf(json);
      if (ratio !== null) {
        this.ratio = ratio;
        this.at = Date.now();
        this.health?.load(ratio);
      }
      const entries = entryLimit(json);
      if (entries && this.events) this.events.maxClients = Math.max(1, Math.min(this.live, Math.floor(entries / 2)));
    } catch {
      // Hébergeur injoignable : on garde la dernière mesure, qui finit par expirer.
    }
    this.gate.capacity = squeeze(this.base, this.fresh ? this.ratio : null);
  }

  /** Pour la page Soutenir : la charge mesurée (arrondie), ou rien si l'on ne sait pas. */
  view() {
    return this.fresh ? { ratio: Math.round(this.ratio * 100) / 100, at: this.at } : null;
  }
}
