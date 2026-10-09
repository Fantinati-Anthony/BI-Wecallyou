// Parcours complet dans un vrai navigateur (Chromium via Playwright).
//   cd e2e && npm install && node run.mjs
// Lance le serveur en local, joue le commerçant et le client, et enregistre des captures dans e2e/out/.
import { chromium } from 'playwright';
import jsQR from 'jsqr';
import { PNG } from 'pngjs';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createServer } from '../server/lib/server.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, 'out');
mkdirSync(out, { recursive: true });
const tmp = mkdtempSync(path.join(tmpdir(), 'wcy-e2e-'));
const PORT = 3999;
const BASE = `http://localhost:${PORT}`;

const { server } = await createServer({
  domain: `localhost:${PORT}`,
  brand: 'WeCallYou',
  contact: 'mailto:contact@wecall.you',
  dataDir: path.join(tmp, 'data'),
  publicDir: path.resolve(here, '../public'),
  serveStatic: true,
  basePath: '/api',
  tokenKey: randomBytes(16),
  statusKey: randomBytes(32),
});
await new Promise((resolve) => server.listen(PORT, resolve));

const browser = await chromium.launch();
const shot = (page, name) => page.screenshot({ path: path.join(out, `${name}.png`), fullPage: true });
const step = (text) => console.log(`✔ ${text}`);
const noPrint = () => {
  window.print = () => {};
};

try {
  /* ------------------------------------------------ commerçant : création */
  const merchant = await browser.newContext({ locale: 'fr-FR', viewport: { width: 420, height: 900 } });
  await merchant.addInitScript(noPrint);
  const m = await merchant.newPage();
  const errors = [];
  m.on('pageerror', (err) => errors.push(err.message));
  await m.goto(BASE);
  await shot(m, '01-accueil');
  await m.fill('#name', 'Snack Tony');
  await m.fill('#count', '30');
  await m.fill('#password', 'motdepasse-tres-long');
  await m.fill('#password2', 'motdepasse-tres-long');
  await m.click('summary');
  await m.fill('#promo', 'Suivez-nous sur Instagram @snacktony');
  await m.fill('#link', 'https://instagram.com/snacktony');
  await m.click('button[type=submit]');
  await m.waitForSelector('#created:not([hidden])', { timeout: 30_000 });
  await shot(m, '02-lot-cree');
  step('lot créé avec mot de passe');

  const ticketsResponse = m.waitForResponse((r) => r.url().endsWith('/api/lot/tickets'));
  await m.click('#created .btn-big');
  const { tickets } = await (await ticketsResponse).json();
  assert.equal(tickets.length, 30);
  const sheets = await m.locator('.print-root .sheet').count();
  assert.equal(sheets, 1 + 3); // page clé + 3 pages de 12
  await m.emulateMedia({ media: 'print' });
  await m.locator('.print-root .sheet').nth(0).screenshot({ path: path.join(out, '03-page-cle.png') });
  await m.locator('.print-root .sheet').nth(1).screenshot({ path: path.join(out, '04-page-tickets.png') });
  await m.pdf({ path: path.join(out, 'lot.pdf'), preferCSSPageSize: true, printBackground: true });
  step(`impression : ${sheets} pages A4 (PDF dans e2e/out/lot.pdf)`);

  // Les QR imprimés se relisent avec un lecteur indépendant et mènent au bon ticket.
  const decode = async (locator) => {
    const png = PNG.sync.read(await locator.screenshot({ scale: 'device' }));
    return jsQR(new Uint8ClampedArray(png.data), png.width, png.height)?.data;
  };
  assert.equal(await decode(m.locator('.print-root .sheet').nth(1).locator('.part.client .p-qr').first()), `HTTPS://LOCALHOST:${PORT}/${tickets[0].c}`);
  assert.equal(await decode(m.locator('.print-root .sheet').nth(1).locator('.part.stub .p-qr').first()), `HTTPS://LOCALHOST:${PORT}/${tickets[0].s}`);
  await m.emulateMedia({ media: 'screen' });
  step('QR codes imprimés relus et corrects (ticket client et souche)');

  /* ---------------------------------------------------- client : inscription */
  const client = await browser.newContext({ locale: 'en-US', viewport: { width: 390, height: 844 } });
  const c = await client.newPage();
  c.on('pageerror', (err) => errors.push(err.message));
  const five = tickets[4];
  await c.goto(`${BASE}/${five.c}`);
  await c.waitForSelector('.choice');
  await shot(c, '05-client-choix');
  await c.getByRole('button', { name: /Text message/ }).click();
  await c.fill('#contact', '+33 6 12 34 56 78');
  await c.click('button[type=submit]');
  await c.waitForSelector('.banner-ok');
  await shot(c, '06-client-inscrit');
  step('client inscrit par SMS (numéro chiffré dans le navigateur)');

  /* ------------------------------------------- commerçant : tableau de bord */
  await m.goto(`${BASE}/m`);
  await m.waitForSelector('.waiting-list li .num');
  assert.equal(await m.locator('.waiting-list li .num').first().textContent(), '005');
  assert.match(await m.locator('.waiting-list li').first().textContent(), /💬/);
  await shot(m, '07-espace-commercant');
  step('le commerçant voit le 005 inscrit par 💬, sans numéro affiché');

  // Quelques appels pour donner un rythme à la file d'attente.
  for (const n of ['1', '2', '3']) {
    await m.fill('#n', n);
    await m.click('form.row button[type=submit]');
    await m.waitForSelector('.result .call-title');
  }

  /* ----------------------------------------------- appel par la souche */
  await m.goto(`${BASE}/${five.s}`);
  const smsButton = m.locator('a.btn-sms');
  await smsButton.waitFor({ timeout: 15_000 });
  const href = await smsButton.getAttribute('href');
  assert.match(href, /^sms:\+33612345678\?body=/);
  assert.match(decodeURIComponent(href), /Snack Tony.*005.*\n.*@snacktony https:\/\/instagram\.com\/snacktony/s);
  assert.match(await smsButton.textContent(), /••78/);
  await shot(m, '08-appel-souche');
  step('souche scannée : bouton SMS prêt (message en anglais, la langue du client)');

  await c.waitForSelector('.ready', { timeout: 15_000 });
  await shot(c, '09-client-cest-a-vous');
  step('la page du client affiche « It’s your turn » en temps réel');

  /* ------------------------------------------------- suivi, stats, affichage */
  await smsButton.click({ noWaitAfter: true }).catch(() => {});
  await m.goto(`${BASE}/m`);
  await m.getByRole('button', { name: 'Suivi' }).click();
  await m.waitForSelector('.pills .badge');
  const history = await m.locator('.waiting-list').textContent();
  assert.match(history, /scanné/);
  assert.match(history, /inscrit · SMS/);
  assert.match(history, /appelé/);
  await shot(m, '10-suivi');
  await m.getByRole('button', { name: 'Stats' }).click();
  await m.waitForSelector('.stats strong');
  await shot(m, '11-stats');
  await m.getByRole('button', { name: 'Appels' }).click();
  await m.getByRole('button', { name: /Écran d’affichage/ }).click();
  await m.waitForSelector('.display .d-number');
  assert.equal(await m.locator('.display .d-number').textContent(), '005');
  await m.setViewportSize({ width: 1280, height: 720 });
  await m.screenshot({ path: path.join(out, '12-ecran-affichage.png') });
  await m.setViewportSize({ width: 420, height: 900 });
  step('suivi, statistiques et écran d’affichage');

  /* ------------------------------ autre téléphone : page 1 + mot de passe */
  const lotsSaved = await m.evaluate(() => JSON.parse(localStorage.getItem('wcy:lots')));
  const key = Object.values(lotsSaved)[0].key;
  const phone2 = await browser.newContext({ locale: 'fr-FR', viewport: { width: 390, height: 844 } });
  const p2 = await phone2.newPage();
  await p2.goto(`${BASE}/m#${key}!`);
  await p2.waitForSelector('#pw');
  await p2.fill('#pw', 'mauvais-mot-de-passe');
  await p2.click('button[type=submit]');
  await p2.waitForSelector('.error:not([hidden])');
  await p2.fill('#pw', 'motdepasse-tres-long');
  await p2.click('button[type=submit]');
  await p2.waitForSelector('.waiting-list');
  assert.equal(p2.url(), `${BASE}/m`);
  step('second téléphone : refusé sans le bon mot de passe, accepté avec');

  /* ------------------------------------------- disposition 24 par page */
  await m.goto(`${BASE}/m`);
  await m.getByRole('button', { name: 'Imprimer' }).click();
  await m.selectOption('#pp', '24');
  await m.waitForTimeout(200);
  await m.locator('.btn-big').first().click();
  await m.waitForSelector('.print-root .sheet', { state: 'attached' });
  await m.emulateMedia({ media: 'print' });
  await m.locator('.print-root .sheet').first().screenshot({ path: path.join(out, '13-page-24-tickets.png') });
  await m.emulateMedia({ media: 'screen' });
  step('impression 24 tickets par page');

  assert.deepEqual(errors, []);
  step('aucune erreur JavaScript');
} finally {
  await browser.close();
  server.closeAllConnections();
  server.close();
}
