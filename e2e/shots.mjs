// Captures d'écran réelles de l'accueil (public/assets/img/*.webp), prises sur le vrai service :
// un lot, des inscriptions, des appels, puis la page du client, l'espace commerçant
// et une planche imprimée. À relancer quand l'interface change :
//   cd e2e && node shots.mjs
import { chromium } from 'playwright';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createServer } from '../server/lib/server.js';
import * as wc from '../public/assets/crypto.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(here, '../public/assets/img');
mkdirSync(out, { recursive: true });
const PORT = 3996;
const BASE = `http://localhost:${PORT}`;
const { server } = await createServer({
  domain: `localhost:${PORT}`,
  brand: 'WeCall.You',
  contact: 'mailto:contact@wecall.you',
  dataDir: path.join(mkdtempSync(path.join(tmpdir(), 'wcy-shots-')), 'data'),
  publicDir: path.resolve(here, '../public'),
  serveStatic: true,
  basePath: '/api',
  tokenKey: randomBytes(16),
  statusKey: randomBytes(32),
  stripeWebhookSecret: 'whsec_shots',
});
await new Promise((resolve) => server.listen(PORT, resolve));

const api = async (method, route, body, auth) => {
  const res = await fetch(`${BASE}/api${route}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Lot ${auth}` } : {}) },
    body: body && JSON.stringify(body),
  });
  return res.json();
};

/* -------------------------------------------------- un lot qui vit un peu */
const lot = await wc.createLot();
const made = await api('POST', '/lots', { name: 'Snack du Stade', channels: ['push', 'sms', 'wa', 'mail'], from: 30, to: 99, ...lot.request });
const { tickets } = await api('POST', '/lot/tickets', { from: 30, to: 60 }, lot.authToken);
const ticket = (n) => tickets[n - 30];
const subs = {};
for (let n = 36; n <= 44; n++) {
  await api('GET', `/t/${ticket(n).c}`); // premier scan
  const blob = await wc.sealForLot(made.pubEcdh ?? (await api('GET', `/t/${ticket(n).c}`)).pubEcdh, { c: 'sms', v: `+3363998${String(1000 + n)}`, l: 'fr' });
  subs[n] = (await api('POST', '/sub', { t: ticket(n).c, blob, kind: 'sms' })).rid;
}
for (const n of [36, 37, 38, 39, 40, 41]) {
  await api('POST', '/call', { t: ticket(n).s }, lot.authToken);
  await new Promise((resolve) => setTimeout(resolve, 40)); // appels dans l'ordre sur l'écran public
}

/* ------------------------------------------------------------ captures */
const browser = await chromium.launch();
const converter = await (await browser.newContext()).newPage();
async function save(name, png, quality = 0.8) {
  const b64 = await converter.evaluate(
    async ({ data, q }) => {
      const img = new Image();
      img.src = `data:image/png;base64,${data}`;
      await img.decode();
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      canvas.getContext('2d').drawImage(img, 0, 0);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', q));
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let s = '';
      for (const b of bytes) s += String.fromCharCode(b);
      return btoa(s);
    },
    { data: png.toString('base64'), q: quality },
  );
  const file = path.join(out, `${name}.webp`);
  writeFileSync(file, Buffer.from(b64, 'base64'));
  console.log(`✔ ${name}.webp`);
}

const phone = async (scheme) => {
  const ctx = await browser.newContext({ locale: 'fr-FR', viewport: { width: 390, height: 620 }, deviceScaleFactor: 2, colorScheme: scheme, bypassCSP: true, reducedMotion: 'reduce' });
  return ctx;
};

try {
  for (const scheme of ['light', 'dark']) {
    const ctx = await phone(scheme);
    const p = await ctx.newPage();
    // Le client choisit comment être prévenu.
    await p.goto(`${BASE}/${ticket(50).c}`);
    await p.waitForSelector('.choice');
    await p.waitForTimeout(300);
    await save(`client-choix-${scheme}`, await p.screenshot());
    // L'espace commerçant : appel d'un inscrit par SMS (un ticket différent par thème : jamais un rappel).
    await p.goto(`${BASE}/m#${wc.secretToText(lot.secret)}`);
    await p.waitForSelector('#n');
    await p.fill('#n', scheme === 'light' ? '42' : '43');
    await p.click('form.row button[type=submit]');
    await p.waitForSelector('.result .call-title, .card .call-title');
    await p.locator('.call-title').first().scrollIntoViewIfNeeded();
    await p.evaluate(() => document.querySelector('.call-title').closest('.card').scrollIntoView({ block: 'start' }));
    await p.waitForTimeout(300);
    await save(`commercant-${scheme}`, await p.screenshot());
    await ctx.close();
  }

  // Une planche imprimée (A4, 12 tickets), cadrée sur le coin haut gauche.
  {
    const ctx = await browser.newContext({ locale: 'fr-FR', viewport: { width: 900, height: 1200 }, deviceScaleFactor: 2, bypassCSP: true });
    const p = await ctx.newPage();
    await p.goto(`${BASE}/creer`);
    await p.waitForSelector('#name', { state: 'attached' }); // dans un volet replié : il suffit que la page soit prête
    await p.evaluate(async () => {
      const { ticketSheets } = await import('/assets/sheets.js');
      const sample = Array.from({ length: 12 }, (_, i) => ({ label: String(30 + i).padStart(3, '0'), c: 'A'.repeat(26), s: 'B'.repeat(26) }));
      const [sheet] = ticketSheets(sample, { lang: 'fr', domain: 'wecall.you', name: 'Snack du Stade', last: 99 });
      sheet.id = 'planche';
      document.body.replaceChildren(sheet);
      document.body.style.background = '#fff';
    });
    const box = await p.locator('#planche').boundingBox();
    // 4:3, deux tickets de large : de quoi lire le QR, le numéro et la souche.
    await save('planche', await p.screenshot({ clip: { x: box.x, y: box.y, width: box.width * 0.62, height: box.width * 0.62 * 0.75 } }));
    await ctx.close();
  }
} finally {
  await browser.close();
  server.closeAllConnections();
  server.close();
}
