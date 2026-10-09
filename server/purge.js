// Purge manuelle ou par cron (le serveur la lance déjà seul toutes les 10 minutes).
//   node purge.js
import { loadConfig } from './lib/config.js';
import { Store } from './lib/store.js';
import { Accounts } from './lib/accounts.js';
import { purge } from './lib/purge.js';

const config = loadConfig();
const store = new Store(config);
await store.init();
const accounts = new Accounts(config);
await accounts.init();
const done = await purge(store, Date.now(), accounts);
if (process.argv.includes('--verbose')) console.log(done);
