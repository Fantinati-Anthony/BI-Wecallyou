// Mise en page des tickets (public/assets/layout.js) : tout papier, toute grille, jamais de
// QR code illisible ; le catalogue de papiers tient ses promesses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PAPERS, STUBS, LIMITS, QR_MIN_MM, QR_MIN_THERMAL_MM, DEFAULT_DESIGN, PRO_DESIGN, normalizeDesign, withoutPro, pageOf, gridOf, fitDesign, gridLimits, fitGrid, presetGrids } from '../../public/assets/layout.js';

const LANGS = ['fr', 'en', 'de', 'es', 'it', 'pl', 'ro', 'nl'];

const content = (extra = {}) => ({
  head: 'name',
  name: 'Snack du Stade',
  logoRatio: 2,
  showNumber: true,
  label: '120',
  scan: 'Scannez : on vous prévient',
  scanSub: 'Scan: we’ll notify you',
  domain: 'wecallyou.fantinati.fr',
  tag: 'SOUCHE',
  hint: 'à coller sur la commande',
  ...extra,
});

test('réglages : valeurs bornées, ancien format repris, rouleau toujours en noir', () => {
  const d = normalizeDesign({ paper: 'nope', cols: 99, rows: -3, margins: [1, 2], ticketBg: 'red', logo: 'javascript:alert(1)', stub: 'x' });
  assert.equal(d.paper, 'a4');
  assert.equal(d.cols, LIMITS.cols[1]);
  assert.equal(d.rows, LIMITS.rows[0]);
  assert.deepEqual(d.margins, [8, 8, 8, 8]);
  assert.equal(d.ticketBg, '#ffffff');
  assert.equal(d.logo, null);
  assert.equal(d.stub, 'auto');
  const legacy = normalizeDesign({ perPage: 24 });
  assert.deepEqual([legacy.cols, legacy.rows], [3, 8]);
  const roll = normalizeDesign({ paper: 'roll80', orientation: 'landscape', mono: false });
  assert.equal(roll.mono, true);
  assert.equal(roll.orientation, 'portrait');
  assert.equal(roll.cut, false);
  assert.deepEqual(roll.margins, PAPERS.roll80.margins);
  assert.deepEqual(pageOf(normalizeDesign({ orientation: 'landscape' })), { w: 297, h: 210 });
  assert.deepEqual(pageOf(normalizeDesign({ paper: 'custom', pw: 62, ph: 29 })), { w: 62, h: 29 });
});

test('étiquettes : les cases tombent exactement sur les cotes du fabricant', () => {
  const { cell } = gridOf(normalizeDesign({ paper: 'a4', margins: [15.15, 7.21, 15.15, 7.21], gapX: 2.54, cols: 3, rows: 7 }));
  assert.ok(Math.abs(cell.w - 63.5) < 0.01 && Math.abs(cell.h - 38.1) < 0.01, `${cell.w} × ${cell.h}`);
});

test('toute grille acceptée garde des QR codes lisibles, et la limite est exacte', () => {
  const c = content();
  for (const paper of Object.keys(PAPERS)) {
    for (const orientation of ['portrait', 'landscape']) {
      for (const stub of STUBS) {
        const base = normalizeDesign({ paper, orientation, stub, pw: 90, ph: 60 });
        const limits = gridLimits({ ...base, cols: 1, rows: 1 }, c);
        for (const [cols, rows] of [[1, 1], [limits.cols, 1], [1, limits.rows], [2, 3]]) {
          if (!cols || !rows) continue;
          const fit = fitDesign({ ...base, cols, rows }, c);
          if (!fit.ok) continue;
          const qMin = base.mono ? QR_MIN_THERMAL_MM : QR_MIN_MM;
          assert.ok(fit.qr >= qMin, `${paper} ${stub} ${cols}×${rows} : QR ${fit.qr}`);
          assert.ok(fit.client.items.includes('scan'), 'la consigne « Scannez » reste toujours');
          if (fit.stubPart) assert.ok(fit.stubPart.items.includes('number'), 'la souche garde toujours son numéro');
        }
        // Une colonne ou une ligne de plus que la limite ne tient plus.
        if (limits.cols && limits.cols < LIMITS.cols[1]) assert.equal(fitDesign({ ...base, cols: limits.cols + 1, rows: 1 }, c).ok, false);
        if (limits.rows && limits.rows < LIMITS.rows[1]) assert.equal(fitDesign({ ...base, cols: 1, rows: limits.rows + 1 }, c).ok, false);
      }
    }
  }
});

test('une grille trop serrée est réduite jusqu’à tenir ; les grilles proposées tiennent toutes', () => {
  const c = content({ label: '999999' });
  const tight = normalizeDesign({ paper: 'a6', cols: 12, rows: 24 });
  assert.equal(fitDesign(tight, c).ok, false);
  const fixed = fitGrid(tight, c);
  assert.equal(fitDesign(fixed, c).ok, true);
  assert.ok(fixed.cols * fixed.rows < 12 * 24);
  const grids = presetGrids(normalizeDesign({ paper: 'a4' }), c);
  assert.ok(grids.length >= 8);
  for (const g of grids) assert.equal(fitDesign(normalizeDesign({ paper: 'a4', cols: g.cols, rows: g.rows }), c).ok, true);
});

test('la souche ne dépasse jamais les tailles du ticket client', () => {
  for (const paper of ['a4', 'roll80', 'roll58', 'a6']) {
    const fit = fitDesign(normalizeDesign({ paper, cols: 1, rows: 1, stub: 'bottom' }), content());
    assert.ok(fit.stubPart.t <= fit.client.t + 1e-9);
    assert.ok(fit.stubPart.n <= Math.max(fit.client.n, fit.stubPart.t * 1.5) + 1e-9);
  }
});

test('catalogue de papiers : identifiants uniques, liens https, chaque papier tient avec 6 chiffres', () => {
  const { products } = JSON.parse(readFileSync(new URL('../../public/papiers.json', import.meta.url), 'utf8'));
  assert.equal(new Set(products.map((p) => p.id)).size, products.length);
  for (const product of products) {
    assert.match(product.id, /^[\w-]{1,40}$/);
    assert.ok(['sheet', 'perforated', 'labels', 'roll'].includes(product.kind), product.id);
    assert.ok(product.name.fr && product.name.en, product.id);
    assert.ok(product.url === '' || /^https:\/\//.test(product.url), product.id);
    for (const label of ['001', '999999']) {
      const fit = fitDesign(normalizeDesign(product.design), content({ label }));
      assert.equal(fit.ok, true, `${product.id} (${label})`);
    }
  }
});

test('modèles par activité : valides pour le serveur, dans les 8 langues, sans virgule dans les options', async () => {
  const { activities } = JSON.parse(readFileSync(new URL('../../public/activites.json', import.meta.url), 'utf8'));
  const { LIFETIMES, PRO_LIFETIMES } = await import('../lib/store.js');
  const icons = readFileSync(new URL('../../public/assets/icons.js', import.meta.url), 'utf8');
  assert.ok(activities.length >= 6);
  assert.equal(new Set(activities.map((a) => a.id)).size, activities.length);
  for (const activity of activities) {
    assert.ok(icons.includes(`'${activity.icon}':`), `${activity.id} : icône ${activity.icon}`);
    assert.ok([...LIFETIMES, ...PRO_LIFETIMES].includes(activity.ttl), `${activity.id} : durée`);
    for (const lang of LANGS) {
      const { template, lists } = activity[lang];
      assert.ok(activity.name[lang] && activity.demo[lang], `${activity.id} : nom ${lang}`);
      assert.ok(lists.every((l) => l.name.length <= 24), `${activity.id} : nom de liste trop long (${lang})`);
      assert.ok(template.length <= 280);
      assert.ok(lists.length <= 5);
      for (const list of lists) {
        assert.match(list.name, /^[\p{L}\p{N}][\p{L}\p{N} _-]*$/u, `${activity.id} : liste ${list.name}`);
        assert.ok(template.includes(`{${list.name}}`), `${activity.id} : {${list.name}} absent du message ${lang}`);
        for (const option of list.options) {
          assert.ok(option.length <= 60 && !option.includes(',') && !option.includes('>'), `${activity.id} : option « ${option} »`);
        }
      }
    }
  }
});

test('plusieurs souches : chacune garde un QR lisible ; sur étiquettes, le ticket et ses souches se suivent', () => {
  const c = content();
  for (const stubs of [1, 2, 3]) {
    for (const stub of ['right', 'bottom']) {
      const fit = fitDesign(normalizeDesign({ paper: 'a4', cols: 1, rows: 4, stub, stubs }), c);
      assert.equal(fit.ok, true, `${stubs} × ${stub}`);
      assert.equal(fit.stubs, stubs);
      assert.ok(fit.stubPart.q >= QR_MIN_MM);
    }
  }
  const labels = normalizeDesign({ paper: 'a4', margins: [15.15, 7.21, 15.15, 7.21], gapX: 2.54, cols: 3, rows: 7, stub: 'cell', stubs: 2 });
  assert.equal(fitDesign(labels, c).perPage, 7); // 21 étiquettes : 7 tickets avec 2 souches chacun
  assert.equal(normalizeDesign({ stubs: 0, stub: 'right' }).stub, 'none');
  assert.equal(normalizeDesign({ stub: 'none', stubs: 2 }).stubs, 0);
  assert.equal(normalizeDesign({ stubs: 9 }).stubs, 3);
  assert.equal(normalizeDesign({ align: 'diagonale' }).align, 'auto');
});

test('sans Pro : couleurs d’origine et pas de logo, le reste de la mise en page est gardé', () => {
  const logo = 'data:image/png;base64,iVBORw0KGgo=';
  const chosen = { paper: 'a5', cols: 1, rows: 2, stubs: 2, align: 'left', mono: false, ticketBg: '#fff6e5', accent: '#0a7d4f', stubBg: '#e6f0ff', logo, logoRatio: 3 };
  const free = withoutPro(chosen);
  for (const key of PRO_DESIGN) assert.equal(free[key], DEFAULT_DESIGN[key], key);
  assert.equal(free.logoRatio, DEFAULT_DESIGN.logoRatio);
  const kept = normalizeDesign(chosen);
  for (const key of ['paper', 'cols', 'rows', 'stubs', 'stub', 'align', 'mono', 'showNumber']) assert.deepEqual(free[key], kept[key], key);
  assert.equal(kept.logo, logo); // en Pro, rien n'est retiré
});

test('traductions : les 8 langues ont les mêmes clés, les mêmes variables et aucun tiret long', async () => {
  const load = async (lang) => (await import(`../../public/assets/i18n/${lang}.js`)).default;
  const fr = await load('fr');
  // Les noms de variables des modèles de message ({nom}, {name}…) changent selon la langue ; les autres, jamais.
  const vars = (text) => [...text.matchAll(/{([^}]+)}/g)].map((m) => m[1]).filter((v) => !/^(nom|numero|groupe|name|number|group|Lieu|Place|Where|Ort|Lugar|Luogo|Miejsce|Loc|Plaats)$/.test(v)).sort().join();
  for (const lang of LANGS) {
    const texts = await load(lang);
    assert.deepEqual(Object.keys(texts), Object.keys(fr), lang);
    for (const [key, text] of Object.entries(texts)) {
      assert.equal(typeof text, 'string', `${lang}.${key}`);
      assert.equal(vars(text), vars(fr[key]), `${lang}.${key} : variables`);
      assert.ok(!text.includes('—'), `${lang}.${key} : tiret long`);
    }
    // Les variables intégrées comprises par le serveur : {nom}/{name}, {numero}/{number}, {groupe}/{group}.
    assert.ok(texts.var_builtins.split(',').every((v) => ['nom', 'numero', 'groupe', 'name', 'number', 'group'].includes(v)), `${lang}.var_builtins`);
  }
});
