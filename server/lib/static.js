import fs from 'node:fs/promises';
import path from 'node:path';

// Service des pages en local (en production, c'est Apache qui s'en charge avec public/.htaccess).
// Les règles ci-dessous reproduisent exactement celles du .htaccess.

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

export const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; " +
    "worker-src 'self'; manifest-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'Permissions-Policy': 'geolocation=(), microphone=(), camera=()',
};

const REWRITES = [
  [/^\/$/, 'index.html'],
  [/^\/m\/?$/, 'm.html'],
  [/^\/soutenir\/?$/i, 'soutenir.html'],
  [/^\/merci\/?$/, 'merci.html'],
  [/^\/confidentialite\/?$/, 'confidentialite.html'],
  [/^\/compte\/?$/, 'compte.html'],
  [/^\/pro\/?$/, 'pro.html'],
  [/^\/mentions\/?$/, 'mentions.html'],
  [/^\/creer\/?$/, 'creer.html'],
  [/^\/voter\/?$/, 'voter.html'],
  [/^\/a\/[A-Za-z2-7]{23}\/?$/i, 'a.html'],
  [/^\/ecran\/[A-Za-z2-7]{23}\/?$/i, 'ecran.html'],
  [/^\/[A-Za-z2-7]{26}\/?$/, 't.html'],
  [/^\/[A-Za-z2-7]{26}\/manifest\.webmanifest$/, 'manifest.webmanifest'],
];

export function createStatic(publicDir, etatDir = path.join(publicDir, 'etat')) {
  return async function serve(req, res, pathname) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    let rel = REWRITES.find(([pattern]) => pattern.test(pathname))?.[1];
    if (!rel) {
      rel = decodeURIComponent(pathname).replace(/^\/+/, '');
      if (rel.split('/').some((part) => part === '..' || part.startsWith('.'))) return false;
    }
    const file = rel.startsWith('etat/') ? path.join(etatDir, rel.slice(5)) : path.join(publicDir, rel);
    let body;
    try {
      body = await fs.readFile(file);
    } catch {
      if (pathname.startsWith('/etat/')) {
        // Ticket pas encore appelé : réponse courte, gardée 2 s en cache (comme etat/.htaccess).
        res.writeHead(404, { 'Content-Type': 'text/plain', 'Cache-Control': 'public, max-age=2' });
        res.end('attente');
        return true;
      }
      return false;
    }
    const ext = path.extname(file);
    const headers = { 'Content-Type': TYPES[ext] ?? 'application/octet-stream', ...SECURITY_HEADERS };
    if (pathname.startsWith('/etat/')) headers['Cache-Control'] = 'public, max-age=2';
    else if (['.html', '.js', '.css'].includes(ext) || rel === 'soutien.json' || rel === 'papiers.json' || rel === 'idees.json') headers['Cache-Control'] = 'no-cache';
    else if (ext === '.woff2') headers['Cache-Control'] = 'public, max-age=31536000, immutable';
    else headers['Cache-Control'] = 'public, max-age=3600';
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : body);
    return true;
  };
}
