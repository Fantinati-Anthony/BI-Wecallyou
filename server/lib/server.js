import http from 'node:http';
import path from 'node:path';
import { Store } from './store.js';
import { Tokens } from './token.js';
import { Events } from './events.js';
import { createApi } from './api.js';
import { createStatic } from './static.js';
import { sendJson } from './http.js';
import { purge } from './purge.js';
import { Accounts } from './accounts.js';
import { Gate } from './priority.js';
import { Plans } from './pro.js';
import { HostLoad } from './load.js';
import { Health } from './health.js';

export async function createServer(config) {
  const store = new Store(config);
  await store.init();
  const accounts = new Accounts(config);
  await accounts.init();
  const events = new Events(store);
  const gate = new Gate({ capacity: config.capacity ?? 40 });
  // Bulletin de santé du mois (chiffres anonymes) et charge mesurée chez l'hébergeur (facultatif :
  // « cpanel » dans config.json).
  const health = new Health(path.join(config.dataDir, 'stats', 'health'));
  const hostLoad = new HostLoad({ cpanel: config.cpanel, gate, events, health });
  hostLoad.start();
  const plans = new Plans({ config, store, accounts });
  const api = createApi({ config, store, accounts, plans, tokens: new Tokens(config.tokenKey), events, gate, hostLoad, health });
  const serveStatic = config.serveStatic ? createStatic(config.publicDir, config.etatDir) : null;

  const server = http.createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url, 'http://localhost').pathname;
      // Selon l'hébergeur, l'application reçoit « /api/... » ou « /... » : on accepte les deux.
      const apiPath = pathname.startsWith(`${config.basePath}/`) ? pathname.slice(config.basePath.length) : pathname;
      if (await api(req, res, apiPath)) return;
      if (serveStatic && (await serveStatic(req, res, pathname))) return;
      sendJson(res, 404, { ok: false, error: 'not_found' });
    } catch (err) {
      // Une requête malformée ne doit jamais faire tomber le serveur.
      if (!(err instanceof URIError || err instanceof TypeError)) console.error(err);
      if (!res.headersSent) sendJson(res, 400, { ok: false, error: 'bad_request' });
      else res.end();
    }
  });

  const timer = setInterval(() => purge(store, Date.now(), accounts, plans).catch((err) => console.error('purge', err)), 10 * 60_000);
  timer.unref();
  // Chaque minute : les pages en direct du moment, et la minute comptée si une limite a été touchée.
  const minute = setInterval(() => {
    health.live(events.clients);
    health.minute().catch((err) => console.error('santé', err));
  }, 60_000);
  minute.unref();
  server.on('close', () => {
    clearInterval(timer);
    clearInterval(minute);
    hostLoad.stop();
  });
  return { server, store, accounts, plans, events, gate, hostLoad, health };
}
