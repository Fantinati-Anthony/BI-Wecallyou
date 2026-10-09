import { loadConfig } from './lib/config.js';
import { createServer } from './lib/server.js';

const config = loadConfig();
const { server } = await createServer(config);
server.listen(config.port, () => console.log(`WeCallYou prêt sur le port ${config.port}`));
