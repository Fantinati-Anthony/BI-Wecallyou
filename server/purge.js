// Purge manuelle ou par cron (le serveur la lance déjà seul toutes les 10 minutes).
//   node purge.js
import { loadConfig } from './lib/config.js';
import { Store } from './lib/store.js';
import { purge } from './lib/purge.js';

const store = new Store(loadConfig());
await store.init();
const done = await purge(store);
if (process.argv.includes('--verbose')) console.log(done);
