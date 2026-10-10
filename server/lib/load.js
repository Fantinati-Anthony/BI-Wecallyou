// Charge réelle de l'hébergement, lue chez l'hébergeur (cPanel, API « ResourceUsage ») : la part
// la plus haute des limites du compte (processeur, mémoire, processus, entrées/sorties). Quand elle
// approche du plafond, la porte d'entrée se resserre : les tickets des soutiens passent devant, les
// autres attendent quelques secondes. Sans réglage « cpanel » dans config.json, rien ne change.

const EVERY = 60_000; // une mesure par minute
const STALE = 5 * EVERY; // une mesure trop ancienne ne resserre plus rien

/** Part la plus haute des limites CloudLinux (« lve… ») dans une réponse de ResourceUsage::get_usages. */
export function loadOf(json) {
  const items = json?.result?.data ?? json?.data ?? [];
  const ratios = (Array.isArray(items) ? items : [])
    .filter((item) => /^lve/i.test(String(item?.id ?? '')) && Number(item.maximum) > 0 && Number.isFinite(Number(item.usage)))
    .map((item) => Number(item.usage) / Number(item.maximum));
  return ratios.length ? Math.min(1, Math.max(0, ...ratios)) : null;
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

  /** cpanel : { host, user, token } (jeton d'API cPanel) ; gate : la porte dont on règle les places. */
  constructor({ cpanel, gate, fetcher = globalThis.fetch }) {
    this.cpanel = cpanel ?? null;
    this.gate = gate;
    this.base = gate.capacity;
    this.fetcher = fetcher;
  }

  get configured() {
    return Boolean(this.cpanel?.host && this.cpanel?.user && this.cpanel?.token);
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
      const { host, user, token } = this.cpanel;
      const res = await this.fetcher(`https://${host}:2083/execute/ResourceUsage/get_usages`, {
        headers: { Authorization: `cpanel ${user}:${token}` },
        signal: AbortSignal.timeout(8000),
      });
      const ratio = loadOf(await res.json());
      if (ratio !== null) {
        this.ratio = ratio;
        this.at = Date.now();
      }
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
