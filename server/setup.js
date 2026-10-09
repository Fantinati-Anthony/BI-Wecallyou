// Première installation : crée config.json avec des clés secrètes neuves.
//   node setup.js --domain=wecall.you --contact=contact@wecall.you [--local]
import { existsSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { SERVER_DIR } from './lib/config.js';

const { values } = parseArgs({
  options: {
    domain: { type: 'string', default: 'wecall.you' },
    brand: { type: 'string', default: 'WeCall.You' },
    contact: { type: 'string' },
    local: { type: 'boolean', default: false },
    config: { type: 'string', default: path.join(SERVER_DIR, 'config.json') },
  },
});

if (existsSync(values.config)) {
  console.log(`${values.config} existe déjà : rien n'a été modifié.`);
  console.log('Ne régénérez JAMAIS tokenKey : tous les tickets déjà imprimés deviendraient invalides.');
  process.exit(0);
}

const config = {
  domain: values.domain,
  brand: values.brand,
  contact: `mailto:${values.contact ?? `contact@${values.domain}`}`,
  dataDir: 'data',
  publicDir: '../public',
  serveStatic: values.local,
  basePath: '/api',
  port: 3000,
  // Clé des codes imprimés dans les QR. À sauvegarder à part, à ne jamais changer.
  tokenKey: randomBytes(16).toString('hex'),
  // Clé des noms de fichiers d'état (impossibles à deviner sans elle).
  statusKey: randomBytes(32).toString('hex'),
  // À remplir avec le secret du webhook Stripe (whsec_…) pour activer le Pro des abonnés.
  stripeWebhookSecret: '',
  // Identifiants des liens de paiement de l'offre Pro (plink_…), pour ne pas confondre avec les dons.
  stripeProLinks: [],
  // true sur une installation indépendante : toutes les options Pro pour tout le monde.
  allPro: false,
  capacity: 40,
};

writeFileSync(values.config, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
console.log(`Configuration créée : ${values.config}`);
console.log('Sauvegardez ce fichier en lieu sûr : sans tokenKey, les tickets imprimés ne seraient plus reconnus.');
