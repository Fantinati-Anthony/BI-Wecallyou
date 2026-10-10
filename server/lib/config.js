import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Dossier du serveur (là où se trouvent app.js et config.json). */
export const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function loadConfig(file = process.env.TN_CONFIG ?? path.join(SERVER_DIR, 'config.json')) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    // Une virgule oubliée suffit à empêcher le démarrage : on dit où regarder.
    throw new Error(`config.json illisible (${file}) : ${err.message}`);
  }
  const dir = path.dirname(file);
  const resolve = (p) => (path.isAbsolute(p) ? p : path.resolve(dir, p));
  const publicDir = resolve(raw.publicDir ?? '../public');
  return {
    domain: raw.domain,
    brand: raw.brand ?? raw.domain,
    // Adresse de contact transmise à Google/Apple avec chaque notification (exigé par le protocole).
    contact: raw.contact,
    dataDir: resolve(raw.dataDir ?? 'data'),
    publicDir,
    // Fichiers « prêt » lus par les pages client (servis par Apache) ; ailleurs seulement pour les tests.
    etatDir: raw.etatDir ? resolve(raw.etatDir) : path.join(publicDir, 'etat'),
    // En production Apache sert les pages ; en local Node les sert lui-même.
    serveStatic: raw.serveStatic ?? false,
    basePath: raw.basePath ?? '/api',
    port: Number(process.env.PORT ?? raw.port ?? 3000),
    tokenKey: Buffer.from(raw.tokenKey, 'hex'),
    statusKey: Buffer.from(raw.statusKey, 'hex'),
    // Secret du webhook Stripe (whsec_…) : vide = pas d'activation automatique du Pro.
    stripeWebhookSecret: raw.stripeWebhookSecret ?? '',
    // Liens de paiement Stripe de l'offre Pro (plink_…) ; les autres (dons) n'activent rien.
    stripeProLinks: raw.stripeProLinks ?? [],
    // Installation indépendante (club, association…) : toutes les options Pro pour tout le monde.
    allPro: raw.allPro ?? false,
    // Requêtes traitées en même temps par processus avant que la priorité Pro n'entre en jeu.
    capacity: raw.capacity ?? 40,
    // En-tête où le frontal de l'hébergeur écrit l'adresse du visiteur (o2switch : x-real-ip ;
    // proxy Cloudflare : cf-connecting-ip ; "" sans frontal). Tout autre en-tête se falsifie.
    ipHeader: String(raw.ipHeader ?? 'x-real-ip').toLowerCase(),
    // Charge de l'hébergement : { "local": true } (commande uapi, sans jeton) ou { host, user, token }.
    cpanel: raw.cpanel ?? null,
  };
}
