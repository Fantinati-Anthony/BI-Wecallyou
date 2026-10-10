// Parcours complet dans un vrai navigateur (Chromium via Playwright).
//   cd e2e && npm install && node run.mjs
// Lance le serveur en local, joue le commerçant et le client, et enregistre des captures dans e2e/out/.
import { chromium } from 'playwright';
import jsQR from 'jsqr';
import { PNG } from 'pngjs';
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes, createHmac } from 'node:crypto';
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
  brand: 'WeCall.You',
  contact: 'mailto:contact@wecall.you',
  dataDir: path.join(tmp, 'data'),
  publicDir: path.resolve(here, '../public'),
  etatDir: path.join(tmp, 'etat'), // les appels du test n'écrivent rien dans public/
  serveStatic: true,
  basePath: '/api',
  tokenKey: randomBytes(16),
  statusKey: randomBytes(32),
  stripeWebhookSecret: 'whsec_e2e',
});
await new Promise((resolve) => server.listen(PORT, resolve));

const browser = await chromium.launch();
const shot = (page, name) => page.screenshot({ path: path.join(out, `${name}.png`), fullPage: true });
const step = (text) => console.log(`✔ ${text}`);
// Les pages interdisent l'évaluation de code (CSP stricte) : on lit simplement le texte affiché.
async function waitText(locator, expected, timeout = 15_000) {
  const end = Date.now() + timeout;
  let seen = '';
  while (Date.now() < end) {
    seen = (await locator.textContent().catch(() => '')) ?? '';
    if (seen === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`attendu « ${expected} », affiché « ${seen} »`);
}
const noPrint = () => {
  window.print = () => {};
};

try {
  /* ------------------------------------------------ commerçant : création */
  // Le commerçant appelle depuis son téléphone (Android) : les SMS partent de son forfait.
  const merchant = await browser.newContext({ locale: 'fr-FR', viewport: { width: 420, height: 900 }, userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36' });
  await merchant.addInitScript(noPrint);
  const m = await merchant.newPage();
  const errors = [];
  m.on('pageerror', (err) => errors.push(err.message));
  await m.goto(BASE);
  await shot(m, '01-accueil');
  // Sans compte Pro : le comparatif est là, les options Pro du générateur sont visibles mais grisées.
  await m.waitForSelector('.compare .plan.is-pro');
  assert.ok((await m.locator('.how-step p').first().textContent()).length > 20); // l'accueil est bien traduit
  assert.equal(await m.locator('.hero-cta svg').count(), 1); // et ses icônes posées
  assert.doesNotMatch(await m.locator('.compare').textContent(), /cmp_|plan_/); // aucune clé de traduction oubliée
  // « Créer ma file » aussi dans le menu, et rien ne déborde sur un téléphone.
  assert.equal(await m.locator('.topnav .nav-cta[href="/creer"] svg').count(), 1);
  // Les 4 moyens de prévenir, gratuits, et ce qui part d'où selon l'appareil (ici un ordinateur : SMS depuis le téléphone).
  assert.equal(await m.locator('.ch-card').count(), 4);
  assert.match(await m.locator('#device-note').textContent(), /téléphone : tous les moyens/);
  assert.equal(await m.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  // Activités : un appui adapte les démonstrations (ticket, téléphone du client, écran public).
  assert.equal(await m.locator('#home-acts .act-chip').count(), 10);
  assert.equal(await m.locator('#home-acts.auto').count(), 1); // sans appui, elles défilent seules
  await m.click('#home-acts .act-chip[data-id="pressing"]');
  await waitText(m.locator('#hero-phone .hp-merchant'), 'Pressing Lumière');
  assert.match(await m.locator('#hero-phone .hp-msg').textContent(), /dépôt n°042/);
  assert.equal(await m.locator('#live-queue .lq-name').textContent(), 'Pressing Lumière');
  assert.equal(await m.locator('#home-acts.auto').count(), 0); // l'activité choisie reste
  // L'écran public de démonstration s'anime : les appels avancent, le téléphone du client suit sa place.
  await m.locator('#live-queue').scrollIntoViewIfNeeded();
  await m.locator('#live-queue .lq-number').filter({ hasText: '043' }).waitFor({ timeout: 3000 }); // le cycle recommence au choix
  assert.match(await m.locator('#live-queue .lq-place').textContent(), /3e/);
  await m.locator('#live-queue .lq-number').filter({ hasText: '044' }).waitFor({ timeout: 6000 });
  assert.match(await m.locator('#live-queue .lq-place').textContent(), /2e/);
  await m.waitForSelector('#live-queue .lq-phone.is-ready', { timeout: 9000 });
  assert.equal(await m.locator('#live-queue .lq-place').textContent(), 'C’est à vous !');
  assert.match(await m.locator('#live-queue .lq-wait').textContent(), /dépôt n°046/);
  await shot(m, '01b-ecran-anime');
  // La création de lot a sa propre page, atteinte par l'appel à l'action de l'accueil.
  await m.locator('.hero-cta a[href="/creer"]').click();
  await m.waitForSelector('#c-act', { state: 'attached' });
  // « Message et variables » : l'activité touchée sur l'accueil est proposée, et se change dans une fenêtre.
  assert.match(await m.locator('#activity-slot .act-current').textContent(), /Pressing/);
  assert.match(await m.locator('#ctp').inputValue(), /votre dépôt n°\{numero\}/);
  await m.click('#c-act'); // l'activité est dans le premier onglet, juste après le nom
  await m.waitForSelector('dialog.act-dialog[open]');
  assert.equal(await m.locator('.act-block').count(), 10);
  await m.hover('.act-block[data-id="club"]'); // au survol, le message type de l'activité
  assert.match(await m.locator('.act-phone p').textContent(), /Équipe rouge/);
  await shot(m, '01c-choix-activite');
  await m.click('.act-block[data-id="autre"]');
  await m.click('.act-use'); // message du modèle « pressing » non retouché : remplacé sans question
  await m.waitForSelector('dialog.act-dialog', { state: 'detached' });
  assert.equal(await m.locator('#ctp').inputValue(), '');
  assert.match(await m.locator('#panel-message .msg-example').textContent(), /c’est à vous/); // message par défaut
  assert.equal(await m.locator('#c-wl').isDisabled(), true);
  assert.equal(await m.locator('#ttl option[value="720"]').isDisabled(), true);
  // Logo et couleurs des tickets : offre Pro, grisés ici.
  assert.equal(await m.locator('#d-tbg').isDisabled(), true);
  assert.equal(await m.locator('#d-logo').isDisabled(), true);
  assert.equal(await m.locator('#design-colors .pro-lock:not([hidden])').count(), 1);
  await m.click('#tab-look');
  assert.equal(await m.locator('#pro-tools .pro-lock').isVisible(), true);
  assert.equal(await m.locator('#panel-message').isHidden(), true); // un seul onglet affiché à la fois
  assert.equal(await m.locator('#tab-look').getAttribute('aria-selected'), 'true');
  step('accueil : comparatif Gratuit / Pro ; page « Créer » : activités, options Pro grisées sans compte Pro');
  await m.click('#tab-info');
  await m.fill('#name', 'Snack Tony');
  await m.fill('#count', '30');
  await m.fill('#password', 'motdepasse-tres-long');
  await m.fill('#password2', 'motdepasse-tres-long');
  await m.click('#tab-message');
  await m.fill('#promo', 'Suivez-nous sur Instagram @snacktony');
  await m.fill('#link', 'https://instagram.com/snacktony');
  await m.click('#create-btn');
  await m.waitForSelector('#created:not([hidden])', { timeout: 30_000 });
  await shot(m, '02-lot-cree');
  step('lot créé avec mot de passe');

  const ticketsResponse = m.waitForResponse((r) => r.url().endsWith('/api/lot/tickets'));
  await m.click('#created .btn-big');
  const { tickets } = await (await ticketsResponse).json();
  assert.equal(tickets.length, 30);
  const sheets = await m.locator('.print-root .sheet').count();
  assert.equal(sheets, 1 + 3); // page clé + 3 pages de 12
  // Logo WeCall.You par défaut : en signature de chaque ticket (une seule langue), et dans le bandeau de la page clé.
  assert.equal(await m.locator('.print-root .sheet').nth(1).locator('.part.client .p-brand .wm-icon svg').count(), 12);
  assert.equal(await m.locator('.print-root .sheet').nth(1).locator('.p-sub').count(), 0);
  assert.equal(await m.locator('.print-root .sheet').nth(0).locator('.doc-band .doc-logo svg').count(), 1);
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
  // Page clé : un QR ouvre l'écran d'affichage du lot, et rien ne dépasse de la feuille.
  const keyPageEl = m.locator('.print-root .sheet').nth(0);
  const screenLink = await decode(keyPageEl.locator('.k-screen .p-qr'));
  assert.match(screenLink, new RegExp(`^HTTPS://LOCALHOST:${PORT}/ECRAN/[A-Z2-7]{23}$`));
  assert.equal(await keyPageEl.evaluate((el) => el.scrollHeight <= el.clientHeight + 1), true);
  await m.emulateMedia({ media: 'screen' });
  {
    const tv = await merchant.newPage();
    await tv.goto(`${BASE}${new URL(screenLink).pathname}`);
    await waitText(tv.locator('.s-name'), 'Snack Tony');
    await tv.close();
  }
  step('QR codes imprimés relus et corrects (ticket client, souche, écran d’affichage de la page clé)');

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
  assert.match(await m.locator('.waiting-list li .kinds').first().getAttribute('aria-label'), /SMS/);
  // Le client a laissé son numéro : un appui pour le joindre de vive voix (tel:), le numéro restant masqué à l'écran.
  const tel = m.locator('.waiting-list li:has(.kinds)').first().locator('a.tel-btn');
  assert.match(await tel.getAttribute('href'), /^tel:\+?\d{8,15}$/);
  assert.match(await tel.textContent(), /^••\d{2}$/);
  await shot(m, '07-espace-commercant');
  assert.equal(await m.locator('#pc-note').count(), 0); // sur téléphone : rien à signaler
  step('le commerçant voit le 005 inscrit par SMS, sans numéro affiché');

  // Quelques appels pour donner un rythme à la file d'attente.
  for (const n of ['1', '2', '3']) {
    await m.fill('#n', n);
    await m.click('form.row button[type=submit]');
    await m.waitForSelector('.result .call-title');
  }

  // Client sans smartphone : le téléphone du commerçant scanne son QR client (fiche du ticket, pas le
  // formulaire du client), ou le commerçant tape le numéro écrit dessus. Le ticket entre dans la file.
  {
    const desk = await merchant.newPage();
    desk.on('pageerror', (err) => errors.push(err.message));
    await desk.goto(`${BASE}/${tickets[19].c}`);
    await waitText(desk.locator('#desk-status'), 'Ajouté à la file');
    assert.equal(await desk.locator('.choice').count(), 0);
    assert.equal(await desk.locator('#desk-call').isVisible(), true);
    await shot(desk, '08b-fiche-commercant');
    await desk.reload(); // second scan : déjà dans la file
    await waitText(desk.locator('#desk-status'), 'Déjà dans la file');
    await desk.close();
    await m.fill('#arrive-n', '21');
    await m.click('#arrive-form button[type=submit]');
    await m.waitForSelector('#arrivals li:has-text("021")');
    await m.waitForSelector('#arrivals li:has-text("020")');
    assert.match(await m.locator('#arrive-form + [role=status]').textContent(), /021/);
    await m.fill('#arrive-n', '500');
    await m.click('#arrive-form button[type=submit]');
    await waitText(m.locator('#arrive-form + [role=status]'), 'Ce numéro n’appartient pas à cette file.');
  }
  step('client sans smartphone : QR client scanné par le commerçant (fiche) ou numéro tapé, le ticket entre dans la file');

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
  assert.match(history, /Notifié 1 fois/); // nombre de notifications du ticket
  await shot(m, '10-suivi');
  await m.getByRole('button', { name: 'Stats' }).click();
  await m.waitForSelector('.stats strong');
  await shot(m, '11-stats');
  step('suivi et statistiques');

  /* ------------------- listes, modèle, groupe, écran public, appel de groupe */
  await m.getByRole('button', { name: 'Réglages' }).click();
  await m.fill('#sli', 'Terrain : Terrain 1, Terrain 2, Terrain 3\nÉquipe : U11 > Rouge, U11 > Bleu, U13 > Vert');
  // Le modèle se compose aussi d'un appui sur les variables disponibles sous le champ.
  await m.fill('#stp', '{groupe} : attendus au ');
  await m.locator('.var-chips .chip', { hasText: '{Terrain}' }).click();
  await m.locator('#stp').press('End');
  await m.locator('#stp').pressSequentially(' !');
  assert.equal(await m.locator('#stp').inputValue(), '{groupe} : attendus au {Terrain} !');
  await m.fill('#sgr', 'U11 Rouge : 6-8');
  await m.click('form.stack button[type=submit]');
  await m.waitForSelector('p.ok');
  await shot(m, '12-reglages-message');
  step('réglages : listes (dont une sous-liste), modèle et groupe');

  await m.getByRole('button', { name: 'Appels' }).click();
  await m.click('summary:has-text("Écran public")');
  const screenUrl = await m.locator('.screen-link').textContent();
  const screenPath = new URL(screenUrl).pathname;
  const tablet = await browser.newContext({ locale: 'fr-FR', viewport: { width: 1280, height: 720 } });
  const tab = await tablet.newPage();
  tab.on('pageerror', (err) => errors.push(err.message));
  await tab.goto(`${BASE}${screenPath}`);
  await waitText(tab.locator('.s-number'), '005');
  step('écran public ouvert sur une « tablette » par son lien secret');

  // Un spectateur attend devant l'écran avec le ticket 007, page ouverte.
  const watcher = await client.newPage();
  await watcher.goto(`${BASE}/${tickets[6].c}`);
  await watcher.getByRole('button', { name: /wait to be called/ }).click();

  const composerSelects = m.locator('.composer select');
  await composerSelects.nth(0).selectOption('Terrain 3');
  await composerSelects.nth(1).selectOption('U11');
  await composerSelects.nth(2).selectOption('Rouge');
  assert.match(await m.locator('.composer textarea').inputValue(), /\{groupe\} : attendus au Terrain 3 !/);
  await m.selectOption('#grp', '0');
  await m.getByRole('button', { name: /Appeler les 3 tickets/ }).click();
  await m.waitForSelector('.result .call-title:has-text("U11 Rouge : 3 tickets appelés")');
  await shot(m, '13-appel-groupe');

  await waitText(tab.locator('.s-number'), '006 · 007 · 008');
  assert.equal(await tab.locator('.s-tag').textContent(), 'U11 Rouge · Terrain 3');
  await tab.screenshot({ path: path.join(out, '14-ecran-public.png') });
  await watcher.waitForSelector('.ready-message', { timeout: 15_000 });
  assert.equal(await watcher.locator('.ready-message').textContent(), 'U11 Rouge : attendus au Terrain 3 !');
  await watcher.screenshot({ path: path.join(out, '15-client-message.png'), fullPage: true });
  step('appel du groupe « U11 Rouge » au Terrain 3 : écran public et page du client à jour');

  // Souche avec compositeur : on choisit, on vérifie, on appelle.
  await m.goto(`${BASE}/${tickets[8].s}`);
  await m.waitForSelector('.composer');
  await m.locator('.composer select').nth(0).selectOption('Terrain 1');
  // Au moment de l'appel aussi, une variable s'insère d'un appui (et prend sa valeur dans l'aperçu).
  await m.locator('.composer textarea').press('End');
  await m.locator('.composer textarea').pressSequentially(' n°');
  await m.locator('.composer .var-chips .chip', { hasText: '{numero}' }).click();
  assert.match(await m.locator('.composer p', { hasText: 'Aperçu' }).textContent(), /Terrain 1 ! n°009/);
  await m.getByRole('button', { name: /Appeler le 009/ }).click();
  await m.waitForSelector('.result .call-title');
  await waitText(tab.locator('.s-number'), '009');
  step('souche avec message personnalisé, annoncée sur l’écran');

  // Affiche à scanner : chaque client reçoit un numéro unique tiré au hasard ; file d'arrivée ; tout le monde appelé d'un coup.
  await m.goto(`${BASE}/m`);
  await m.getByRole('button', { name: 'Imprimer' }).click();
  await m.waitForSelector('#poster-card .p-qr');
  assert.equal(await m.locator('#d-acc').isDisabled(), true); // lot gratuit : logo et couleurs grisés ici aussi
  const posterPath = new URL(await decode(m.locator('#poster-card .p-qr'))).pathname;
  assert.match(posterPath, /^\/A\/[A-Z2-7]{23}$/);
  const walkIn = await client.newPage();
  walkIn.on('pageerror', (err) => errors.push(err.message));
  await walkIn.goto(`${BASE}${posterPath}`);
  await walkIn.waitForSelector('.ticket-head .number');
  const firstNumber = await walkIn.locator('.ticket-head .number').textContent();
  assert.ok(/^\d{3}$/.test(firstNumber) && Number(firstNumber) > 30, firstNumber); // au-delà des tickets imprimés 001 à 030
  assert.equal(await walkIn.locator('.poster-hint').isVisible(), true);
  await walkIn.goto(`${BASE}${posterPath}`); // rescanner l'affiche : même numéro
  await walkIn.waitForSelector('.ticket-head .number');
  assert.equal(await walkIn.locator('.ticket-head .number').textContent(), firstNumber);
  const second = await (await browser.newContext({ locale: 'fr-FR' })).newPage();
  await second.goto(`${BASE}${posterPath}`);
  await second.waitForSelector('.ticket-head .number');
  const secondNumber = await second.locator('.ticket-head .number').textContent();
  assert.ok(/^\d{3}$/.test(secondNumber) && secondNumber !== firstNumber, secondNumber);
  await walkIn.getByRole('button', { name: /wait to be called/ }).click();
  await m.getByRole('button', { name: 'Appels' }).click();
  await m.waitForSelector(`#arrivals li:has-text("${firstNumber}")`);
  // Dans l'ordre d'arrivée, quel que soit le numéro tiré.
  const arrived = await m.locator('#arrivals li').allTextContents();
  const rank = (n) => arrived.findIndex((line) => line.includes(n));
  assert.ok(rank(firstNumber) >= 0 && rank(firstNumber) < rank(secondNumber), arrived.join(' | '));
  await shot(m, '26-file-arrivee');
  m.once('dialog', (dialog) => dialog.accept());
  await m.click('#call-all');
  await m.waitForSelector('#arrivals:has-text("Personne en attente")');
  await walkIn.waitForSelector('.ready', { timeout: 15_000 });
  step('affiche : numéros uniques tirés au hasard, file dans l’ordre d’arrivée, même numéro au rescan, tout le monde appelé d’un coup');

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

  /* ------------------------------------- compte, fiche de secours, Pro */
  await m.goto(`${BASE}/compte#creer`);
  await m.fill('#si', 'snack.tony');
  await m.fill('#sp', 'mot de passe du snack');
  await m.fill('#sp2', 'mot de passe du snack');
  // Activité du commerce, choisie à l'inscription : gardée chiffrée dans le compte.
  await m.click('#acc-act');
  await m.click('.act-block[data-id="buvette"]');
  await m.click('.act-use');
  await waitText(m.locator('.act-current b'), 'Buvette, festival, kermesse');
  await m.click('form button[type=submit]');
  await m.waitForSelector('.kit-key', { timeout: 30_000 });
  const recoveryKey = (await m.locator('.kit-key').textContent()).trim();
  assert.match(recoveryKey, /^([A-Z2-7]{4}-){6}[A-Z2-7]{2}$/);
  await shot(m, '16-fiche-de-secours');
  const [download] = await Promise.all([m.waitForEvent('download'), m.getByRole('button', { name: /Télécharger le fichier/ }).click()]);
  assert.equal(download.suggestedFilename(), 'wecallyou-secours-snack.tony.txt');
  const kitText = readFileSync(await download.path(), 'utf8');
  assert.match(kitText, /snack\.tony/);
  assert.match(kitText, new RegExp(recoveryKey));
  await m.check('#kit-ok');
  await m.getByRole('button', { name: 'Continuer' }).click();
  await m.waitForURL(`${BASE}/m`);
  step('compte créé, fiche de secours téléchargée (identifiant + clé)');

  // Compte gratuit : « Mes lots » reste visible, mais passer d'un lot à l'autre en un appui est réservé au Pro.
  await m.goto(`${BASE}/m`);
  await m.click('#my-lots');
  await m.waitForSelector('.lot-card.current');
  assert.equal(await m.locator('.pro-lock').isVisible(), true);
  assert.match(await m.locator('.lot-card.add').last().textContent(), /page clé/);
  step('compte gratuit : « Mes lots » visible, un lot à la fois (passage en un appui : Pro)');

  // Un autre téléphone : identifiant + mot de passe → il retrouve le lot, sans la page 1.
  const phone3 = await browser.newContext({ locale: 'fr-FR', viewport: { width: 390, height: 844 } });
  const p3 = await phone3.newPage();
  p3.on('pageerror', (err) => errors.push(err.message));
  await p3.goto(`${BASE}/compte`);
  await p3.fill('#li', 'Snack.Tony');
  await p3.fill('#lp', 'mot de passe du snack');
  await p3.click('form button[type=submit]');
  await p3.waitForURL(`${BASE}/m`, { timeout: 30_000 });
  await p3.waitForSelector('h1:has-text("Snack Tony")');
  // L'activité choisie à l'inscription suit le compte : proposée par défaut à la création des tickets.
  await p3.goto(`${BASE}/creer`);
  await p3.waitForSelector('#activity-slot .act-current b', { state: 'attached' });
  assert.match(await p3.locator('#activity-slot .act-current').textContent(), /Buvette/);
  step('autre téléphone : connexion par identifiant, le lot et l’activité du compte sont retrouvés');

  // Mot de passe oublié : la fiche de secours (son QR) permet d'en choisir un nouveau.
  const phone4 = await browser.newContext({ locale: 'fr-FR', viewport: { width: 390, height: 844 } });
  const p4 = await phone4.newPage();
  p4.on('pageerror', (err) => errors.push(err.message));
  await p4.goto(`${BASE}/compte#secours=snack.tony:${recoveryKey.replaceAll('-', '')}`);
  assert.equal(await p4.inputValue('#ri'), 'snack.tony');
  await p4.fill('#rp', 'nouveau mot de passe');
  await p4.fill('#rp2', 'nouveau mot de passe');
  await p4.click('form button[type=submit]');
  await p4.waitForSelector('h2:has-text("Mes files")', { timeout: 30_000 });
  assert.match(await p4.locator('.waiting-list').textContent(), /Snack Tony/);
  await shot(p4, '17-compte');
  step('mot de passe oublié : fiche de secours → nouveau mot de passe, rien perdu');

  // Page Pro : usage du compte et prix conseillé (le don, lui, reste sans contrepartie).
  await p4.goto(`${BASE}/pro`);
  await p4.waitForSelector('text=Prix conseillé pour votre usage : 1 € / mois');
  assert.equal(await p4.locator('.compare tbody th[scope="row"]').count() >= 10, true); // comparatif sur la page Pro
  await shot(p4, '18-page-pro');

  // Abonnement Pro (Stripe, simulé et signé) : 3 € pour un conseillé à 1 € = 3 mois de Pro.
  const accountId = await m.evaluate(() => JSON.parse(localStorage.getItem('wcy:account')).id);
  const event = JSON.stringify({ id: 'evt_e2e', type: 'checkout.session.completed', data: { object: { client_reference_id: accountId, mode: 'payment', amount_total: 300, customer: null } } });
  const ts = Math.floor(Date.now() / 1000);
  const signature = createHmac('sha256', 'whsec_e2e').update(`${ts}.${event}`).digest('hex');
  const hook = await fetch(`${BASE}/api/stripe/webhook`, { method: 'POST', headers: { 'Stripe-Signature': `t=${ts},v1=${signature}` }, body: event });
  assert.equal((await hook.json()).result, 'pro');
  await p4.goto(`${BASE}/compte`);
  await p4.waitForSelector('.banner-ok:has-text("Pro jusqu")');
  await p4.goto(`${BASE}/m`);
  await p4.waitForSelector('.pro-line .badge:has-text("Pro")');
  step('abonnement Pro reçu : statut actif, visible dans l’espace commerçant');

  // Options Pro : tickets de 30 jours et marque masquée, appliquées jusque chez le client.
  await p4.getByRole('button', { name: 'Réglages' }).click();
  await p4.selectOption('#st', '720');
  await p4.check('#swl');
  await p4.fill('#th-screenBg', '#14325a');
  await p4.fill('#th-screenNumber', '#ffd60a');
  await p4.fill('#th-accent', '#0a7d4f');
  await p4.click('form.stack button[type=submit]');
  await p4.waitForSelector('p.ok');
  await shot(p4, '19-options-pro');
  const brandless = await client.newPage();
  await brandless.goto(`${BASE}/${tickets[11].c}`);
  await brandless.waitForSelector('.choice');
  assert.equal((await brandless.locator('footer').textContent()).trim(), 'Privacy');
  step('options Pro : tickets 30 jours, marque masquée (seul le lien Confidentialité reste)');

  // Couleurs Pro : l'écran public et la page du client prennent les couleurs du commerce.
  assert.equal(await brandless.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--brand').trim()), '#0a7d4f');
  await tab.reload();
  await tab.waitForSelector('.s-number');
  const screenColors = async () => tab.evaluate(() => [getComputedStyle(document.getElementById('screen')).backgroundColor, getComputedStyle(document.querySelector('.s-number')).color]);
  for (let i = 0; i < 50 && (await screenColors())[0] !== 'rgb(20, 50, 90)'; i++) await tab.waitForTimeout(200);
  assert.deepEqual(await screenColors(), ['rgb(20, 50, 90)', 'rgb(255, 214, 10)']);
  await tab.screenshot({ path: path.join(out, '21-ecran-couleurs-pro.png') });
  await brandless.screenshot({ path: path.join(out, '22-client-couleurs-pro.png'), fullPage: true });
  step('couleurs Pro : écran public et page du client aux couleurs du commerce');

  // Statistiques sur un an et export CSV.
  await p4.goto(`${BASE}/m`);
  await p4.getByRole('button', { name: 'Stats' }).click();
  await p4.waitForSelector('h3:has-text("12 derniers mois")');
  const [csv] = await Promise.all([p4.waitForEvent('download'), p4.getByRole('button', { name: /Exporter en CSV/ }).click()]);
  assert.match(csv.suggestedFilename(), /^wecallyou-stats-\d+\.csv$/);
  const table = readFileSync(await csv.path(), 'utf8');
  assert.match(table, /^﻿day;scan;sub_push;sub_sms/);
  assert.match(table, /\n\d{4}-\d{2}-\d{2};\d+;/);
  await shot(p4, '20-stats-pro');
  step('statistiques Pro : 12 mois et export tableur');

  // Compte Pro : les options Pro du générateur s'ouvrent et s'appliquent au nouveau lot.
  await p4.goto(`${BASE}/creer`);
  await p4.waitForSelector('#c-wl:not([disabled])', { state: 'attached' });
  await p4.click('#c-act');
  await p4.click('.act-block[data-id="pressing"]');
  await p4.click('.act-use');
  await p4.waitForSelector('dialog.act-dialog', { state: 'detached' });
  await p4.click('#tab-info');
  await p4.fill('#name', 'Pressing Lumière');
  await p4.fill('#count', '20');
  await p4.selectOption('#ttl', '720');
  // En Pro, les couleurs du ticket s'ouvrent et passent dans l'aperçu.
  await p4.click('#tab-look');
  assert.equal(await p4.locator('#design-colors .pro-lock').isVisible(), false);
  await p4.fill('#d-tbg', '#fff6e5');
  await p4.waitForSelector('.pv-frame .sheet-tickets[style*="--t-bg: #fff6e5"]', { state: 'attached' });
  // Logo du commerce (Pro) : il remplace celui de WeCall.You, sur les tickets comme dans le bandeau de la page clé.
  const logo = new PNG({ width: 60, height: 20 });
  logo.data.fill(90);
  await p4.setInputFiles('#d-logo', { name: 'logo.png', mimeType: 'image/png', buffer: PNG.sync.write(logo) });
  await p4.waitForSelector('.pv-frame .p-logo', { state: 'attached' });
  assert.equal(await p4.locator('.pv-frame .p-brand').count(), 0);
  await p4.locator('[data-tab="key"]').dispatchEvent('click');
  await p4.waitForSelector('.pv-frame .doc-band img.doc-logo-img', { state: 'attached' });
  assert.equal(await p4.locator('.pv-frame .doc-band .doc-logo svg').count(), 0);
  await p4.locator('[data-tab="tickets"]').dispatchEvent('click');
  await p4.click('#tab-look');
  await p4.check('#c-wl');
  await p4.fill('#th-screenNumber', '#2b7fff');
  await p4.click('#create-btn');
  await p4.waitForSelector('#created:not([hidden])', { timeout: 30_000 });
  assert.equal(await p4.locator('#created .banner-warn:has-text("options Pro")').count(), 0);
  await p4.goto(`${BASE}/m`);
  await p4.waitForSelector('h1:has-text("Pressing Lumière")');
  assert.match(await p4.locator('#pc-note').textContent(), /partent de votre téléphone/); // sur ordinateur : les SMS partent du téléphone
  await p4.getByRole('button', { name: 'Réglages' }).click();
  assert.equal(await p4.locator('#st').inputValue(), '720');
  assert.equal(await p4.locator('#swl').isChecked(), true);
  assert.equal(await p4.locator('#th-screenNumber').inputValue(), '#2b7fff');
  assert.match(await p4.locator('#stp').inputValue(), /votre dépôt n°{numero}/); // le modèle « pressing » est appliqué
  assert.match(await p4.locator('#sli').inputValue(), /^Retrait :/);
  step('compte Pro : lot créé avec 30 jours, marque masquée et couleurs dès le générateur');

  // Mes lots : deux lots sur ce téléphone, on passe de l'un à l'autre depuis l'en-tête.
  await p4.click('#my-lots');
  await p4.waitForSelector('.lot-card:not(.add) .badge');
  assert.equal(await p4.locator('.lot-card:not(.add)').count(), 2);
  assert.match(await p4.locator('.lot-card.current').textContent(), /Pressing Lumière/);
  await shot(p4, '25-mes-lots');
  await p4.locator('.lot-card', { hasText: 'Snack Tony' }).click();
  await p4.waitForSelector('h1:has-text("Snack Tony")');
  assert.match(await p4.locator('#my-lots').textContent(), /(2)/);
  step('mes lots : liste des lots du téléphone, passage d’un lot à l’autre');

  // Votez pour la suite : sans compte, on lit le classement ; avec, trois voix, et le classement suit.
  {
    const visitor = await (await browser.newContext({ locale: 'fr-FR' })).newPage();
    visitor.on('pageerror', (err) => errors.push(err.message));
    await visitor.goto(`${BASE}/voter`);
    await visitor.waitForSelector('#projet-file .ideas-open li');
    assert.equal(await visitor.locator('#rankings .ranking').count(), 3); // file d'attente, communauté, prochain outil
    assert.match(await visitor.locator('#vote-status').textContent(), /il faut un compte/);
    assert.match(await visitor.locator('#idea-stats .idea-cost').textContent(), /avec un développeur/);
    // L'IA, mesurée sur les évolutions déjà livrées (couts.json) : une fourchette de jetons et de dollars.
    assert.match(await visitor.locator('#idea-stats .idea-cost').textContent(), /IA : [\d,\s]+ M à [\d,\s]+ M de jetons \(≈ [\d,]+ \$ à [\d,]+ \$ au tarif de l’API\)/);
    assert.match(await visitor.locator('#rates-list').textContent(), /mesuré sur les \d+ évolutions déjà livrées/);
    await visitor.close();
    await p4.goto(`${BASE}/voter`);
    await waitText(p4.locator('#votes-left'), 'Il vous reste 3 voix sur 3.');
    await p4.click('#idea-stats .vote-btn');
    await waitText(p4.locator('#votes-left'), 'Il vous reste 2 voix sur 3.');
    assert.equal(await p4.locator('#projet-file .ideas-open li').first().getAttribute('id'), 'idea-stats'); // en tête de son classement
    assert.equal(await p4.locator('#idea-stats .vote-btn').getAttribute('aria-pressed'), 'true');
    assert.ok((await p4.locator('#ideas-done li').count()) >= 1);
    await shot(p4, '31-votez');
    await p4.click('#idea-stats .vote-btn'); // retirer sa voix
    await waitText(p4.locator('#votes-left'), 'Il vous reste 3 voix sur 3.');
  }
  step('votez pour la suite : lecture sans compte, trois voix par compte, classement en direct');

  /* ------------------------------------------- studio d'impression */
  await m.goto(`${BASE}/m`);
  await m.getByRole('button', { name: 'Imprimer' }).click();
  const printAll = async () => {
    await m.waitForTimeout(150);
    await m.locator('.studio-form .btn-big').first().click();
    await m.waitForSelector('.print-root .sheet', { state: 'attached' });
  };
  const sheet = (i = 0) => m.locator('.print-root .sheet').nth(i);

  // Ce lot appartient désormais au compte devenu Pro : logo et couleurs ouverts.
  assert.equal(await m.locator('#d-acc').isDisabled(), false);
  // Grille proposée : 24 tickets par page.
  await m.fill('#d-cols', '3');
  await m.fill('#d-rows', '8');
  await printAll();
  assert.equal(await sheet().locator('.pair').count(), 24);
  await m.emulateMedia({ media: 'print' });
  await sheet().screenshot({ path: path.join(out, '13-page-24-tickets.png') });
  await m.emulateMedia({ media: 'screen' });
  step('impression 24 tickets par page');

  // Deux souches par ticket (commande + cuisine), zones de découpe visibles dans l'aperçu.
  await m.click('[data-stubs="2"]');
  await printAll();
  assert.equal(await sheet().locator('.pair').first().locator('.part.stub').count(), 2);
  await m.click('.pv-fab'); // sur téléphone, l'aperçu s'ouvre en plein écran
  await m.click('#pv-cuts');
  assert.equal(await m.locator('.pv-frame.show-cuts').count(), 1);
  await m.screenshot({ path: path.join(out, '27-decoupes.png') });
  await m.click('.pv-close');
  await m.click('[data-align="left"]');
  await printAll();
  assert.equal(await sheet().evaluate((el) => el.classList.contains('align-left')), true);
  await m.click('[data-stubs="1"]');
  step('deux souches par ticket, alignement à gauche, zones de découpe visibles');

  // Papier du catalogue : étiquettes 63,5 × 38,1 mm, le ticket et sa souche sur deux étiquettes voisines.
  await m.click('#d-catalog');
  await m.locator('dialog.catalog .product', { hasText: '63,5 × 38,1' }).getByRole('button', { name: 'Utiliser ce papier' }).click();
  await m.waitForSelector('.product-line:has-text("63,5 × 38,1")');
  await printAll();
  assert.equal(await sheet().locator('.pair.stub-cell').count(), 20); // 10 paires + 1 étiquette libre
  assert.equal(await sheet().locator('.pair.empty').count(), 1);
  await m.emulateMedia({ media: 'print' });
  const labelCell = await sheet().locator('.pair').first().boundingBox();
  assert.ok(Math.abs(labelCell.width / labelCell.height - 63.5 / 38.1) < 0.02);
  await sheet().screenshot({ path: path.join(out, '23-etiquettes-21.png') });
  await m.emulateMedia({ media: 'screen' });
  step('papier du catalogue : planche de 21 étiquettes, ticket et souche côte à côte');

  // Imprimante à tickets : rouleau 80 mm, un ticket par page, en noir.
  await m.selectOption('#d-paper', 'roll80');
  await printAll();
  assert.equal(await m.locator('.print-root .sheet').count(), 30);
  assert.equal(await sheet().evaluate((el) => el.classList.contains('mono')), true);
  assert.equal(await sheet().locator('.part.stub').count(), 1);
  await m.emulateMedia({ media: 'print' });
  await sheet().screenshot({ path: path.join(out, '24-rouleau-80mm.png') });
  await m.emulateMedia({ media: 'screen' });
  step('rouleau 80 mm : un ticket par page, souche détachable, noir seul');

  // Page clé : tient sur sa feuille en français et en anglais, gratuit ou Pro, avec mot de passe et nom très long.
  await m.emulateMedia({ media: 'print' });
  const keyOverflow = await m.evaluate(async () => {
    const { keySheet } = await import('/assets/sheets.js');
    const bad = [];
    for (const lang of ['fr', 'en'])
      for (const pro of [false, true])
        for (const name of ['Snack', 'Association sportive du Grand Stade — buvette et restauration']) {
          const sheet = keySheet({ lang, domain: 'wecall.you', brand: 'WeCall.You', lot: 1301721212, name, secret: new Uint8Array(16), from: 1, to: 999999, monthlyCost: 21, password: true, pro, screen: 'A'.repeat(23) });
          document.body.append(sheet);
          if (sheet.scrollHeight > sheet.clientHeight + 1) bad.push(`${lang} pro=${pro} ${name.length} car. : ${sheet.scrollHeight} > ${sheet.clientHeight}`);
          sheet.remove();
        }
    return bad;
  });
  await m.emulateMedia({ media: 'screen' });
  assert.deepEqual(keyOverflow, []);
  step('page clé : tient sur la feuille (FR/EN, gratuit/Pro, mot de passe, nom long)');

  // Aucun débordement : chaque élément reste dans sa case, quels que soient papier, grille et souche.
  const overflow = await m.evaluate(async () => {
    const { ticketSheets, contentOf } = await import('/assets/sheets.js');
    const { normalizeDesign, presetGrids, gridLimits } = await import('/assets/layout.js');
    const papers = [{ paper: 'a4' }, { paper: 'a4', orientation: 'landscape' }, { paper: 'letter' }, { paper: 'a6' }, { paper: 'roll80' }, { paper: 'roll58' }, { paper: 'custom', pw: 50, ph: 30, margins: [1, 1, 1, 1] }, { paper: 'a4', margins: [0, 0, 0, 0] }];
    const variants = [{ name: 'Snack', last: 120 }, { name: 'Le Grand Restaurant de la Place du Marché — Service continu', last: 999999 }, { name: 'Pressing', last: 4500, whiteLabel: true }];
    const box = document.createElement('div');
    document.body.append(box);
    const problems = [];
    let checked = 0;
    for (const paper of papers) {
      for (const [stub, stubs] of [['auto', 1], ['right', 1], ['bottom', 1], ['cell', 1], ['none', 0], ['right', 3], ['bottom', 3], ['cell', 2]]) {
        for (const v of variants) {
          const base = normalizeDesign({ ...paper, stub, stubs });
          const c = contentOf(base, { lang: 'fr', domain: 'wecallyou.fantinati.fr', ...v });
          const grids = presetGrids(base, c);
          const lim = gridLimits({ ...base, cols: 1, rows: 1 }, c);
          for (const g of [grids[0], grids[Math.floor(grids.length / 2)], grids.at(-1), { cols: lim.cols, rows: 1 }, { cols: 1, rows: lim.rows }]) {
            if (!g?.cols || !g?.rows) continue;
            const tickets = [0, 1].map((i) => ({ label: String(v.last - i).padStart(3, '0'), c: 'A'.repeat(26), s: 'B'.repeat(26) }));
            const [page] = ticketSheets(tickets, { ...base, cols: g.cols, rows: g.rows, lang: 'fr', domain: 'wecallyou.fantinati.fr', ...v });
            if (!page) continue;
            box.replaceChildren(page);
            checked++;
            for (const part of page.querySelectorAll('.part')) {
              const r = part.getBoundingClientRect();
              const cs = getComputedStyle(part);
              const inner = { l: r.left + parseFloat(cs.paddingLeft) - 1, t: r.top + parseFloat(cs.paddingTop) - 1, r: r.right - parseFloat(cs.paddingRight) + 1, b: r.bottom - parseFloat(cs.paddingBottom) + 1 };
              for (const el of part.querySelectorAll('.p-qr, .p-logo, .p-name, .p-num, .p-scan, .p-sub, .p-domain, .p-tag, .p-hint')) {
                const e = el.getBoundingClientRect();
                const cut = el.matches('.p-name, .p-domain'); // coupés volontairement par « … »
                const over = Math.max(inner.t - e.top, e.bottom - inner.b, cut ? 0 : inner.l - e.left, cut ? 0 : e.right - inner.r, cut ? 0 : el.scrollWidth - el.clientWidth - 1);
                if (over > 0.5) problems.push(`${JSON.stringify(paper)} ${stub} ${g.cols}×${g.rows} ${el.className}`);
              }
            }
          }
        }
      }
    }
    box.remove();
    return { checked, problems };
  });
  assert.deepEqual(overflow.problems, []);
  step(`mise en page : aucun débordement sur ${overflow.checked} combinaisons (papier, grille, souche, nom long, 6 chiffres)`);

  // Langue : le drapeau de l'en-tête passe tout en allemand, tickets compris (une seule langue) ;
  // recto-verso : chaque page a son dos, avec le mode d'emploi au dos de chaque ticket, sans débordement.
  {
    const ctx = await browser.newContext({ locale: 'fr-FR', viewport: { width: 1280, height: 900 } });
    const p = await ctx.newPage();
    p.on('pageerror', (err) => errors.push(err.message));
    await p.goto(`${BASE}/creer`);
    await p.click('.lang-btn');
    await p.click('.lang-menu a[lang="de"]');
    await p.waitForSelector('html[lang="de"]');
    await waitText(p.locator('#tab-info [data-i18n="tab_info"]'), 'Angaben');
    await p.fill('#name', 'Stadion-Imbiss');
    await p.click('#tab-look');
    await p.check('#d-verso');
    await p.locator('.pv-frame .sheet-tickets .p-scan').first().waitFor({ state: 'attached' });
    const scan = await p.locator('.pv-frame .p-scan').first().textContent();
    assert.ok(scan && !/Scannez/.test(scan), scan); // ticket en allemand
    assert.equal(await p.locator('.pv-frame .p-sub').count(), 0); // une seule langue
    await p.locator('.studio-preview [data-tab="back"]').click();
    await p.waitForSelector('.pv-frame .sheet-back .back-steps li', { state: 'attached' });
    assert.equal(await p.locator('.pv-frame .sheet-back .back-steps').first().locator('.b-num').count(), 3);
    const overflow = await p.locator('.pv-frame .sheet-back .part.back-steps').evaluateAll((parts) => parts.filter((part) => part.scrollHeight > part.clientHeight + 1 || part.scrollWidth > part.clientWidth + 1).length);
    assert.equal(overflow, 0);
    await shot(p, '28-verso-allemand');
    await ctx.close();
  }
  step('langue : menu drapeau (allemand) ; recto-verso : dos en miroir avec le mode d’emploi, sans débordement');

  // « Les deux » (tickets + affiche) : numéros mélangés dès les tickets imprimés, plus de « premier numéro ».
  {
    const ctx = await browser.newContext({ locale: 'fr-FR', viewport: { width: 1280, height: 900 } });
    const p = await ctx.newPage();
    p.on('pageerror', (err) => errors.push(err.message));
    await p.goto(`${BASE}/creer`);
    await p.waitForSelector('#c-act', { state: 'attached' });
    assert.equal(await p.locator('#first-field').isHidden(), false);
    await p.check('input[name=mode][value=both]', { force: true }); // le bouton entier est la case (invisible) du choix
    assert.equal(await p.locator('#first-field').isHidden(), true);
    await p.locator('.pv-frame .part.client .p-num').first().filter({ hasNotText: '001' }).waitFor();
    const labels = (await p.locator('.pv-frame .part.client .p-num').allTextContents()).map(Number);
    assert.equal(new Set(labels).size, labels.length);
    assert.ok(labels.some((n, i) => i > 0 && n < labels[i - 1]), labels.join(',')); // pas dans l'ordre
    // Téléphone du client et « Tout », sans promo ni lien (cas qui plantait).
    await p.locator('.studio-preview [data-tab="client"]').click();
    await p.waitForSelector('.pv-frame .pv-phones .pvp-ready', { state: 'attached' });
    assert.equal(await p.locator('.pv-frame .pvp-promo').count(), 0);
    await p.locator('.studio-preview [data-tab="all"]').click();
    await p.waitForSelector('.pv-frame .pv-all .pv-tile-client .pvp-ready', { state: 'attached' });
    assert.ok((await p.locator('.pv-frame .pv-all .pv-tile').count()) >= 4);
    // Maçonnerie : dans chaque rangée, des vignettes de même hauteur qui remplissent toute la largeur.
    await p.waitForSelector('.pv-frame .pv-all .pv-row', { state: 'attached' });
    const rows = await p.locator('.pv-frame .pv-all').evaluate((box) => [...box.querySelectorAll('.pv-row')].map((row) => {
      const tiles = [...row.children].map((tile) => tile.getBoundingClientRect());
      return { heights: tiles.map((r) => r.height), used: tiles.at(-1).right - tiles[0].left, width: box.clientWidth };
    }));
    for (const row of rows) {
      assert.ok(Math.max(...row.heights) - Math.min(...row.heights) < 1.5, JSON.stringify(row));
      assert.ok(Math.abs(row.used - row.width) < 2, JSON.stringify(row));
    }
    await ctx.close();
  }
  step('« les deux » : numéros des tickets mélangés dans l’aperçu, pas de premier numéro ; vues Client et Tout sans promo');

  // Soutenir : l'objectif du mois, les chapitres, et le soutien une fois, chaque mois ou chaque année.
  {
    const ctx = await browser.newContext({ locale: 'fr-FR', viewport: { width: 390, height: 844 } });
    const p = await ctx.newPage();
    p.on('pageerror', (err) => errors.push(err.message));
    await p.goto(`${BASE}/soutenir`);
    await p.waitForSelector('#challenge:not([hidden]) #ch-raised');
    // Montant du premier palier : calculé d'après l'affluence (un an de serveurs à la demande).
    assert.match(await p.locator('#ch-goal').textContent(), /sur \d[\d\s]*\s€ pour ce palier/); // espace fine insécable avant €
    assert.match(await p.locator('#ch-title').textContent(), /serveurs à la demande/);
    assert.equal(await p.locator('#roadmap li.next').count(), 1);
    assert.match(await p.locator('#costs').textContent(), /2,50\s€/);
    // Fait avec presque rien : ce que le projet a coûté, mesuré (couts.json).
    await p.waitForSelector('#frugal:not([hidden])');
    assert.match(await p.locator('#f-summary').textContent(), /^En \d+ jours?, \d+ évolutions? et [\d\s]+ lignes de code : \d+ h \d\d du fondateur et [\d,]+\s€ d’intelligence artificielle/);
    assert.match(await p.locator('#f-table').textContent(), /30\s€ par an.*36\s€ par an/);
    // Ce qui a été payé et la valeur du travail de l'IA, à ne pas confondre : c'est expliqué.
    assert.match(await p.locator('#f-why').textContent(), /^Pourquoi [\d,]+\s€ et pas [\d\s,]+ \$ \?.*d’un mois d’abonnement/);
    assert.match(await p.locator('#costs').textContent(), /IA pour développer les fonctions votées \(réellement payée, 30 derniers jours\)/);
    assert.equal(await p.locator('#f-last li').count(), 5);
    // Le service tient-il la route ? Le bulletin du mois (files et clients des parcours précédents) et le simulateur.
    await p.waitForSelector('#h-month:not([hidden])');
    assert.match(await p.locator('#h-month').textContent(), /^Ce mois-ci, \d+ files? (a|ont) accueilli \d+ clients?/);
    assert.match(await p.locator('#h-verdict').textContent(), /tient la route|besoin de vous|se prépare/);
    assert.match(await p.locator('#h-capacity').textContent(), /environ 1\s700 clients en attente.*prévue vers 1\s300/);
    assert.match(await p.locator('#sim-start').textContent(), /^Point de départ : (l’affluence réelle|un exemple)/);
    // Les curseurs font bouger le simulateur, et les montants du plan (chapitres, prochain palier).
    const slide = (id, value) => p.locator(id).evaluate((el, v) => {
      el.value = v;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }, String(value));
    await slide('#sim-queues', 3);
    await slide('#sim-clients', 50);
    await slide('#sim-hours', 4);
    assert.equal(await p.locator('#sim-clients-out').textContent(), '50');
    assert.match(await p.locator('#sim-result').textContent(), /150 clients en attente/);
    assert.match(await p.locator('.sim-verdict').textContent(), /La lune suffit/);
    const goalBefore = await p.locator('#ch-goal').textContent();
    await slide('#sim-queues', 100);
    await slide('#sim-clients', 200);
    await slide('#sim-hours', 12);
    assert.match(await p.locator('#sim-result').textContent(), /20\s000 clients en attente/);
    assert.match(await p.locator('.sim-verdict').textContent(), /Au-delà de la lune/);
    assert.match(await p.locator('#sim-result').textContent(), /≈ \d[\d\s]*(,\d+)?\s€ \/ mois/);
    assert.notEqual(await p.locator('#ch-goal').textContent(), goalBefore); // le palier suit l'affluence simulée
    assert.match(await p.locator('#roadmap').textContent(), /pour un an de serveurs à la demande/);
    assert.match(await p.locator('.story:not([hidden]) .motto').textContent(), /Un outil aujourd’hui, une association demain/);
    // « Prendre une licence » fuit toujours la souris et désigne le vrai bouton ; il ne s'ouvre jamais.
    const runaway = p.locator('#runaway-btn');
    await runaway.scrollIntoViewIfNeeded();
    for (let i = 0; i < 4; i++) {
      const box = await runaway.boundingBox();
      await p.mouse.move(box.x + box.width / 2 + 40, box.y + box.height / 2);
      await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 4 });
      await p.waitForTimeout(450);
    }
    await runaway.click({ force: true });
    assert.equal(await p.locator('#offer-chooser').isHidden(), true);
    assert.match(await p.locator('.runaway-says').textContent(), /→/);
    // Au clavier : il ne fuit pas, il envoie vers « Soutenir le projet ».
    await runaway.focus();
    await p.keyboard.press('Enter');
    assert.equal(await p.evaluate(() => document.activeElement?.id), 'support-btn');
    // Le vrai bouton : soutenir le projet, la licence en prime (se connecter pour la recevoir).
    await p.click('#support-btn');
    await p.getByRole('button', { name: 'Chaque année' }).click();
    assert.match(await p.locator('.donate .impact').textContent(), /par an/);
    assert.match(await p.locator('#offer-chooser').textContent(), /connectez-vous/);
    assert.match(await p.locator('.donate').textContent(), /micro-entreprise du fondateur/);
    await shot(p, '30-soutenir');
    await ctx.close();
  }
  step('soutenir : objectif, bulletin de santé et simulateur, devise, bouton licence qui fuit toujours, « Soutenir le projet » (licence en prime), mention de la micro-entreprise');

  // Barre du haut : le logo et le menu ne se chevauchent jamais, quelle que soit la page (étroite ou large) et l'écran.
  {
    const ctx = await browser.newContext({ locale: 'fr-FR' });
    const p = await ctx.newPage();
    const pages = ['/', '/compte', '/m', '/pro', '/soutenir', '/mentions', '/creer'];
    for (const width of [340, 390, 768, 1024, 1440]) {
      await p.setViewportSize({ width, height: 800 });
      for (const url of pages) {
        await p.goto(`${BASE}${url}`);
        await p.waitForSelector('.topnav svg');
        const brand = await p.locator('.topbar .brand').boundingBox();
        const nav = await p.locator('.topnav').boundingBox();
        assert.ok(brand.x + brand.width <= nav.x + 1, `${url} à ${width} px : le logo passe sous le menu`);
        assert.ok(nav.x + nav.width <= width + 1, `${url} à ${width} px : le menu sort de l'écran`);
      }
    }
    await ctx.close();
  }
  step('barre du haut : logo et menu sans chevauchement sur 7 pages × 5 largeurs');

  // Notifications : à chaque visite, la page du client vérifie qu'elles sont toujours autorisées et abonnées.
  {
    const code = tickets[25].c;
    for (const [granted, expected] of [[false, /bloquées/], [true, /plus abonné/]]) {
      const ctx = await browser.newContext({ locale: 'fr-FR', viewport: { width: 390, height: 844 } });
      // Navigateur sans tête : les notifications y restent refusées ; on simule « autorisées » (sans abonnement).
      if (granted) await ctx.addInitScript(() => Object.defineProperty(Notification, 'permission', { get: () => 'granted' }));
      await ctx.addInitScript(([key]) => localStorage.setItem(key, JSON.stringify({ rid: 'r-test', kind: 'push', endpoint: 'https://push.example/ancien' })), [`wcy:t:${code.toUpperCase()}`]);
      const p = await ctx.newPage();
      p.on('pageerror', (err) => errors.push(err.message));
      await p.goto(`${BASE}/${code}`);
      await p.waitForSelector('#push-warn', { timeout: 10_000 });
      assert.match(await p.locator('#push-warn').textContent(), expected);
      assert.equal(await p.locator('#push-test').count(), 1); // bouton « notification de test »
      if (granted) await shot(p, '29-notification-perdue');
      await ctx.close();
    }
  }
  step('notifications : alerte si bloquées ou abonnement perdu, boutons de réactivation et d’essai');

  assert.deepEqual(errors, []);
  step('aucune erreur JavaScript');
} finally {
  await browser.close();
  server.closeAllConnections();
  server.close();
}
