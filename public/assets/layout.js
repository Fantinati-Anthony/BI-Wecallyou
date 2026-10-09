// Mise en page des tickets, calculée sans navigateur : format du papier, grille, place de la
// souche, puis taille de chaque élément (logo ou nom, numéro, QR code, consignes) pour remplir
// chaque case au mieux sans jamais déborder. Le contenu passe en colonne ou en ligne selon la
// forme de la case ; s'il ne tient pas, les éléments accessoires disparaissent un à un.
// Utilisé par l'aperçu et l'impression, vérifié par les tests du serveur (`npm test`).

/** Formats (mm, en portrait). Rouleaux : largeur fixe, longueur d'un ticket réglable. */
export const PAPERS = {
  a4: { w: 210, h: 297 },
  letter: { w: 215.9, h: 279.4 },
  a5: { w: 148, h: 210 },
  a6: { w: 105, h: 148 },
  a3: { w: 297, h: 420 },
  roll80: { w: 80, h: 100, roll: true, margins: [3, 4, 3, 4] },
  roll58: { w: 58, h: 80, roll: true, margins: [3, 5, 3, 5] },
  custom: { w: 100, h: 150 },
};
export const STUBS = ['auto', 'right', 'bottom', 'cell', 'none'];
export const MAX_STUBS = 3; // souches par ticket : commande, cuisine, livraison…
export const ALIGNS = ['auto', 'left', 'center', 'right'];
export const LIMITS = { cols: [1, 12], rows: [1, 24], size: [25, 500], margin: [0, 50], gap: [0, 30] };
export const QR_MIN_MM = 10; // en dessous, la lecture n'est plus fiable
export const QR_MIN_THERMAL_MM = 14; // imprimante thermique (203 dpi) : modules plus gros
export const QR_WARN_MM = 15; // en dessous, imprimer en bonne qualité

/** Anciens réglages (« tickets par page A4 ») → colonnes × lignes. */
const LEGACY = { 4: [1, 4], 6: [2, 3], 8: [2, 4], 10: [2, 5], 12: [2, 6], 16: [2, 8], 21: [3, 7], 24: [3, 8] };

export const DEFAULT_DESIGN = Object.freeze({
  paper: 'a4',
  orientation: 'portrait',
  pw: 100,
  ph: 150,
  margins: Object.freeze([8, 8, 8, 8]), // haut, droite, bas, gauche
  gapX: 0,
  gapY: 0,
  cols: 2,
  rows: 6,
  stub: 'auto',
  stubs: 1,
  align: 'auto',
  cut: true,
  mono: false,
  ticketBg: '#ffffff',
  accent: '#c8461c', // orange WeCall.You : la couleur de tous les tickets sans Pro
  stubBg: '#ffffff',
  showNumber: true,
  logo: null,
  logoRatio: 2,
  product: null,
});

const blank = (v) => v === null || v === undefined || v === '';
const mm = (v, [min, max], fallback) => (blank(v) || !Number.isFinite(Number(v)) ? fallback : Math.round(Math.min(max, Math.max(min, Number(v))) * 100) / 100);
const int = (v, [min, max], fallback) => (blank(v) || !Number.isInteger(Number(v)) ? fallback : Math.min(max, Math.max(min, Number(v))));
const hex = (v, fallback) => (/^#[0-9a-f]{6}$/i.test(v ?? '') ? v.toLowerCase() : fallback);

/** Réglages complets et sûrs, quelle que soit leur origine (stockage local, catalogue, ancien format). */
export function normalizeDesign(o = {}) {
  const paper = Object.hasOwn(PAPERS, o.paper) ? o.paper : DEFAULT_DESIGN.paper;
  const roll = Boolean(PAPERS[paper].roll);
  const [legacyCols, legacyRows] = LEGACY[o.perPage] ?? [DEFAULT_DESIGN.cols, DEFAULT_DESIGN.rows];
  const defaultMargins = PAPERS[paper].margins ?? DEFAULT_DESIGN.margins;
  return {
    paper,
    orientation: !roll && o.orientation === 'landscape' ? 'landscape' : 'portrait',
    pw: mm(o.pw, LIMITS.size, PAPERS.custom.w),
    ph: mm(o.ph, LIMITS.size, roll ? PAPERS[paper].h : PAPERS.custom.h),
    margins: Array.isArray(o.margins) && o.margins.length === 4 ? o.margins.map((m, i) => mm(m, LIMITS.margin, defaultMargins[i])) : [...defaultMargins],
    gapX: mm(o.gapX, LIMITS.gap, 0),
    gapY: mm(o.gapY, LIMITS.gap, 0),
    cols: int(o.cols ?? legacyCols, LIMITS.cols, DEFAULT_DESIGN.cols),
    rows: int(o.rows ?? legacyRows, LIMITS.rows, DEFAULT_DESIGN.rows),
    // « Sans souche » = zéro souche ; sinon 1 à 3 souches, à droite, en dessous ou sur les cases voisines.
    ...(() => {
      const stubs = o.stub === 'none' ? 0 : int(o.stubs, [0, MAX_STUBS], DEFAULT_DESIGN.stubs);
      return { stubs, stub: stubs === 0 ? 'none' : STUBS.includes(o.stub) ? o.stub : DEFAULT_DESIGN.stub };
    })(),
    align: ALIGNS.includes(o.align) ? o.align : DEFAULT_DESIGN.align,
    cut: roll ? o.cut === true : o.cut !== false, // rouleau : l'imprimante coupe, pas besoin de traits
    mono: roll || o.mono === true, // les imprimantes à tickets n'impriment qu'en noir
    ticketBg: hex(o.ticketBg, DEFAULT_DESIGN.ticketBg),
    accent: hex(o.accent, DEFAULT_DESIGN.accent),
    stubBg: hex(o.stubBg, DEFAULT_DESIGN.stubBg),
    showNumber: o.showNumber !== false,
    logo: typeof o.logo === 'string' && o.logo.startsWith('data:image/') ? o.logo : null,
    logoRatio: mm(o.logoRatio, [0.2, 8], DEFAULT_DESIGN.logoRatio),
    product: typeof o.product === 'string' && /^[\w-]{1,40}$/.test(o.product) ? o.product : null,
  };
}

/** Réglages réservés à l'offre Pro : le logo du commerce et les couleurs des tickets (et de l'affiche). */
export const PRO_DESIGN = Object.freeze(['ticketBg', 'accent', 'stubBg', 'logo']);

/** Sans Pro : mêmes réglages, mais couleurs d'origine et pas de logo. */
export function withoutPro(o = {}) {
  const d = normalizeDesign(o);
  return { ...d, ticketBg: DEFAULT_DESIGN.ticketBg, accent: DEFAULT_DESIGN.accent, stubBg: DEFAULT_DESIGN.stubBg, logo: null, logoRatio: DEFAULT_DESIGN.logoRatio };
}

/** Taille de la page (mm), orientation comprise. */
export function pageOf(d) {
  const paper = PAPERS[d.paper];
  let w = d.paper === 'custom' ? d.pw : paper.w;
  let h = d.paper === 'custom' || paper.roll ? d.ph : paper.h;
  if (d.orientation === 'landscape') [w, h] = [h, w];
  return { w, h };
}

/** Géométrie de la grille : page, marges, espacements et taille d'une case. */
export function gridOf(d) {
  const page = pageOf(d);
  const [mt, mr, mb, ml] = d.margins;
  return {
    page,
    cell: {
      w: (page.w - ml - mr - d.gapX * (d.cols - 1)) / d.cols,
      h: (page.h - mt - mb - d.gapY * (d.rows - 1)) / d.rows,
    },
  };
}

/* ------------------------------------------------------- ajustement du contenu */

// Métriques typographiques : les tickets s'impriment en Arial (ou équivalent de mêmes largeurs,
// voir style.css), dont on connaît la chasse de chaque lettre. Un peu de marge en plus : mieux vaut
// un peu d'air qu'un débordement.
const LH = 1.2; // interligne des textes
const CWN = 0.64; // chiffres très gras (prudent : certaines polices de repli sont plus larges)
// Largeur des lettres d'Arial (em), en régulier puis en gras : a → z et A → Z.
const LOWER = [
  [0.556, 0.556, 0.5, 0.556, 0.556, 0.278, 0.556, 0.556, 0.222, 0.222, 0.5, 0.222, 0.833, 0.556, 0.556, 0.556, 0.556, 0.333, 0.5, 0.278, 0.556, 0.5, 0.722, 0.5, 0.5, 0.5],
  [0.556, 0.611, 0.556, 0.611, 0.556, 0.333, 0.611, 0.611, 0.278, 0.278, 0.556, 0.278, 0.889, 0.611, 0.611, 0.611, 0.611, 0.389, 0.556, 0.333, 0.611, 0.556, 0.778, 0.556, 0.556, 0.5],
];
const UPPER = [
  [0.667, 0.667, 0.722, 0.722, 0.667, 0.611, 0.778, 0.722, 0.278, 0.5, 0.667, 0.556, 0.833, 0.722, 0.778, 0.667, 0.778, 0.722, 0.667, 0.611, 0.722, 0.667, 0.944, 0.667, 0.667, 0.611],
  [0.722, 0.722, 0.722, 0.722, 0.667, 0.611, 0.778, 0.722, 0.278, 0.556, 0.722, 0.611, 0.833, 0.722, 0.778, 0.667, 0.778, 0.722, 0.667, 0.611, 0.722, 0.667, 0.944, 0.667, 0.667, 0.611],
];

function charWidth(ch, bold) {
  const code = ch.normalize('NFD').charCodeAt(0); // é → e
  if (code >= 97 && code <= 122) return LOWER[bold][code - 97];
  if (code >= 65 && code <= 90) return UPPER[bold][code - 65];
  if (code >= 48 && code <= 57) return 0.556;
  if (' .,:;!?\'’|-()'.includes(ch)) return 0.34;
  return 1; // autres écritures et symboles : prudence
}

const emCache = new Map();
/** Largeur d'un texte en em (gardée en cache : les mêmes mots reviennent sans cesse). */
function em(text, bold) {
  const key = `${bold}${text}`;
  let w = emCache.get(key);
  if (w === undefined) {
    w = 0;
    for (const ch of text) w += charWidth(ch, bold);
    w *= 1.05;
    if (emCache.size > 2000) emCache.clear();
    emCache.set(key, w);
  }
  return w;
}

/** Largeur (mm) d'un texte sur une ligne. */
const widthOf = (text, font, bold = 0, spacing = 0) => em(text, bold) * font + spacing * text.length * 1.05;
const T_STEPS = Array.from({ length: 16 }, (_, i) => Math.round(1.8 * 1.11 ** i * 100) / 100); // 1,8 mm (5 pt) → 8,6 mm
const N_RATIOS = [1.5, 2.1, 2.9, 4];
const SPLITS = [0.52, 0.6, 0.68, 0.76]; // part du ticket client dans la case
const QR_MAX = 70;

const qrPad = (q) => Math.max(0.8, q * 0.05); // marge blanche autour du QR : lecture sûre sur fond coloré
export const qrBox = (q) => q + 2 * qrPad(q);
const qrFor = (space) => (space >= 17.6 ? space / 1.1 : space - 1.6); // inverse de qrBox
/** Nombre de lignes d'un texte coupé entre les mots (comme le navigateur), ou null si un mot dépasse. */
const wordsCache = new Map();
function wrap(text, font, bold, width) {
  const key = `${bold}${text}`;
  if (!wordsCache.has(key)) wordsCache.set(key, text.split(/\s+/).filter(Boolean).map((word) => em(word, bold)));
  const space = em(' ', bold) * font;
  let lines = 1;
  let used = 0;
  for (const wordEm of wordsCache.get(key)) {
    const w = wordEm * font;
    if (w > width) return null;
    if (used && used + space + w > width) {
      lines++;
      used = w;
    } else used += (used ? space : 0) + w;
  }
  return lines;
}

/** Ce qui compte pour la mise en page (sert aussi de clé au cache des calculs). */
export function contentKey(c) {
  return [c.head, c.head === 'logo' ? c.logoRatio : c.name, c.showNumber ? c.label.length : 0, c.scan, c.scanSub, c.domain.length, c.tag, c.hint].join('|');
}

// Éléments accessoires, retirés dans cet ordre quand la place manque (avec leur « coût »).
// Jamais retirés : le QR code, la consigne « Scannez » du client et le numéro de la souche.
const DROPS = {
  client: [
    ['domain', 0.4],
    ['scanSub', 0.6],
    ['head', 1],
  ],
  stub: [
    ['hint', 0.5],
    ['tag', 0.6],
  ],
};

function itemsOf(role, c) {
  if (role === 'client') return [c.head && 'head', c.showNumber && 'number', 'qr', 'scan', c.scanSub && 'scanSub', c.domain && 'domain'].filter(Boolean);
  return ['tag', 'number', 'qr', c.hint && 'hint'];
}

/** En-tête du ticket : hauteur du logo, ou taille du nom (réduite s'il est long, puis coupé par « … »). */
export function headSize(c, t, width) {
  if (c.head === 'logo') return Math.min(t * 3.4, width / c.logoRatio);
  return Math.min(t * 1.15, Math.max(t * 0.85, width / (widthOf(c.name, 1, 1) || 1)));
}

/** Hauteur d'un paragraphe, ou null s'il ne tient pas en largeur. */
const paragraph = (text, font, bold, width) => {
  const n = wrap(text, font, bold, width);
  return n === null ? null : n * font * LH;
};

/** Hauteur d'un élément de texte pour une largeur donnée, ou null s'il ne tient pas. */
function block(kind, c, t, n, width) {
  switch (kind) {
    case 'head':
      return c.head === 'logo' ? headSize(c, t, width) : headSize(c, t, width) * LH;
    case 'number':
      return c.label.length * CWN * n <= width ? n : null;
    case 'scan':
      return paragraph(c.scan, t, 1, width);
    case 'scanSub':
      return paragraph(c.scanSub, t * 0.88, 0, width);
    case 'domain':
      return t * 0.8 * LH; // une ligne (logo WeCall.You ou adresse), coupée si besoin : le QR code porte déjà l'adresse
    case 'tag':
      return widthOf(c.tag, t * 0.85, 1, 0.3) <= width ? t * 0.85 * LH : null;
    case 'hint':
      return paragraph(c.hint, t * 0.88, 0, width);
    default:
      return 0;
  }
}

/** Hauteur d'une pile d'éléments (QR exclu), espaces compris, ou Infinity si l'un ne tient pas. */
function stackHeight(items, c, t, n, width) {
  let total = 0.3 * t * (items.length - 1);
  for (const kind of items) {
    if (kind === 'qr') continue;
    const h = block(kind, c, t, n, width);
    if (h === null) return Infinity;
    total += h;
  }
  return total;
}

const grow = (x, k) => Math.log(Math.min(x, k)) + 0.2 * Math.log(Math.max(x, k) / k); // utile jusqu'à k, peu au-delà

function utility(role, items, q, t, n) {
  let u = 3 * grow(q, 30) + 1.6 * grow(t, 3.2);
  if (items.includes('number')) u += 1.3 * grow(n, role === 'client' ? 12 : 9);
  return u;
}

/** QR le plus grand possible, en colonne : tout empilé et centré. */
function vertical(items, c, t, n, W, H) {
  const used = stackHeight(items, c, t, n, W);
  return Math.min(qrFor(W), qrFor(H - used), QR_MAX);
}

/** QR le plus grand possible, en ligne : QR à gauche, textes dans la colonne de droite. */
function horizontal(items, c, t, n, W, H, qMin) {
  const text = items.filter((k) => k !== 'qr');
  if (!text.length) return -1;
  const gap = Math.max(1.2, 0.7 * t);
  const fits = (q) => {
    const col = W - qrBox(q) - gap;
    return col > 0 && stackHeight(text, c, t, n, col) <= H;
  };
  let hi = Math.min(qrFor(H), QR_MAX);
  let lo = qMin;
  if (hi < lo || !fits(lo)) return -1;
  if (fits(hi)) return hi;
  for (let i = 0; i < 9; i++) {
    const mid = (lo + hi) / 2;
    if (fits(mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}

const memo = new Map();

/**
 * Meilleure disposition d'une partie (ticket client ou souche) dans un rectangle w × h :
 * { mode, items, q, t, n, pad, gap, gapH, score } ou null si rien de lisible ne tient.
 */
export function fitPart(role, w, h, c, { qMin = QR_MIN_MM, safe = 0, tMax = Infinity, nMax = Infinity } = {}) {
  const key = `${role}|${w.toFixed(2)}|${h.toFixed(2)}|${qMin}|${safe}|${tMax}|${nMax}|${contentKey(c)}`;
  if (memo.has(key)) return memo.get(key);
  const pad = Math.min(3.5, Math.max(1, Math.min(w, h) * 0.045)) + safe;
  const W = w - 2 * pad;
  const H = h - 2 * pad;
  let best = null;
  if (W > 0 && H > 0) {
    // Variantes de contenu : complet, puis sans les éléments accessoires, un par un.
    const variants = [{ items: itemsOf(role, c), penalty: 0 }];
    for (const [kind, cost] of DROPS[role]) {
      const prev = variants.at(-1);
      if (prev.items.includes(kind)) variants.push({ items: prev.items.filter((k) => k !== kind), penalty: prev.penalty + cost });
    }
    for (const { items, penalty } of variants) {
      const hasNumber = items.includes('number');
      for (const t of T_STEPS) {
        if (t > tMax) break;
        for (const ratio of hasNumber ? N_RATIOS : [0]) {
          const n = Math.min(t * ratio, Math.max(nMax, t * N_RATIOS[0]));
          for (const mode of ['v', 'h']) {
            const q = mode === 'v' ? vertical(items, c, t, n, W, H) : horizontal(items, c, t, n, W, H, qMin);
            if (q < qMin) continue;
            const score = utility(role, items, q, t, n) - penalty;
            if (!best || score > best.score) {
              const gapH = Math.max(1.2, 0.7 * t);
              const textW = mode === 'v' ? W : W - qrBox(q) - gapH; // largeur offerte aux textes
              best = { mode, items, q, t, n, pad, gap: 0.3 * t, gapH, textW, score };
            }
          }
        }
      }
    }
  }
  if (memo.size > 5000) memo.clear();
  memo.set(key, best);
  return best;
}

/**
 * Mise en page complète d'une page de tickets : géométrie, souche retenue et parties ajustées.
 * ok = false si la grille ne laisse pas de place à un QR code lisible.
 */
export function fitDesign(d, c) {
  const { page, cell } = gridOf(d);
  const qMin = d.mono ? QR_MIN_THERMAL_MM : QR_MIN_MM;
  // Feuille standard aux marges sous 4 mm (prédécoupé bord à bord) : le contenu s'écarte des bords
  // que les imprimantes de bureau n'impriment pas. Rouleaux et formats libres (imprimantes à
  // tickets ou d'étiquettes) impriment jusqu'au bord.
  const safe = PAPERS[d.paper].roll || d.paper === 'custom' ? 0 : Math.max(0, 4 - Math.min(...d.margins));
  const stubs = d.stub === 'none' ? 0 : (d.stubs ?? 1);
  const perPage = d.stub === 'cell' ? Math.floor((d.cols * d.rows) / (stubs + 1)) : d.cols * d.rows;
  const base = { ok: false, page, cell, perPage, qMin, stub: d.stub, stubs, split: 1, client: null, stubPart: null, qr: 0 };
  if (cell.w < 8 || cell.h < 8 || perPage < 1) return base;
  const opts = { qMin, safe };
  // La souche reprend au plus les tailles du ticket (textes, numéro) : une même famille visuelle.
  const stubFor = (w, h, client) => client && fitPart('stub', w, h, c, { ...opts, tMax: client.t, nMax: client.items.includes('number') ? client.n : Infinity });
  let best = null;
  const consider = (stub, split, client, stubPart) => {
    if (!client || (stub !== 'none' && !stubPart)) return;
    const score = client.score + (stubPart ? 0.75 * stubPart.score : 0);
    if (!best || score > best.score) best = { stub, split, client, stubPart, score };
  };
  for (const stub of d.stub === 'auto' ? ['right', 'bottom'] : [d.stub]) {
    if (stub === 'none') consider(stub, 1, fitPart('client', cell.w, cell.h, c, opts), null);
    else if (stub === 'cell') {
      const client = fitPart('client', cell.w, cell.h, c, opts);
      consider(stub, 1, client, stubFor(cell.w, cell.h, client));
    } else {
      // Plusieurs souches : elles se partagent la bande de souche, côte à côte (à droite) ou empilées (en dessous).
      for (const s of SPLITS.map((split) => Math.max(0.34, split - 0.1 * (stubs - 1)))) {
        const client = stub === 'right' ? fitPart('client', cell.w * s, cell.h, c, opts) : fitPart('client', cell.w, cell.h * s, c, opts);
        const stubPart = stub === 'right' ? stubFor((cell.w * (1 - s)) / stubs, cell.h, client) : stubFor(cell.w, (cell.h * (1 - s)) / stubs, client);
        consider(stub, s, client, stubPart);
      }
    }
  }
  if (!best) return base;
  return { ...base, ...best, ok: true, qr: Math.min(best.client.q, best.stubPart?.q ?? Infinity) };
}

/** Nombre maximal de colonnes (lignes fixées) et de lignes (colonnes fixées) encore lisibles. */
export function gridLimits(d, c) {
  // Recherche par dichotomie : ce qui tient avec n colonnes tient avec moins.
  const max = (key, [lo, hi]) => {
    const ok = (v) => fitDesign({ ...d, [key]: v }, c).ok;
    let a = lo;
    if (!ok(a) && !ok(++a)) return 0; // souche sur la case voisine : deux cases au moins
    let b = hi;
    if (ok(b)) return b;
    while (b - a > 1) {
      const m = (a + b) >> 1;
      if (ok(m)) a = m;
      else b = m;
    }
    return a;
  };
  return { cols: max('cols', LIMITS.cols), rows: max('rows', LIMITS.rows) };
}

/** Réduit la grille jusqu'à ce qu'elle tienne (après un changement de papier, par exemple). */
export function fitGrid(d, c) {
  let next = { ...d };
  while (!fitDesign(next, c).ok && (next.cols > 1 || next.rows > 1)) {
    const { cell } = gridOf(next);
    if (next.cols > 1 && (cell.w < cell.h || next.rows === 1)) next.cols -= 1;
    else next.rows -= 1;
  }
  return next;
}

const PRESET_GRIDS = [[1, 1], [1, 2], [1, 3], [2, 2], [1, 4], [2, 3], [2, 4], [2, 5], [3, 4], [2, 6], [3, 5], [2, 7], [3, 6], [2, 8], [4, 5], [3, 7], [4, 6], [3, 8], [4, 7], [4, 8], [5, 8], [4, 10], [5, 10], [6, 10]];

/** Grilles courantes qui tiennent sur ce papier : une par nombre de tickets, la plus lisible. */
export function presetGrids(d, c) {
  const { page } = gridOf(d);
  const byCount = new Map();
  for (const [a, b] of PRESET_GRIDS) {
    const [cols, rows] = page.w > page.h ? [b, a] : [a, b];
    const fit = fitDesign({ ...d, cols, rows }, c);
    if (!fit.ok) continue;
    const prev = byCount.get(fit.perPage);
    if (!prev || fit.qr > prev.qr) byCount.set(fit.perPage, { cols, rows, count: fit.perPage, qr: fit.qr });
  }
  return [...byCount.values()].sort((x, y) => x.count - y.count);
}
