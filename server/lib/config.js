import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Dossier du serveur (là où se trouvent app.js et config.json). */
export const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function loadConfig(file = process.env.TN_CONFIG ?? path.join(SERVER_DIR, 'config.json')) {
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  const dir = path.dirname(file);
  const resolve = (p) => (path.isAbsolute(p) ? p : path.resolve(dir, p));
  return {
    domain: raw.domain,
    brand: raw.brand ?? raw.domain,
    // Adresse de contact transmise à Google/Apple avec chaque notification (exigé par le protocole).
    contact: raw.contact,
    dataDir: resolve(raw.dataDir ?? 'data'),
    publicDir: resolve(raw.publicDir ?? '../public'),
    // En production Apache sert les pages ; en local Node les sert lui-même.
    serveStatic: raw.serveStatic ?? false,
    basePath: raw.basePath ?? '/api',
    port: Number(process.env.PORT ?? raw.port ?? 3000),
    tokenKey: Buffer.from(raw.tokenKey, 'hex'),
    statusKey: Buffer.from(raw.statusKey, 'hex'),
  };
}
