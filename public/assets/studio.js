// Studio d'impression : papier (et catalogue de papiers compatibles), grille, souche, couleurs,
// logo et aperçu en direct. Utilisé à la création d'un lot et dans l'espace commerçant (onglet
// Imprimer). Tout se passe dans le navigateur. La mise en page est gratuite pour tous ; le logo
// et les couleurs sont réservés à l'offre Pro (grisés sinon, et jamais imprimés sans Pro).
import { h, t, LANG, render, icon, helpTip, fmtTime, inkOn } from './common.js';
import { PAPERS, LIMITS, QR_WARN_MM, MAX_STUBS, POSTER_TEXT, normalizeDesign, withoutPro, fitDesign, fitGrid, gridLimits, pageOf, gridOf, contentKey } from './layout.js';
import { contentOf, ticketSheets, keySheet, labelOf, posterSheet, posterTexts } from './sheets.js';
import { readLogo, pagesFor } from './print.js';
import { base32, randomBytes } from './crypto.js';
import { proLock, THEME_DEFAULTS } from './protools.js';

const SWATCHES = ['#ffffff', '#fff6e5', '#fde9e1', '#e6f0ff', '#e3f4ea', '#f3e8ff', '#1d1b18', '#c8461c'];
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
 * pro : logo et couleurs permis (sinon grisés, et get() rend les couleurs d'origine sans logo).
 * Renvoie { layout, colors, get, refresh, applyProduct, setPro }.
 */
export function designControls(initial, onChange, contentFor, { pro = false } = {}) {
  let design = normalizeDesign(initial);
  let isPro = Boolean(pro);
  // Ce qui sera imprimé : les réglages tels quels en Pro, sans logo ni couleurs sinon.
  const view = () => (isPro ? design : withoutPro(design));
  const cache = new Map();
  const cached = (key, compute) => {
    if (!cache.has(key)) {
      if (cache.size > 80) cache.clear();
      cache.set(key, compute());
    }
    return cache.get(key);
  };
  const analysis = () => {
    const d = view();
    const content = contentFor(d);
    const geometry = [d.paper, d.orientation, d.pw, d.ph, d.margins, d.gapX, d.gapY, d.stub, d.mono, contentKey(content)];
    return { limits: cached(JSON.stringify(['limits', d.cols, d.rows, ...geometry]), () => gridLimits(d, content)) };
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
      const shown = view();
      const content = contentFor(shown);
      if (!fitDesign(shown, content).ok) {
        const { cols, rows } = fitGrid(shown, content);
        design = normalizeDesign({ ...design, cols, rows });
      }
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

  /* grille : colonnes × lignes, chacune bornée pour que le QR code reste lisible */
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
  // « Sans souche » : la remarque se place à côté du choix ; les autres conseils, en dessous.
  const stubNone = h('p', { class: 'small muted' }, t('stub_none_hint'));
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

  // Recto-verso : le mode d'emploi au dos de chaque ticket (une page sur deux) ; pas sur un rouleau.
  const verso = h('input', { type: 'checkbox', id: 'd-verso' });
  verso.addEventListener('change', () => set({ verso: verso.checked }));
  const versoBox = h('div', {}, h('label', { class: 'check', for: 'd-verso' }, verso, ' ', h('span', { class: 'grow' }, t('d_verso')), helpTip(t('d_verso_hint'))));

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
  // Logo et couleurs : offre Pro. Visibles par tous, grisés sans Pro.
  const lock = proLock(false, 'd_pro_lock');
  const proBox = h('fieldset', { class: 'pro-only stack' }, lock, colorFields, h('label', { for: 'd-logo' }, t('create_logo')), logo, removeLogo);

  /** Remet les champs en accord avec les réglages (force : y compris le champ en cours de saisie). */
  function refresh(force = false) {
    const { limits } = analysis();
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
    stubNone.hidden = design.stubs !== 0;
    stubHint.textContent = [design.stubs === 0 ? '' : design.stub === 'cell' ? t('stub_cell_hint') : design.stub === 'auto' ? t('stub_auto_hint') : '', design.stubs > 1 ? t('stubs_many_hint') : ''].filter(Boolean).join(' ');
    stubHint.hidden = !stubHint.textContent;

    verso.checked = design.verso;
    versoBox.hidden = roll;
    margins.forEach((m, i) => show(m, design.margins[i]));
    show(gapX, design.gapX);
    show(gapY, design.gapY);
    cut.checked = design.cut;

    const shown = view();
    proBox.disabled = !isPro;
    lock.hidden = isPro;
    colorFields.hidden = design.mono;
    stubBg.element.hidden = design.stub === 'none';
    ticketBg.input.value = shown.ticketBg;
    accent.input.value = shown.accent;
    stubBg.input.value = shown.stubBg;
    mono.checked = design.mono;
    mono.disabled = roll;
    monoHint.hidden = !roll;
    showNumber.checked = design.showNumber;
    removeLogo.hidden = !shown.logo;
  }
  refresh();
  loadProducts().then(() => refresh()); // nom du papier choisi, une fois le catalogue chargé

  return {
    get: view,
    refresh,
    applyProduct,
    /** Modifie des réglages venus d'ailleurs (textes de l'affiche…), avec le même suivi que les champs. */
    patch: (values) => set(values),
    /** Le compte devient (ou cesse d'être) Pro : champs ouverts ou grisés, aperçu et grille recalculés. */
    setPro(on) {
      if (isPro === Boolean(on)) return;
      isPro = Boolean(on);
      set({});
    },
    layout: h(
      'div',
      { class: 'stack' },
      h('div', { class: 'row' }, catalog.button),
      productLine,
      h('div', { class: 'field' }, h('label', { for: 'd-paper' }, t('d_paper')), paper),
      size,
      orientationBox,
      h('div', { class: 'inline-fields' }, cols.element, rows.element),
      h('label', {}, t('d_stubs')),
      h('div', { class: 'stub-row' }, stubCount, stubNone),
      stubPlace,
      stubHint,
      h('label', {}, t('d_align')),
      align,
      versoBox,
      advanced,
      catalog.dialog,
    ),
    colors: h(
      'div',
      { class: 'stack' },
      h('label', { class: 'check', for: 'd-mono' }, mono, ' ', t('d_mono')),
      monoHint,
      h('label', { class: 'check', for: 'd-num' }, showNumber, ' ', t('create_show_number')),
      proBox,
    ),
  };
}

/* ------------------------------------------------- textes de l'affiche */

/**
 * Textes de l'affiche et du verso des tickets : ceux d'origine, pré-remplis et modifiables. Seuls les
 * textes changés sont gardés (les autres suivent la langue). onChange(posterText). Renvoie { element, reset }.
 */
export function posterTextFields({ initial = {}, lang = LANG, onChange }) {
  const base = posterTexts(lang, {});
  const origin = { title: base.title, sub: base.sub, cta: base.cta };
  base.steps.forEach((step, i) => Object.assign(origin, { [`s${i + 1}t`]: step.title, [`s${i + 1}`]: step.text }));
  let values = { ...initial };
  const inputs = {};
  for (const key of Object.keys(POSTER_TEXT)) {
    const long = /^s\d$/.test(key);
    const input = h(long ? 'textarea' : 'input', { id: `pt-${key}`, class: long ? 'textarea' : null, type: long ? null : 'text', rows: long ? 2 : null, maxlength: POSTER_TEXT[key] });
    input.value = values[key] ?? origin[key];
    input.addEventListener('input', () => {
      const value = input.value.trim();
      if (value === origin[key]) delete values[key];
      else values[key] = value;
      onChange({ ...values });
    });
    inputs[key] = input;
  }
  const field = (key, label) => h('div', { class: 'field' }, h('label', { for: `pt-${key}` }, label), inputs[key]);
  const reset = h('button', { type: 'button', class: 'linklike small' }, t('pt_reset'));
  reset.addEventListener('click', () => {
    values = {};
    for (const [key, input] of Object.entries(inputs)) input.value = origin[key];
    onChange({});
  });
  return {
    element: h(
      'div',
      { class: 'stack' },
      field('title', t('pt_f_title')),
      field('sub', t('pt_f_sub')),
      field('cta', t('pt_f_cta')),
      [1, 2, 3].map((n) => h('fieldset', { class: 'pt-step' }, h('legend', {}, t('pt_f_step', { n })), inputs[`s${n}t`], inputs[`s${n}`])),
      reset,
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

/* ------------------------------------------------- aperçus : écran public, téléphone du client */

/** Écran public (tablette, TV) tel qu'il s'affichera : nom, numéro appelé, derniers appels, aux couleurs du lot. */
function screenView({ name, numbers, promo, theme }) {
  const colors = { ...THEME_DEFAULTS, ...(theme ?? {}) };
  const [now, ...before] = numbers; // le numéro appelé, puis les précédents
  const tv = h(
    'div',
    { class: 'lq-tv pv-tv' },
    h('div', { class: 'lq-head' }, h('span', { class: 'lq-name' }, name || '…'), h('span', { class: 'lq-clock' }, fmtTime(Date.now()))),
    h('div', { class: 'lq-main' }, h('span', { class: 'lq-label' }, t('e_now')), h('div', { class: 'lq-number' }, labelOf(now)), h('div', { class: 'lq-prev' }, before.map((n) => h('b', {}, labelOf(n))))),
    h('div', { class: 'lq-foot pv-tv-foot' }, h('span', { class: 's-live' }, t('e_live')), promo && h('span', { class: 'pv-tv-promo' }, promo)),
  );
  tv.style.background = colors.screenBg;
  tv.style.color = colors.screenText;
  tv.querySelector('.lq-number').style.color = colors.screenNumber;
  return h('figure', { class: 'lq pv-screen' }, tv);
}

/**
 * La page du ticket sur le téléphone du client, après son scan : le choix du moyen d'être prévenu,
 * puis « C'est à vous ! » avec le message de l'appel. Aux couleurs du lot (Pro).
 */
function clientView({ name, label, channels, promo, link, message, theme }) {
  const accent = theme?.accent ?? null;
  const promoCard = (promo || link) && h('div', { class: 'pvp-promo' }, icon('megaphone'), h('span', {}, promo, promo && link && ' ', link && h('u', {}, link.replace(/^https:\/\//, ''))));
  const head = h('div', { class: 'pvp-ticket' }, h('div', { class: 'pvp-merchant' }, name || '…'), h('div', { class: 'pvp-number' }, label));
  const choose = h(
    'div',
    { class: 'pv-phone' },
    h(
      'div',
      { class: 'pvp-screen' },
      head,
      h('p', { class: 'pvp-lead' }, t(channels.length ? 'how' : 'no_channels')),
      channels.map((c) => h('div', { class: 'pvp-choice' }, h('span', { class: 'pvp-icon' }, icon({ push: 'bell-ringing', sms: 'chat-circle-text', wa: 'whatsapp-logo', mail: 'envelope-simple' }[c])), t(`ch_${c}`))),
      h('div', { class: 'pvp-link' }, t('wait_only')),
      promoCard,
    ),
  );
  const ready = h(
    'div',
    { class: 'pv-phone' },
    h('div', { class: 'pvp-screen pvp-ready' }, h('div', { class: 'pvp-title' }, t('ready_title')), h('div', { class: 'pvp-big' }, label), h('p', { class: 'pvp-message' }, message), promoCard?.cloneNode(true)),
  );
  if (accent) {
    choose.style.setProperty('--pvp-accent', accent);
    choose.style.setProperty('--pvp-accent-ink', inkOn(accent));
  }
  return h(
    'div',
    { class: 'pv-phones' },
    h('figure', {}, choose, h('figcaption', {}, t('pv_client_choose'))),
    h('figure', {}, ready, h('figcaption', {}, t('pv_client_ready'))),
  );
}

const PV_ICONS = { tickets: 'ticket', back: 'arrows-clockwise', key: 'key', poster: 'qr-code', screen: 'monitor-play', client: 'device-mobile', all: 'squares-four' };

/**
 * Aperçu en direct, en onglets : tickets, verso, page clé, affiche, écran public, téléphone du client,
 * et « Tout », côte à côte. Sur petit écran, il s'ouvre en plein écran par un bouton flottant.
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
    { class: 'tabbar pv-tabs', role: 'tablist', 'aria-label': t('pv_title') },
    Object.entries(PV_ICONS).map(([name, glyph]) => {
      const button = h('button', { type: 'button', role: 'tab', 'data-tab': name, 'aria-selected': String(name === tab) }, icon(glyph), h('span', {}, t(`pv_${name}`)));
      button.addEventListener('click', () => setTab(name));
      return button;
    }),
  );
  // Onglet choisi (sans redessiner) ; setTab redessine.
  function mark(name) {
    tab = name;
    for (const b of tabs.children) b.setAttribute('aria-selected', String(b.dataset.tab === name));
    cuts.hidden = !['tickets', 'back'].includes(name);
  }
  function setTab(name) {
    mark(name);
    if (last) update(last);
  }
  const close = h('button', { type: 'button', class: 'btn btn-ghost pv-close' }, icon('x'), t('pv_close'));
  // Zones de découpe : traits et marges mis en évidence à l'écran (jamais imprimés).
  const cuts = h('button', { type: 'button', class: 'btn btn-ghost pv-cuts', id: 'pv-cuts', 'aria-pressed': 'false', title: t('pv_cuts'), 'aria-label': t('pv_cuts') }, icon('scissors'));
  cuts.addEventListener('click', () => {
    const on = !frame.classList.contains('show-cuts');
    frame.classList.toggle('show-cuts', on);
    cuts.setAttribute('aria-pressed', String(on));
  });
  // Onglets et découpes au-dessus de la page ; les repères (tickets par page, QR…) en dessous.
  const panel = h('aside', { class: 'studio-preview card', 'aria-label': t('pv_title') }, h('div', { class: 'pv-bar' }, tabs, cuts, close), alert, frame, info, h('p', { class: 'small muted' }, t('pv_sample')));
  const fab = h('button', { type: 'button', class: 'btn pv-fab' }, icon('eye'), t('pv_open'));
  fab.addEventListener('click', () => panel.classList.add('open'));
  close.addEventListener('click', () => panel.classList.remove('open'));

  // Une page imprimée est réduite (ou agrandie) pour tenir dans sa place ; écran et téléphones suivent la largeur.
  const scaleInto = (box, page, maxH = Infinity) => {
    const scale = Math.min(box.clientWidth / page.offsetWidth, maxH / page.offsetHeight, 2.5);
    page.style.transform = `scale(${scale})`;
    page.style.marginLeft = `${Math.max(0, (box.clientWidth - page.offsetWidth * scale) / 2)}px`;
    box.style.height = `${page.offsetHeight * scale}px`;
  };
  const fit = () => {
    const page = frame.firstElementChild;
    frame.style.height = '';
    if (!page) frame.style.height = '0';
    else if (page.classList.contains('sheet')) scaleInto(frame, page, Math.max(260, window.innerHeight * 0.72));
    for (const view of frame.querySelectorAll('.pv-tile-view')) {
      const sheet = view.firstElementChild;
      if (sheet?.classList.contains('sheet')) scaleInto(view, sheet, 320);
    }
  };
  new ResizeObserver(fit).observe(frame);

  /**
   * ctx : { design, name, domain, lang, from, count, whiteLabel, key, poster, client } (key : page clé ;
   * client : { channels, promo, link, message, theme } pour l'écran public et le téléphone du client).
   * Renvoie false si les tickets ne tiennent pas sur ce papier.
   */
  function update(ctx) {
    last = ctx;
    const design = normalizeDesign(ctx.design);
    const shown = { tickets: true, back: design.verso, key: Boolean(ctx.key), poster: Boolean(ctx.poster), screen: Boolean(ctx.client), client: Boolean(ctx.client), all: true };
    for (const b of tabs.children) b.hidden = !shown[b.dataset.tab];
    if (!shown[tab]) mark('tickets');
    const from = ctx.from || 1;
    const lastNumber = ctx.last ?? from + Math.max(1, ctx.count || 1) - 1;
    // Numéros d'exemple : dans l'ordre, ou mélangés (« les deux », affiche seule) comme le seront les vrais.
    const nth = (i) => (ctx.random ? ((i * 389 + 117) % lastNumber) + 1 : from + i);
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
      h('li', {}, t('pv_pages', { n: (pagesFor(Math.max(1, ctx.count || layout.perPage), layout.perPage) * (design.verso ? 2 : 1)).toLocaleString(LANG) })),
      h('li', {}, t('pv_size', { w: mmText(page.w), h: mmText(page.h) })),
      h('li', {}, t('pv_qr', { qr: Math.floor(layout.qr) })),
    );
    const small = layout.qr < QR_WARN_MM;
    alert.className = `small ${small ? 'warn' : 'muted'}`;
    alert.textContent = [small && t('pv_qr_warn', { qr: Math.floor(layout.qr) }), PAPERS[design.paper].roll && t('pv_roll')].filter(Boolean).join(' ');
    // Les QR codes de toute une page prennent un instant : on attend la fin de la saisie.
    clearTimeout(timer);
    timer = setTimeout(() => {
      let sheets = null;
      const ticketPages = () => {
        const count = Math.min(layout.perPage, Math.max(1, ctx.count || layout.perPage));
        const tickets = sampleCodes(count).map((codes, i) => ({ ...codes, label: labelOf(nth(i)) }));
        sheets ??= ticketSheets(tickets, { ...design, lang: ctx.lang, domain: ctx.domain, name: ctx.name, whiteLabel: ctx.whiteLabel, last: lastNumber });
        return sheets;
      };
      const client = ctx.client && { name: ctx.name, label: labelOf(nth(0)), numbers: [nth(3), nth(2), nth(1), nth(0)], ...ctx.client };
      const build = (name) => {
        switch (name) {
          case 'back':
            return ticketPages()[1];
          case 'key':
            return keySheet({ ...ctx.key, design });
          case 'poster':
            return posterSheet({ lang: ctx.lang, domain: ctx.domain, brand: ctx.key?.brand ?? 'WeCall.You', name: ctx.name || '…', token: ctx.poster.token, logo: design.logo, whiteLabel: ctx.whiteLabel, design });
          case 'screen':
            return screenView(client);
          case 'client':
            return clientView(client);
          default:
            return ticketPages()[0];
        }
      };
      if (tab === 'all') {
        const tiles = Object.keys(PV_ICONS).filter((name) => name !== 'all' && shown[name]);
        render(
          frame,
          h(
            'div',
            { class: 'pv-all' },
            tiles.map((name) => h('button', { type: 'button', class: `pv-tile pv-tile-${name}`, onclick: () => setTab(name) }, h('span', { class: 'pv-tile-label' }, icon(PV_ICONS[name]), t(`pv_${name}`)), h('div', { class: 'pv-tile-view' }, build(name)))),
          ),
        );
      } else render(frame, build(tab));
      requestAnimationFrame(fit);
    }, 60);
    return true;
  }

  return { element: panel, fab, update, setTab };
}
