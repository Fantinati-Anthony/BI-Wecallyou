import http from 'node:http';
import { Store } from './store.js';
import { Tokens } from './token.js';
import { Events } from './events.js';
import { createApi } from './api.js';
import { createStatic } from './static.js';
import { sendJson } from './http.js';
import { purge } from './purge.js';
import { Accounts } from './accounts.js';
import { Gate } from './priority.js';

export async function createServer(config) {
  const store = new Store(config);
  await store.init();
  const accounts = new Accounts(config);
  await accounts.init();
  const events = new Events(store);
  const gate = new Gate({ capacity: config.capacity ?? 40 });
  const api = createApi({ config, store, accounts, tokens: new Tokens(config.tokenKey), events, gate });
  const serveStatic = config.serveStatic ? createStatic(config.publicDir) : null;

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

  const timer = setInterval(() => purge(store, Date.now(), accounts).catch((err) => console.error('purge', err)), 10 * 60_000);
  timer.unref();
  server.on('close', () => clearInterval(timer));
  return { server, store, accounts, events, gate };
}
