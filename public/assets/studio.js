// Studio d'impression : papier (et catalogue de papiers compatibles), grille, souche, couleurs,
// logo et aperçu en direct. Utilisé à la création d'un lot et dans l'espace commerçant (onglet
// Imprimer). Tout se passe dans le navigateur : ces réglages ne coûtent rien au serveur, ils
// restent donc gratuits pour tous.
import { h, t, LANG, render, icon } from './common.js';
import { PAPERS, LIMITS, QR_WARN_MM, MAX_STUBS, normalizeDesign, fitDesign, fitGrid, gridLimits, presetGrids, pageOf, gridOf, contentKey } from './layout.js';
import { contentOf, ticketSheets, keySheet, labelOf, posterSheet } from './sheets.js';
import { readLogo, pagesFor } from './print.js';
import { base32, randomBytes } from './crypto.js';

const SWATCHES = ['#ffffff', '#fff6e5', '#fde9e1', '#e6f0ff', '#e3f4ea', '#f3e8ff', '#1d1b18', '#e8572a'];
const PAPER_ORDER = ['a4', 'letter', 'a5', 'a6', 'a3', 'roll80', 'roll58', 'custom'];
const STUB_PLACES = ['auto', 'right', 'bottom', 'cell'];
const ALIGN_ICONS = { auto: 'magic-wand', left: 'text-align-left', center: 'text-align-center', right: 'text-align-right' };
/** Grille proposée quand on change de papier (réduite ensuite si elle ne tient pas). */
const GRID_DEFAULTS = { a4: [2, 6], letter: [2, 6], a5: [2, 3], a6: [1, 2], a3: [3, 8], roll80: [1, 1], roll58: [1, 1], custom: [1, 1] };
/** Réglages qui déplacent les cases : les modifier détache le papier choisi dans le catalogue. */
const GEOMETRY = ['paper', 'orientation', 'pw', 'ph', 'margins', 'gapX', 'gapY', 'cols', 'rows'];

export const mmText = (v) => (Math.round(v * 10) / 10).toLocaleString(LANG);

/* ---------------------------------------------------------------- champs */

function colorField(id, label, onChange) {
  const input = h('input', { type: 'color', id, class: 'color' });
  input.addEventListener('input', () => onChange(input.value));
  const swatches = h(
    'div',
    { class: 'swatches' },
    SWATCHES.map((color) => {
      const swatch = h('button', { type: 'button', class: 'swatch', title: color, 'aria-label': color });
      swatch.style.background = color;
      swatch.addEventListener('click', () => {
        input.value = color;
        onChange(color);
      });
      return swatch;
    }),
  );
  return { input, element: h('div', { class: 'field' }, h('label', { for: id }, label), h('div', { class: 'row' }, input, swatches)) };
}

/** Champ numérique : la valeur est bornée, et réaffichée bornée quand on quitte le champ. */
function numberField(id, label, { min, max, step = 1, onInput }) {
  const input = h('input', { type: 'number', id, min, max, step, inputmode: step === 1 ? 'numeric' : 'decimal' });
  input.addEventListener('input', () => {
    const value = Number(input.value);
    if (input.value === '' || !Number.isFinite(value)) return;
    onInput(Math.min(Number(input.max), Math.max(Number(input.min), value)));
  });
  const note = h('span', { class: 'small muted' });
  return { input, note, element: h('div', {}, h('label', { for: id }, label, ' ', note), input) };
}

function pressed(group, test) {
  for (const button of group.children) button.setAttribute('aria-pressed', String(test(button)));
}

/* --------------------------------------------------------------- réglages */

/**
 * Champs du studio. onChange(design) à chaque modification ; contentFor(design) donne ce que
 * porteront les tickets (nom, numéros…), dont dépend ce qui tient sur le papier.
 * Renvoie { layout, colors, get, refresh, applyProduct }.
 */
export function designControls(initial, onChange, contentFor) {
  let design = normalizeDesign(initial);
  const cache = new Map();
  const cached = (key, compute) => {
    if (!cache.has(key)) {
      if (cache.size > 80) cache.clear();
      cache.set(key, compute());
    }
    return cache.get(key);
  };
  const analysis = () => {
    const content = contentFor(design);
    const geometry = [design.paper, design.orientation, design.pw, design.ph, design.margins, design.gapX, design.gapY, design.stub, design.mono, contentKey(content)];
    return {
      limits: cached(JSON.stringify(['limits', design.cols, design.rows, ...geometry]), () => gridLimits(design, content)),
      presets: cached(JSON.stringify(['presets', ...geometry]), () => presetGrids(design, content)),
    };
  };

  function set(patch, { fromProduct = false } = {}) {
    let next = { ...design, ...patch };
    if (!fromProduct && 'paper' in patch && patch.paper !== design.paper) {
      const paper = PAPERS[patch.paper];
      [next.cols, next.rows] = GRID_DEFAULTS[patch.paper];
      Object.assign(next, { margins: undefined, gapX: 0, gapY: 0, cut: !paper.roll });
      if (paper.roll) Object.assign(next, { ph: paper.h, orientation: 'portrait' });
      if (PAPERS[design.paper].roll) next.mono = false; // le noir imposé par le rouleau ne suit pas
    }
    // Souches sur les cases voisines : une case par souche, plus celle du ticket (on ajoute des lignes si on vient de le choisir).
    const group = (next.stubs ?? 1) + 1;
    if (next.stub === 'cell' && next.cols * next.rows < group) {
      if ('stub' in patch || 'stubs' in patch) next.rows = Math.ceil(group / next.cols);
      else next.stub = 'auto';
    }
    // Paysage ↔ portrait : même nombre de tickets, grille tournée.
    if (!fromProduct && 'orientation' in patch && patch.orientation !== design.orientation) [next.cols, next.rows] = [design.rows, design.cols];
    if (!fromProduct && GEOMETRY.some((k) => k in patch)) next.product = null;
    design = normalizeDesign(next);
    // Une grille trop serrée pour ce papier est réduite, sauf pour un papier du catalogue
    // (ses cases sont fixes : l'aperçu signale alors le problème).
    if (!design.product) {
      const content = contentFor(design);
      if (!fitDesign(design, content).ok) design = normalizeDesign(fitGrid(design, content));
    }
    refresh();
    onChange(design);
  }

  /** Applique les réglages d'un papier du catalogue (le noir et blanc choisi à la main est gardé). */
  function applyProduct(product) {
    const keepMono = design.mono && !design.product && !PAPERS[design.paper].roll;
    set({ orientation: 'portrait', margins: undefined, gapX: 0, gapY: 0, cut: true, stub: 'auto', stubs: 1, ...product.design, mono: product.design.mono ?? keepMono, product: product.id }, { fromProduct: true });
  }

  /* papier */
  const catalog = paperCatalog(applyProduct);
  const productLine = h('p', { class: 'product-line', role: 'status' });
  const paper = h('select', { id: 'd-paper', class: 'select' }, PAPER_ORDER.map((id) => h('option', { value: id }, t(`paper_${id}`))));
  paper.addEventListener('change', () => set({ paper: paper.value }));
  const pw = numberField('d-pw', t('d_width'), { min: LIMITS.size[0], max: LIMITS.size[1], step: 0.1, onInput: (v) => set({ pw: v }) });
  const ph = numberField('d-ph', t('d_height'), { min: LIMITS.size[0], max: LIMITS.size[1], step: 0.1, onInput: (v) => set({ ph: v }) });
  const size = h('div', { class: 'inline-fields' }, pw.element, ph.element);
  const orientation = h(
    'div',
    { class: 'segmented', role: 'group', 'aria-label': t('d_orientation') },
    ['portrait', 'landscape'].map((value) => {
      const button = h('button', { type: 'button', 'data-or': value }, t(`or_${value}`));
      button.addEventListener('click', () => set({ orientation: value }));
      return button;
    }),
  );
  const orientationBox = h('div', { class: 'field' }, h('label', {}, t('d_orientation')), orientation);

  /* grille */
  const presets = h('div', { class: 'chips', role: 'group', 'aria-label': t('d_presets') });
  const cols = numberField('d-cols', t('d_cols'), { min: 1, max: LIMITS.cols[1], onInput: (v) => set({ cols: v }) });
  const rows = numberField('d-rows', t('d_rows'), { min: 1, max: LIMITS.rows[1], onInput: (v) => set({ rows: v }) });
  for (const field of [cols, rows, pw, ph]) field.input.addEventListener('change', () => refresh(true));
  // Souches : combien (0 = ticket seul), puis où (à droite, en dessous, cases voisines).
  const stubCount = h(
    'div',
    { class: 'segmented', role: 'group', 'aria-label': t('d_stubs') },
    Array.from({ length: MAX_STUBS + 1 }, (_, n) => {
      const button = h('button', { type: 'button', 'data-stubs': n }, n === 0 ? t('stubs_0') : String(n));
      button.addEventListener('click', () => set({ stubs: n, stub: n === 0 ? 'none' : design.stub === 'none' ? 'auto' : design.stub }));
      return button;
    }),
  );
  const stub = h(
    'div',
    { class: 'segmented wrap', role: 'group', 'aria-label': t('d_stub') },
    STUB_PLACES.map((value) => {
      const button = h('button', { type: 'button', 'data-stub': value }, t(`stub_${value}`));
      button.addEventListener('click', () => set({ stub: value }));
      return button;
    }),
  );
  const stubPlace = h('div', { class: 'field' }, h('label', {}, t('d_stub')), stub);
  const stubHint = h('p', { class: 'small muted' });
  const align = h(
    'div',
    { class: 'segmented', role: 'group', 'aria-label': t('d_align') },
    Object.entries(ALIGN_ICONS).map(([value, glyph]) => {
      const button = h('button', { type: 'button', 'data-align': value, title: t(`align_${value}`), 'aria-label': t(`align_${value}`) }, icon(glyph));
      button.addEventListener('click', () => set({ align: value }));
      return button;
    }),
  );

  /* réglages fins */
  const margins = ['top', 'right', 'bottom', 'left'].map((side, i) =>
    numberField(`d-m${side[0]}`, t(`d_m_${side}`), {
      min: LIMITS.margin[0],
      max: LIMITS.margin[1],
      step: 0.01,
      onInput: (v) => set({ margins: design.margins.map((m, j) => (j === i ? v : m)) }),
    }),
  );
  const gapX = numberField('d-gx', t('d_gap_x'), { min: LIMITS.gap[0], max: LIMITS.gap[1], step: 0.01, onInput: (v) => set({ gapX: v }) });
  const gapY = numberField('d-gy', t('d_gap_y'), { min: LIMITS.gap[0], max: LIMITS.gap[1], step: 0.01, onInput: (v) => set({ gapY: v }) });
  const cut = h('input', { type: 'checkbox', id: 'd-cut' });
  cut.addEventListener('change', () => set({ cut: cut.checked }));
  const advanced = h(
    'details',
    { class: 'advanced' },
    h('summary', {}, t('d_advanced')),
    h('div', { class: 'stack' }, h('div', { class: 'grid-4' }, margins.map((m) => m.element)), h('div', { class: 'inline-fields' }, gapX.element, gapY.element), h('label', { class: 'check', for: 'd-cut' }, cut, ' ', t('d_cut')), h('p', { class: 'small muted' }, t('d_advanced_hint'))),
  );

  /* couleurs et logo */
  const ticketBg = colorField('d-tbg', t('d_ticket_bg'), (v) => set({ ticketBg: v }));
  const accent = colorField('d-acc', t('d_accent'), (v) => set({ accent: v }));
  const stubBg = colorField('d-sbg', t('d_stub_bg'), (v) => set({ stubBg: v }));
  const mono = h('input', { type: 'checkbox', id: 'd-mono' });
  mono.addEventListener('change', () => set({ mono: mono.checked }));
  const monoHint = h('p', { class: 'small muted' }, t('d_mono_roll'));
  const colorFields = h('div', { class: 'stack' }, ticketBg.element, accent.element, stubBg.element, h('p', { class: 'small muted' }, t('d_colors_hint')));
  const showNumber = h('input', { type: 'checkbox', id: 'd-num' });
  showNumber.addEventListener('change', () => set({ showNumber: showNumber.checked }));
  const logo = h('input', { type: 'file', id: 'd-logo', accept: 'image/png,image/jpeg,image/webp,image/svg+xml' });
  logo.addEventListener('change', async () => {
    const read = await readLogo(logo.files[0]).catch(() => null);
    set(read ? { logo: read.url, logoRatio: read.ratio } : { logo: null });
  });
  const removeLogo = h('button', { type: 'button', class: 'linklike small' }, t('d_logo_remove'));
  removeLogo.addEventListener('click', () => {
    logo.value = '';
    set({ logo: null });
  });

  /** Remet les champs en accord avec les réglages (force : y compris le champ en cours de saisie). */
  function refresh(force = false) {
    const { limits, presets: grids } = analysis();
    const roll = Boolean(PAPERS[design.paper].roll);
    const keep = (field) => !force && document.activeElement === field.input;
    const show = (field, value) => {
      if (!keep(field)) field.input.value = value;
    };
    const product = catalog.find(design.product);
    render(
      productLine,
      product && [h('span', {}, '✓ ', t('cat_selected', { name: product.name[LANG] ?? product.name.en })), ' ', h('button', { type: 'button', class: 'linklike small', onclick: () => set({ product: null }, { fromProduct: true }) }, t('cat_detach'))],
    );
    productLine.hidden = !product;
    paper.value = design.paper;
    size.hidden = design.paper !== 'custom' && !roll;
    pw.element.hidden = roll;
    ph.note.textContent = '';
    ph.element.querySelector('label').firstChild.textContent = roll ? t('d_length') : t('d_height');
    show(pw, design.pw);
    show(ph, design.ph);
    orientationBox.hidden = roll;
    pressed(orientation, (b) => b.dataset.or === design.orientation);

    render(
      presets,
      grids.map((g) => {
        const chip = h('button', { type: 'button', class: 'chip', title: `${g.cols} × ${g.rows}`, 'aria-pressed': String(g.cols === design.cols && g.rows === design.rows) }, String(g.count));
        chip.addEventListener('click', () => set({ cols: g.cols, rows: g.rows }));
        return chip;
      }),
    );
    cols.input.max = Math.max(1, limits.cols);
    rows.input.max = Math.max(1, limits.rows);
    cols.note.textContent = t('d_max', { n: limits.cols });
    rows.note.textContent = t('d_max', { n: limits.rows });
    show(cols, design.cols);
    show(rows, design.rows);
    pressed(stubCount, (b) => Number(b.dataset.stubs) === design.stubs);
    pressed(stub, (b) => b.dataset.stub === design.stub);
    pressed(align, (b) => b.dataset.align === design.align);
    stubPlace.hidden = design.stubs === 0;
    stubHint.textContent = [design.stubs === 0 ? t('stub_none_hint') : design.stub === 'cell' ? t('stub_cell_hint') : design.stub === 'auto' ? t('stub_auto_hint') : '', design.stubs > 1 ? t('stubs_many_hint') : ''].filter(Boolean).join(' ');
    stubHint.hidden = !stubHint.textContent;

    margins.forEach((m, i) => show(m, design.margins[i]));
    show(gapX, design.gapX);
    show(gapY, design.gapY);
    cut.checked = design.cut;

    colorFields.hidden = design.mono;
    stubBg.element.hidden = design.stub === 'none';
    ticketBg.input.value = design.ticketBg;
    accent.input.value = design.accent;
    stubBg.input.value = design.stubBg;
    mono.checked = design.mono;
    mono.disabled = roll;
    monoHint.hidden = !roll;
    showNumber.checked = design.showNumber;
    removeLogo.hidden = !design.logo;
  }
  refresh();
  loadProducts().then(() => refresh()); // nom du papier choisi, une fois le catalogue chargé

  return {
    get: () => design,
    refresh,
    applyProduct,
    layout: h(
      'div',
      { class: 'stack' },
      h('div', { class: 'row' }, catalog.button),
      productLine,
      h('div', { class: 'field' }, h('label', { for: 'd-paper' }, t('d_paper')), paper),
      size,
      orientationBox,
      h('label', {}, t('d_presets')),
      presets,
      h('div', { class: 'inline-fields' }, cols.element, rows.element),
      h('label', {}, t('d_stubs')),
      stubCount,
      stubPlace,
      stubHint,
      h('label', {}, t('d_align')),
      align,
      advanced,
      catalog.dialog,
    ),
    colors: h(
      'div',
      { class: 'stack' },
      h('label', { class: 'check', for: 'd-mono' }, mono, ' ', t('d_mono')),
      monoHint,
      colorFields,
      h('label', { class: 'check', for: 'd-num' }, showNumber, ' ', t('create_show_number')),
      h('label', { for: 'd-logo' }, t('create_logo')),
      logo,
      removeLogo,
    ),
  };
}

/* ------------------------------------------------------------ catalogue */

const SVG = 'http://www.w3.org/2000/svg';
const svg = (tag, attrs) => {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
};
const sampleContent = (design) => contentOf(design, { lang: LANG, domain: location.host, name: 'WeCall.You', last: 999 });

/** Vignette d'un papier : la page et ses cases, souches comprises (dessinée, aucune image externe). */
export function paperThumb(design) {
  const d = normalizeDesign(design);
  const fit = fitDesign(d, sampleContent(d));
  const { page, cell } = gridOf(d);
  const [mt, , , ml] = d.margins;
  const box = svg('svg', { viewBox: `0 0 ${page.w} ${page.h}`, class: 'thumb', 'aria-hidden': 'true' });
  box.append(svg('rect', { x: 0, y: 0, width: page.w, height: page.h, class: 'th-page' }));
  for (let r = 0; r < d.rows; r++) {
    for (let c = 0; c < d.cols; c++) {
      const x = ml + c * (cell.w + d.gapX);
      const y = mt + r * (cell.h + d.gapY);
      const size = d.stubs + 1; // ticket + ses souches, sur les cases voisines
      const odd = d.cols % size === 0 ? c % size : d.rows % size === 0 ? r % size : (r * d.cols + c) % size;
      box.append(svg('rect', { x, y, width: cell.w, height: cell.h, class: fit.stub === 'cell' && odd ? 'th-stub' : 'th-cell' }));
      if (fit.stub === 'right') box.append(svg('rect', { x: x + cell.w * fit.split, y, width: cell.w * (1 - fit.split), height: cell.h, class: 'th-stub' }));
      if (fit.stub === 'bottom') box.append(svg('rect', { x, y: y + cell.h * fit.split, width: cell.w, height: cell.h * (1 - fit.split), class: 'th-stub' }));
    }
  }
  return box;
}

let products = null;
async function loadProducts() {
  if (products) return products;
  try {
    const res = await fetch('/papiers.json', { cache: 'no-cache' });
    products = res.ok ? ((await res.json()).products ?? []) : [];
  } catch {
    products = [];
  }
  return products;
}
loadProducts();

/**
 * Catalogue des papiers compatibles (public/papiers.json) : vignette, format, réglages en un
 * appui, et lien vers le produit (lien affilié, signalé comme tel).
 */
function paperCatalog(onUse) {
  const KINDS = ['all', 'sheet', 'perforated', 'labels', 'roll'];
  let kind = 'all';
  const list = h('div', { class: 'catalog-grid' });
  const filters = h('div', { class: 'chips', role: 'group' });
  const disclosure = h('p', { class: 'small muted' }, t('cat_affiliate'));
  const close = h('button', { type: 'button', class: 'btn btn-ghost' }, icon('x'), t('cat_close'));
  const dialog = h('dialog', { class: 'catalog', 'aria-label': t('cat_title') }, h('div', { class: 'row' }, h('h2', { class: 'grow' }, t('cat_title')), close), h('p', { class: 'small muted' }, t('cat_intro')), filters, list, disclosure);
  close.addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', (event) => event.target === dialog && dialog.close());

  const draw = () => {
    render(
      filters,
      KINDS.filter((k) => k === 'all' || products.some((p) => p.kind === k)).map((k) => {
        const chip = h('button', { type: 'button', class: 'chip', 'aria-pressed': String(k === kind) }, t(`cat_${k}`));
        chip.addEventListener('click', () => {
          kind = k;
          draw();
        });
        return chip;
      }),
    );
    render(
      list,
      products
        .filter((p) => kind === 'all' || p.kind === kind)
        .map((product) => {
          const d = normalizeDesign(product.design);
          const fit = fitDesign(d, sampleContent(d));
          const page = pageOf(d);
          const use = h('button', { type: 'button', class: 'btn btn-block' }, t('cat_use'));
          use.addEventListener('click', () => {
            onUse(product);
            dialog.close();
          });
          return h(
            'article',
            { class: 'product' },
            h('div', { class: 'thumb-box' }, paperThumb(d)),
            h('h3', {}, product.name[LANG] ?? product.name.en),
            h('p', { class: 'small muted' }, t('cat_specs', { count: fit.perPage, w: mmText(page.w), h: mmText(page.h) })),
            product.note && h('p', { class: 'small' }, product.note[LANG] ?? product.note.en),
            use,
            /^https:\/\//.test(product.url ?? '') && h('a', { class: 'btn btn-soft btn-block', href: product.url, target: '_blank', rel: 'sponsored noopener noreferrer' }, t('cat_buy', { shop: product.shop ?? '' }), icon('arrow-up-right')),
          );
        }),
    );
    disclosure.hidden = !products.some((p) => /^https:\/\//.test(p.url ?? ''));
  };

  const button = h('button', { type: 'button', class: 'btn btn-soft', id: 'd-catalog' }, icon('package'), t('cat_open'));
  button.addEventListener('click', async () => {
    await loadProducts();
    draw();
    dialog.showModal();
  });
  return { button, dialog, find: (id) => (id && products?.find((p) => p.id === id)) || null };
}

/* --------------------------------------------------------------- aperçu */

/** Faux codes pour l'aperçu (même longueur que les vrais : QR de même densité). */
const codes = [];
const sampleCodes = (n) => {
  while (codes.length < n) codes.push({ c: base32.encode(randomBytes(16)), s: base32.encode(randomBytes(16)) });
  return codes.slice(0, n);
};

/**
 * Aperçu réduit d'une page, mis à jour en direct, avec onglets « Tickets » et « Page clé ».
 * Sur petit écran, il s'ouvre en plein écran par un bouton flottant.
 */
export function livePreview() {
  const frame = h('div', { class: 'pv-frame' });
  const info = h('ul', { class: 'pv-info' });
  const alert = h('p', { class: 'small', role: 'status' });
  let tab = 'tickets';
  let last = null;
  let timer = 0;
  const tabs = h(
    'div',
    { class: 'segmented', role: 'group' },
    ['tickets', 'key', 'poster'].map((name) => {
      const button = h('button', { type: 'button', 'data-tab': name, 'aria-pressed': String(name === tab) }, t(`pv_${name}`));
      button.addEventListener('click', () => setTab(name));
      return button;
    }),
  );
  function setTab(name) {
    tab = name;
    for (const b of tabs.children) b.setAttribute('aria-pressed', String(b.dataset.tab === name));
    if (last) update(last);
  }
  const close = h('button', { type: 'button', class: 'btn btn-ghost pv-close' }, icon('x'), t('pv_close'));
  // Zones de découpe : traits et marges mis en évidence à l'écran (jamais imprimés).
  const cuts = h('button', { type: 'button', class: 'btn btn-ghost pv-cuts', id: 'pv-cuts', 'aria-pressed': 'false' }, icon('scissors'), t('pv_cuts'));
  cuts.addEventListener('click', () => {
    const on = !frame.classList.contains('show-cuts');
    frame.classList.toggle('show-cuts', on);
    cuts.setAttribute('aria-pressed', String(on));
  });
  const panel = h('aside', { class: 'studio-preview card', 'aria-label': t('pv_title') }, h('div', { class: 'row' }, h('h3', { class: 'grow' }, t('pv_title')), tabs, cuts, close), info, alert, frame, h('p', { class: 'small muted' }, t('pv_sample')));
  const fab = h('button', { type: 'button', class: 'btn pv-fab' }, icon('eye'), t('pv_open'));
  fab.addEventListener('click', () => panel.classList.add('open'));
  close.addEventListener('click', () => panel.classList.remove('open'));

  // La page est réduite (ou agrandie, pour un petit ticket) pour tenir dans la place disponible.
  const fit = () => {
    const page = frame.firstElementChild;
    if (!page) {
      frame.style.height = '0';
      return;
    }
    const maxH = Math.max(260, window.innerHeight * 0.72);
    const scale = Math.min(frame.clientWidth / page.offsetWidth, maxH / page.offsetHeight, 2.5);
    page.style.transform = `scale(${scale})`;
    page.style.marginLeft = `${Math.max(0, (frame.clientWidth - page.offsetWidth * scale) / 2)}px`;
    frame.style.height = `${page.offsetHeight * scale}px`;
  };
  new ResizeObserver(fit).observe(frame);

  /**
   * ctx : { design, name, domain, lang, from, count, whiteLabel, key } (key = réglages de la page clé).
   * Renvoie false si les tickets ne tiennent pas sur ce papier.
   */
  function update(ctx) {
    last = ctx;
    // Onglet « Affiche » seulement quand le lot en utilise une ; l'onglet « Tickets » disparaît pour un lot « affiche seule ».
    tabs.querySelector('[data-tab="poster"]').hidden = !ctx.poster;
    if (tab === 'poster' && !ctx.poster) setTab('tickets');
    const design = normalizeDesign(ctx.design);
    const from = ctx.from || 1;
    const lastNumber = from + Math.max(1, ctx.count || 1) - 1;
    const layout = fitDesign(design, contentOf(design, { ...ctx, last: lastNumber }));
    const page = pageOf(design);
    if (!layout.ok) {
      render(info, h('li', {}, t('pv_size', { w: mmText(page.w), h: mmText(page.h) })));
      alert.className = 'small error';
      alert.textContent = t('pv_impossible');
      clearTimeout(timer);
      render(frame);
      fit();
      return false;
    }
    render(
      info,
      h('li', {}, t('pv_per', { n: layout.perPage })),
      h('li', {}, t('pv_pages', { n: pagesFor(Math.max(1, ctx.count || layout.perPage), layout.perPage).toLocaleString(LANG) })),
      h('li', {}, t('pv_size', { w: mmText(page.w), h: mmText(page.h) })),
      h('li', {}, t('pv_qr', { qr: Math.floor(layout.qr) })),
    );
    const small = layout.qr < QR_WARN_MM;
    alert.className = `small ${small ? 'warn' : 'muted'}`;
    alert.textContent = [small && t('pv_qr_warn', { qr: Math.floor(layout.qr) }), PAPERS[design.paper].roll && t('pv_roll')].filter(Boolean).join(' ');
    // Les QR codes de toute une page prennent un instant : on attend la fin de la saisie.
    clearTimeout(timer);
    timer = setTimeout(() => {
      const count = Math.min(layout.perPage, Math.max(1, ctx.count || layout.perPage));
      const tickets = sampleCodes(count).map((codes, i) => ({ ...codes, label: labelOf(from + i) }));
      const sheet = tab === 'poster' && ctx.poster
        ? posterSheet({ lang: ctx.lang, domain: ctx.domain, brand: ctx.key?.brand ?? 'WeCall.You', name: ctx.name || '…', token: ctx.poster.token, logo: design.logo, whiteLabel: ctx.whiteLabel, design })
        : tab === 'key' && ctx.key ? keySheet({ ...ctx.key, design }) : ticketSheets(tickets, { ...design, lang: ctx.lang, domain: ctx.domain, name: ctx.name, whiteLabel: ctx.whiteLabel, last: lastNumber })[0];
      render(frame, sheet);
      requestAnimationFrame(fit);
    }, 60);
    return true;
  }

  return { element: panel, fab, update, setTab };
}
