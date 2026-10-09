import { existsSync } from 'node:fs';

const HEARTBEAT = 25_000;
const MAX_DURATION = 2 * 3_600_000;

/**
 * Temps réel pour les pages client restées ouvertes (Server-Sent Events).
 * L'hébergeur peut lancer plusieurs processus Node : un appel fait dans l'un doit réveiller
 * les pages connectées à un autre. Chaque processus vérifie donc chaque seconde le fichier
 * d'état des tickets qu'il surveille (un simple test d'existence, très peu coûteux).
 */
export class Events {
  #watchers = new Map(); // statusId → Set<réponse HTTP>
  #count = 0;

  constructor(store, { maxClients = 2000 } = {}) {
    this.store = store;
    this.maxClients = maxClients;
    setInterval(() => this.#sweep(), 1000).unref();
    setInterval(() => this.#heartbeat(), HEARTBEAT).unref();
  }

  get clients() {
    return this.#count;
  }

  /** Renvoie false si le processus est plein : la page passera alors en vérification périodique. */
  subscribe(statusId, req, res) {
    if (this.#count >= this.maxClients) return false;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
      Connection: 'keep-alive',
    });
    res.write('retry: 5000\n\n');
    if (existsSync(this.store.statusFile(statusId))) {
      res.end('event: ready\ndata: 1\n\n');
      return true;
    }
    let set = this.#watchers.get(statusId);
    if (!set) this.#watchers.set(statusId, (set = new Set()));
    set.add(res);
    this.#count++;
    const timer = setTimeout(() => res.end(), MAX_DURATION);
    const forget = () => {
      clearTimeout(timer);
      if (set.delete(res)) this.#count--;
      if (set.size === 0 && this.#watchers.get(statusId) === set) this.#watchers.delete(statusId);
    };
    req.on('close', forget);
    res.on('close', forget);
    return true;
  }

  notify(statusId) {
    const set = this.#watchers.get(statusId);
    if (!set) return;
    for (const res of set) res.end('event: ready\ndata: 1\n\n');
  }

  #sweep() {
    for (const statusId of this.#watchers.keys()) {
      if (existsSync(this.store.statusFile(statusId))) this.notify(statusId);
    }
  }

  #heartbeat() {
    for (const set of this.#watchers.values()) {
      for (const res of set) res.write(': ping\n\n');
    }
  }
}
