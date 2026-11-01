// Passport & exam photo maker (tool ids: passportphoto, examphoto).
// A port of the bot engine (engine/passport_photo.py) that runs fully on the phone:
//   analyze()            → analyzeFaces()   MediaPipe face detector instead of a Haar cascade
//   process_photo()      → makePhoto()      MediaPipe selfie segmenter for the white background
//   sheet_copy_options() → sheetCopyOptions()
//   build_print_sheet()  → sheetLayout() + buildSheet()  (JPEG + true-size PDF via pdf-lib)
// Everything above the "browser" line is pure and unit-tested with node.

import {
  h, card, button, busy, field, row, segmented, filePicker, notice, progress, resultCard,
  fmtBytes, stem, loadImage, toCanvas, canvasToBlob, jpegUnder, tick, toast,
} from '../ui.js';
import { libs, faceDetector, personSegmenter, vendorUrl } from '../lib.js';
import * as store from '../store.js';
import {
  PRESETS, PRESET_GROUPS, DEFAULT_PRESET, EXAM_PRESET, CUSTOM_DEFAULTS, customPreset, specLine, physical, PRINT_DPI,
} from './passport-data.js';

// ════════════════════════════ pure logic ════════════════════════════

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** analyze() thresholds, verbatim from engine/passport_photo.py. */
export const CHECK = {
  minSide: 500,      // min(h, w) < 500 → low resolution
  secondFace: 0.30,  // 2nd face area > 30% of the largest → "more than one face"
  faceMin: 0.22,     // face height / image height
  faceMax: 0.60,
  centreTol: 0.14,   // |face centre x − w/2| ≤ 14% of w
  darkMin: 75,       // mean face grey level
  brightMax: 205,
  topMin: 0.04,      // face box top must be ≥ 4% of h below the top edge
};

/** The bot's retake tips (same wording, lightly punctuated). */
export const ISSUES = {
  res: '📏 Resolution is low: use the rear camera or move closer.',
  noface: '🙂 I can’t find a clear face: face the camera straight, in good light.',
  multi: '👥 More than one face detected: only you should be in frame.',
  far: '↔️ Too far: bring the camera closer (head and shoulders fill the frame).',
  close: '↔️ Too close: move the phone back so your full head fits.',
  centre: '🎯 Off-centre: keep your face in the middle of the frame.',
  dark: '💡 Too dark: turn towards a window or light source.',
  bright: '💡 Overexposed: step back from direct light.',
  top: '⬆️ Head touches the top edge: leave space above your hair.',
};

export const CHECK_LABELS = {
  face: 'One clear face', size: 'Right distance', centre: 'Centred',
  light: 'Good light', top: 'Space above head', res: 'Sharp enough',
};

/** Short prompts for the live camera (preview is mirrored, so no left/right words). */
export const LIVE_HINTS = {
  noface: 'Show your face inside the oval', multi: 'Only you in the frame, please',
  far: 'Move a little closer', close: 'Move back a little', centre: 'Centre your face in the oval',
  top: 'Leave a little space above your head', dark: 'Find more light: face a window',
  bright: 'Too bright: step out of direct light', res: 'Hold still', ok: 'Looks good. Tap the button',
};

/**
 * Port of analyze(). faces: [{x, y, w, h}] in the analysed image's pixels (any order).
 * opts: {w, h} analysed size, {origW, origH} original size (for the resolution check),
 * brightness(face) → mean grey 0..255 (or null to skip), live: skip the resolution check.
 * Returns {ok, fatal, issues:[{id,msg}], checks:{id:bool}, face, faces, ratio, brightness}.
 */
export function analyzeFaces(faces, { w, h, origW = w, origH = h, brightness = null, live = false } = {}) {
  const issues = [];
  const checks = {};
  const add = id => issues.push({ id, msg: ISSUES[id] });

  if (!live) {
    checks.res = Math.min(origW, origH) >= CHECK.minSide;
    if (!checks.res) add('res');
  }
  const list = (faces || []).filter(f => f && f.w > 0 && f.h > 0);
  if (!list.length) {
    add('noface'); checks.face = false;
    return { ok: false, fatal: true, issues, checks, face: null, faces: [] };
  }
  const sorted = [...list].sort((a, b) => b.w * b.h - a.w * a.h);
  checks.face = true;
  if (sorted.length > 1 && sorted[1].w * sorted[1].h > CHECK.secondFace * sorted[0].w * sorted[0].h) {
    add('multi'); checks.face = false;
  }
  const f = sorted[0];

  const ratio = f.h / h;
  checks.size = ratio >= CHECK.faceMin && ratio <= CHECK.faceMax;
  if (ratio < CHECK.faceMin) add('far');
  else if (ratio > CHECK.faceMax) add('close');

  const cx = f.x + f.w / 2;
  checks.centre = Math.abs(cx - w / 2) <= CHECK.centreTol * w;
  if (!checks.centre) add('centre');

  let b = null;
  if (brightness) {
    b = brightness(f);
    if (b != null && Number.isFinite(b)) {
      checks.light = b >= CHECK.darkMin && b <= CHECK.brightMax;
      if (b < CHECK.darkMin) add('dark');
      else if (b > CHECK.brightMax) add('bright');
    }
  }

  checks.top = f.y >= CHECK.topMin * h;
  if (!checks.top) add('top');

  return { ok: issues.length === 0, fatal: false, issues, checks, face: f, faces: sorted, ratio, brightness: b };
}

/** One live-camera prompt for an analysis: {ok, text}. */
export function liveHint(a) {
  if (!a.face) return { ok: false, text: LIVE_HINTS.noface };
  const first = a.issues[0];
  return first ? { ok: false, text: LIVE_HINTS[first.id] || LIVE_HINTS.centre } : { ok: true, text: LIVE_HINTS.ok };
}

/** Mean grey level of an RGBA buffer inside box (clamped); null if empty. Per-pixel grey uses
 *  OpenCV's fixed-point BGR2GRAY (0.299 R + 0.587 G + 0.114 B, 14-bit) so thresholds match the bot. */
export function regionMeanGray(data, W, H, box) {
  const x0 = clamp(Math.floor(box.x), 0, W), y0 = clamp(Math.floor(box.y), 0, H);
  const x1 = clamp(Math.ceil(box.x + box.w), 0, W), y1 = clamp(Math.ceil(box.y + box.h), 0, H);
  if (x1 <= x0 || y1 <= y0) return null;
  let s = 0;
  for (let y = y0; y < y1; y++) {
    let i = (y * W + x0) * 4;
    for (let x = x0; x < x1; x++, i += 4) s += (data[i] * 4899 + data[i + 1] * 9617 + data[i + 2] * 1868 + 8192) >> 14;
  }
  return s / ((x1 - x0) * (y1 - y0));
}

/** process_photo() crop geometry, verbatim. face {x,y,w,h}; returns the crop in the same pixels. */
export const GEOM = { headTop: 0.55, headBottom: 1.15, above: 0.45 };
export function cropRect(face, preset) {
  const { x, y, w: fw, h: fh } = face;
  const headTop = y - GEOM.headTop * fh;
  const headBottom = y + GEOM.headBottom * fh;
  const headH = headBottom - headTop;
  const cropH = headH / preset.head_frac;
  const cropW = cropH * (preset.w / preset.h);
  const top = headTop - GEOM.above * (cropH - headH);
  const left = (x + fw / 2) - cropW / 2;
  return { left, top, w: cropW, h: cropH, headTop, headH };
}

/**
 * Map a crop rectangle (may extend past the image) onto an outW×outH canvas: returns the
 * drawImage source/destination for the part that overlaps the W×H image, or null.
 * Everything outside stays the canvas fill (white), like PIL's paste onto a white canvas.
 */
export function clipDraw(rect, W, H, outW, outH) {
  const kx = outW / rect.w, ky = outH / rect.h;
  const ix0 = Math.max(0, rect.left), iy0 = Math.max(0, rect.top);
  const ix1 = Math.min(W, rect.left + rect.w), iy1 = Math.min(H, rect.top + rect.h);
  if (ix1 <= ix0 || iy1 <= iy0) return null;
  return {
    sx: ix0, sy: iy0, sw: ix1 - ix0, sh: iy1 - iy0,
    dx: (ix0 - rect.left) * kx, dy: (iy0 - rect.top) * ky, dw: (ix1 - ix0) * kx, dh: (iy1 - iy0) * ky,
  };
}

/** The centred region of a vw×vh video that object-fit:cover shows in a cw×ch box. */
export function coverCrop(vw, vh, cw, ch) {
  if (!(cw > 0 && ch > 0)) return { sx: 0, sy: 0, sw: vw, sh: vh };
  const s = Math.max(cw / vw, ch / vh);
  const sw = Math.min(vw, Math.round(cw / s)), sh = Math.min(vh, Math.round(ch / s));
  return { sx: Math.floor((vw - sw) / 2), sy: Math.floor((vh - sh) / 2), sw, sh };
}

/** Resize plan that never shrinks more than 2× per step: [[w,h], …, [tw,th]]. */
export function stepSizes(fw, fh, tw, th) {
  const out = [];
  let w = fw, h = fh;
  while (w > 2 * tw && h > 2 * th) { w /= 2; h /= 2; out.push([Math.round(w), Math.round(h)]); }
  out.push([tw, th]);
  return out;
}

// ── background mask helpers ──────────────────────────────────────────

/** Mean of a mask over the central 60% of a box given in normalised (0..1) coords. */
export function maskMean(data, mw, mh, nbox) {
  const bx = nbox.x + nbox.w * 0.2, by = nbox.y + nbox.h * 0.2, bw = nbox.w * 0.6, bh = nbox.h * 0.6;
  const x0 = clamp(Math.floor(bx * mw), 0, mw - 1), x1 = clamp(Math.ceil((bx + bw) * mw), x0 + 1, mw);
  const y0 = clamp(Math.floor(by * mh), 0, mh - 1), y1 = clamp(Math.ceil((by + bh) * mh), y0 + 1, mh);
  const sx = Math.max(1, Math.floor((x1 - x0) / 40)), sy = Math.max(1, Math.floor((y1 - y0) / 40));
  let s = 0, n = 0;
  for (let y = y0; y < y1; y += sy) for (let x = x0; x < x1; x += sx) { s += data[y * mw + x]; n++; }
  return n ? s / n : 0;
}

/**
 * Which confidence mask is "person"? MediaPipe models differ (1 mask = person, or
 * [background, person]); the face we already found must be person, so test it.
 * list: [{data, w, h}]; nface: face box normalised to 0..1. → {index, invert, score}
 */
export function pickPersonMask(list, nface) {
  let best = null;
  list.forEach((m, index) => {
    const v = maskMean(m.data, m.w, m.h, nface);
    if (!best || v > best.score) best = { index, invert: false, score: v };
    if (list.length === 1 && 1 - v > best.score) best = { index, invert: true, score: 1 - v };
  });
  return best;
}

/** Bilinear resample of a float mask (copy if same size). */
export function resampleMask(src, sw, sh, dw, dh) {
  if (sw === dw && sh === dh) return Float32Array.from(src);
  const out = new Float32Array(dw * dh);
  const kx = sw / dw, ky = sh / dh;
  for (let y = 0; y < dh; y++) {
    const fy = clamp((y + 0.5) * ky - 0.5, 0, sh - 1), y0 = Math.floor(fy), y1 = Math.min(sh - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < dw; x++) {
      const fx = clamp((x + 0.5) * kx - 0.5, 0, sw - 1), x0 = Math.floor(fx), x1 = Math.min(sw - 1, x0 + 1), tx = fx - x0;
      const a = src[y0 * sw + x0], b = src[y0 * sw + x1], c = src[y1 * sw + x0], d = src[y1 * sw + x1];
      out[y * dw + x] = (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
    }
  }
  return out;
}

/** Separable box blur with clamped edges (O(n), any radius). */
export function boxBlur(a, w, h, r) {
  if (!(r >= 1)) return a;
  const n = 2 * r + 1, tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const o = y * w;
    let s = 0;
    for (let k = -r; k <= r; k++) s += a[o + clamp(k, 0, w - 1)];
    for (let x = 0; x < w; x++) {
      tmp[o + x] = s / n;
      s += a[o + Math.min(w - 1, x + r + 1)] - a[o + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < w; x++) {
    let s = 0;
    for (let k = -r; k <= r; k++) s += tmp[clamp(k, 0, h - 1) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = s / n;
      s += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
    }
  }
  return out;
}

/** Confidence → clean alpha: smoothstep(lo..hi) tightens the soft model edge, then a
 *  two-pass box blur (≈ tent filter) feathers it so hair and shoulders blend into white. */
export function refineAlpha(mask, w, h, { invert = false, lo = 0.3, hi = 0.75, radius = 2 } = {}) {
  const a = new Float32Array(w * h);
  const span = hi - lo;
  for (let i = 0; i < a.length; i++) {
    const v = invert ? 1 - mask[i] : mask[i];
    const t = clamp((v - lo) / span, 0, 1);
    a[i] = t * t * (3 - 2 * t);
  }
  return radius >= 1 ? boxBlur(boxBlur(a, w, h, radius), w, h, radius) : a;
}

/** Composite RGBA pixels over pure white using alpha (in place). */
export function compositeWhite(px, alpha) {
  for (let j = 0, i = 0; j < alpha.length; j++, i += 4) {
    const a = alpha[j];
    if (a >= 0.999) continue;
    const k = (1 - a) * 255;
    px[i] = px[i] * a + k; px[i + 1] = px[i + 1] * a + k; px[i + 2] = px[i + 2] * a + k; px[i + 3] = 255;
  }
  return px;
}

// ── JPEG density patch ───────────────────────────────────────────────

const JFIF_ID = [0x4A, 0x46, 0x49, 0x46, 0x00];       // "JFIF\0"
const EXIF_ID = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00]; // "Exif\0\0"
const hasId = (b, at, id) => id.every((v, k) => b[at + k] === v);

/**
 * Set the JPEG's print density to dpi×dpi (JFIF APP0, units = dots per inch).
 * Patches an existing JFIF segment, or inserts one right after SOI. Also drops any
 * Exif APP1 (a canvas encoder's Exif can carry a conflicting 72 dpi; no user data
 * survives a canvas anyway). Non-JPEG input is returned unchanged.
 */
export function setJpegDpi(bytes, dpi = 300) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b.length < 4 || b[0] !== 0xFF || b[1] !== 0xD8) return b;
  const segs = [];
  let i = 2;
  while (i + 4 <= b.length && b[i] === 0xFF) {
    const m = b[i + 1];
    if (m === 0xFF) { i++; continue; }                        // fill byte
    if (m === 0xDA || m === 0xD9) break;                      // SOS / EOI: image data follows
    if (m === 0x01 || (m >= 0xD0 && m <= 0xD7)) { i += 2; continue; }
    const len = (b[i + 2] << 8) | b[i + 3];
    if (len < 2 || i + 2 + len > b.length) break;             // malformed: stop walking
    segs.push({ m, start: i, end: i + 2 + len });
    i += 2 + len;
  }
  const rest = b.subarray(i);
  const jfif = segs.find(s => s.m === 0xE0 && s.end - s.start >= 18 && hasId(b, s.start + 4, JFIF_ID));
  const keep = segs.filter(s => s !== jfif && !(s.m === 0xE1 && hasId(b, s.start + 4, EXIF_ID)));
  const hi = (dpi >> 8) & 0xFF, lo = dpi & 0xFF;
  let app0;
  if (jfif) {
    app0 = b.slice(jfif.start, jfif.end);
    app0[11] = 1; app0[12] = hi; app0[13] = lo; app0[14] = hi; app0[15] = lo;   // units, Xdensity, Ydensity
  } else {
    app0 = Uint8Array.of(0xFF, 0xE0, 0x00, 0x10, ...JFIF_ID, 0x01, 0x01, 0x01, hi, lo, hi, lo, 0x00, 0x00);
  }
  const total = 2 + app0.length + keep.reduce((n, s) => n + s.end - s.start, 0) + rest.length;
  const out = new Uint8Array(total);
  out[0] = 0xFF; out[1] = 0xD8;
  let o = 2;
  out.set(app0, o); o += app0.length;
  for (const s of keep) { out.set(b.subarray(s.start, s.end), o); o += s.end - s.start; }
  out.set(rest, o);
  return out;
}

/** Read the JFIF density back: {units, x, y} or null. */
export function readJpegDpi(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b[0] !== 0xFF || b[1] !== 0xD8 || b[2] !== 0xFF || b[3] !== 0xE0 || !hasId(b, 6, JFIF_ID)) return null;
  return { units: b[13], x: (b[14] << 8) | b[15], y: (b[16] << 8) | b[17] };
}

// ── print sheet (build_print_sheet) ──────────────────────────────────

/** Papers @300 dpi, smallest first; pt = exact PDF page size. */
export const PAPERS = [
  { id: '4x6', label: '4×6 in', w: 1200, h: 1800, pt: [288, 432] },
  { id: 'A4', label: 'A4', w: 2480, h: 3508, pt: [595.28, 841.89] },
];
export const MARGIN = 40, GAP = 24;

export function capacity(pw, ph, sw, sh) {
  const cols = Math.max(0, Math.floor((sw - 2 * MARGIN + GAP) / (pw + GAP)));
  const rows = Math.max(0, Math.floor((sh - 2 * MARGIN + GAP) / (ph + GAP)));
  return cols * rows;
}

/** Copy-count buttons for this photo size (limited by what fits on A4). */
export function sheetCopyOptions(pw, ph) {
  const last = PAPERS[PAPERS.length - 1];
  const maxCap = capacity(pw, ph, last.w, last.h);
  const opts = [4, 6, 8, 10, 12].filter(n => n <= maxCap);
  return opts.length ? opts : [Math.max(1, maxCap)];
}

/** Smallest paper that fits `copies`, the centred grid, and each photo's top-left. */
export function sheetLayout(pw, ph, copies) {
  let paper = PAPERS[PAPERS.length - 1];
  for (const p of PAPERS) if (copies <= capacity(pw, ph, p.w, p.h)) { paper = p; break; }
  const n = Math.min(copies, capacity(pw, ph, paper.w, paper.h));
  const cols = Math.floor((paper.w - 2 * MARGIN + GAP) / (pw + GAP));
  if (n < 1 || cols < 1) return { paper, copies: 0, cols: 0, rows: 0, positions: [] };
  const rows = Math.ceil(n / cols);
  const c = Math.min(n, cols);
  const gridW = c * pw + (c - 1) * GAP, gridH = rows * ph + (rows - 1) * GAP;
  const ox = Math.floor((paper.w - gridW) / 2), oy = Math.floor((paper.h - gridH) / 2);
  const positions = [];
  for (let i = 0; i < n; i++) {
    const r = Math.floor(i / cols), k = i % cols;
    positions.push([ox + k * (pw + GAP), oy + r * (ph + GAP)]);
  }
  return { paper, copies: n, cols, rows, positions };
}

/** Default copy count: the most that still fit on 4×6 in paper, else the smallest option. */
export function defaultCopies(pw, ph) {
  const opts = sheetCopyOptions(pw, ph);
  const small = capacity(pw, ph, PAPERS[0].w, PAPERS[0].h);
  const fit = opts.filter(n => n <= small);
  return fit.length ? fit[fit.length - 1] : opts[0];
}

/** One-page PDF at the paper's exact physical size; the 300 dpi sheet is drawn at 72/300 pt per px. */
export async function sheetPdf(PDFLib, jpegBytes, paper) {
  const { PDFDocument, PrintScaling } = PDFLib;
  const pdf = await PDFDocument.create();
  pdf.setTitle(`Passport photo print sheet (${paper.label})`);
  pdf.setCreator('SnappTo'); pdf.setProducer('SnappTo');
  try { pdf.catalog.getOrCreateViewerPreferences().setPrintScaling(PrintScaling.None); } catch { /* optional hint */ }
  const [pw, ph] = paper.pt;
  const page = pdf.addPage([pw, ph]);
  const img = await pdf.embedJpg(jpegBytes);
  const iw = paper.w * 72 / PRINT_DPI, ih = paper.h * 72 / PRINT_DPI;
  page.drawImage(img, { x: (pw - iw) / 2, y: (ph - ih) / 2, width: iw, height: ih });
  return pdf.save();
}

// ════════════════════════════ browser ════════════════════════════

const ANALYSIS_MAX = 2000;          // long side for face analysis
const PREVIEW_MAX = 720;
const MAX_STEP_AREA = 8e6;          // keep intermediate canvases well under iOS limits
const WORK_MAX = 1700;              // working height for background removal (≈2× the biggest preset)
const OFFLINE_NODE = () => h('span', {},
  'Face and background models aren’t on this phone yet (about 15 MB, one time). Open this once online, or download it in ',
  h('a', { href: '#/more' }, 'More ▸ Use offline'), '.');

class Friendly extends Error {
  constructor(msg, node) { super(msg); this.friendly = true; this.node = node || null; }
}
function sayError(e) {
  if (e && e.friendly) return e.node || e.message;
  const m = String((e && e.message) || e || '');
  if (/memory|allocat|too large|encode/i.test(m))
    return 'Your phone ran low on memory for this photo. Close other tabs, or use a smaller photo, and try again.';
  return 'Something went wrong while making your photo. Please try again.';
}

function newCanvas(w, hgt) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(hgt));
  return c;
}
function ctx2d(c, read = false) {
  const x = c.getContext('2d', read ? { willReadFrequently: true } : undefined);
  if (!x) throw new Friendly('Your phone ran low on memory for this photo. Close other tabs, or use a smaller photo, and try again.');
  x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'high';
  return x;
}
/** Release canvas memory now (iOS Safari frees canvases lazily). */
function freeCanvas(c) { if (c && c.tagName === 'CANVAS') { c.width = 0; c.height = 0; } }

/** Scale a canvas through ≤2× steps to exactly tw×th. Frees intermediates (not the input). */
function resizeCanvas(src, tw, th) {
  if (src.width === tw && src.height === th) return src;
  let cur = src;
  for (const [w, hh] of stepSizes(src.width, src.height, tw, th)) {
    const next = newCanvas(w, hh);
    ctx2d(next).drawImage(cur, 0, 0, w, hh);
    if (cur !== src) freeCanvas(cur);
    cur = next;
  }
  return cur;
}

/** Draw a crop rectangle of an image/canvas (white outside it) at outW×outH, high quality. */
function drawRegion(src, W, H, rect, outW, outH) {
  const steps = stepSizes(rect.w, rect.h, outW, outH);
  while (steps.length > 1 && steps[0][0] * steps[0][1] > MAX_STEP_AREA) steps.shift();
  const [cw, ch] = steps[0];
  let c = newCanvas(cw, ch);
  const x = ctx2d(c);
  x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
  const d = clipDraw(rect, W, H, c.width, c.height);
  if (d) x.drawImage(src, d.sx, d.sy, d.sw, d.sh, d.dx, d.dy, d.dw, d.dh);
  for (const [w, hh] of steps.slice(1)) {
    const next = newCanvas(w, hh);
    ctx2d(next).drawImage(c, 0, 0, w, hh);
    freeCanvas(c); c = next;
  }
  return c;
}

function boxesFrom(result) {
  return ((result && result.detections) || []).map(d => {
    const b = d.boundingBox || {};
    return { x: b.originX || 0, y: b.originY || 0, w: b.width || 0, h: b.height || 0, score: d.categories?.[0]?.score ?? 1 };
  }).filter(f => f.w > 0 && f.h > 0);
}

/** Are the MediaPipe files already on the phone? (best effort; false when unsure) */
async function visionWarm() {
  if (store.get('passport:visionReady', false)) return true;
  try {
    if (typeof caches === 'undefined') return false;
    const has = async f => !!(await caches.match(vendorUrl(f), { ignoreSearch: true }));
    const core = await Promise.all(['mediapipe/vision_bundle.mjs', 'mediapipe/models/blaze_face_short_range.tflite',
      'mediapipe/models/selfie_segmenter.tflite'].map(has));
    if (core.includes(false)) return false;
    return (await has('mediapipe/wasm/vision_wasm_internal.wasm')) || (await has('mediapipe/wasm/vision_wasm_nosimd_internal.wasm'));
  } catch { return false; }
}

/** Load the face detector or the person segmenter with an honest progress label. */
async function loadModel(which, p) {
  const warm = await visionWarm();
  if (!warm && navigator.onLine === false) throw new Friendly('offline', OFFLINE_NODE());
  if (p) p.set(null, warm
    ? (which === 'face' ? 'Loading the face check…' : 'Loading the background remover…')
    : 'First time only: downloading face and background models (about 15 MB)…');
  try {
    const m = await (which === 'face' ? faceDetector() : personSegmenter());
    store.set('passport:visionReady', true);
    return m;
  } catch (e) {
    console.error(e);
    if (navigator.onLine === false) { store.set('passport:visionReady', false); throw new Friendly('offline', OFFLINE_NODE()); }
    throw new Friendly('Couldn’t load the face models. Check your connection and try again.');
  }
}

/** Make the background white with the selfie segmenter. Mutates `canvas`. → {ok, reason?} */
function whiteBackground(seg, canvas, face) {
  const W = canvas.width, H = canvas.height;
  let result = null, alpha = null, pick = null;
  try {
    result = seg.segment(canvas);
    const masks = (result && result.confidenceMasks) || [];
    if (!masks.length) return { ok: false };
    const list = masks.map(m => ({ data: m.getAsFloat32Array(), w: m.width || W, h: m.height || H }));
    const nface = { x: face.x / W, y: face.y / H, w: face.w / W, h: face.h / H };
    pick = pickPersonMask(list, nface);
    if (!pick || pick.score < 0.5) return { ok: false };
    const m = list[pick.index];
    const full = resampleMask(m.data, m.w, m.h, W, H);   // copy: safe after close()
    alpha = refineAlpha(full, W, H, { invert: pick.invert, radius: Math.max(1, Math.round(Math.max(W, H) / 500)) });
  } finally {
    try {
      if (result && typeof result.close === 'function') result.close();
      else result?.confidenceMasks?.forEach(m => m.close());
    } catch { /* already closed */ }
  }
  let person = 0;
  for (let i = 0; i < alpha.length; i += 7) if (alpha[i] > 0.5) person++;
  const cover = person / Math.ceil(alpha.length / 7);
  if (cover < 0.03) return { ok: false };
  const x = ctx2d(canvas, true);
  const img = x.getImageData(0, 0, W, H);
  compositeWhite(img.data, alpha);
  x.putImageData(img, 0, 0);
  return { ok: true, cover };
}

/** JPEG under maxBytes with a 300 dpi JFIF header. */
async function encodeJpeg(canvas, maxBytes) {
  let blob = await jpegUnder(canvas, maxBytes);
  let bytes = setJpegDpi(new Uint8Array(await blob.arrayBuffer()), PRINT_DPI);
  if (bytes.length > maxBytes) {   // header growth or a stubborn photo: go a little lower
    blob = await jpegUnder(canvas, maxBytes - 64, { start: 0.9, floor: 0.1, step: 0.05 });
    bytes = setJpegDpi(new Uint8Array(await blob.arrayBuffer()), PRINT_DPI);
  }
  return new Blob([bytes], { type: 'image/jpeg' });
}

/** The oval head guide: dims the outside, ring turns green when the live check passes. */
function ovalOverlay() {
  const cx = 150, cy = 178, rx = 88, ry = 118;
  const ring = `M${cx - rx} ${cy}a${rx} ${ry} 0 1 0 ${2 * rx} 0a${rx} ${ry} 0 1 0 ${-2 * rx} 0z`;
  const el = h('div', { class: 'overlay', html:
    `<svg viewBox="0 0 300 400" preserveAspectRatio="xMidYMid slice" width="100%" height="100%" aria-hidden="true">
      <path fill="rgba(10,8,24,.42)" fill-rule="evenodd" d="M0 0H300V400H0Z${ring}"/>
      <path class="ring" d="${ring}" fill="none" stroke="#fff" stroke-width="3" stroke-dasharray="9 7" stroke-linecap="round"/>
    </svg>` });
  const path = el.querySelector('.ring');
  const set = state => {
    path.setAttribute('stroke', state === 'ok' ? '#34D399' : state === 'warn' ? '#FBBF24' : '#fff');
    path.setAttribute('stroke-dasharray', state === 'ok' ? 'none' : '9 7');
  };
  return { el, set };
}

const CAM_ERRORS = {
  insecure: 'The live camera needs a secure (https) page. You can still take a selfie with your phone’s camera.',
  unsupported: 'This browser can’t show a live camera here. Use your phone’s camera instead, it works just as well.',
  NotAllowedError: 'Camera access is blocked. Allow the camera for this site in your browser settings and try again, or use your phone’s camera below.',
  NotFoundError: 'No camera was found on this device. Upload a photo instead.',
  NotReadableError: 'The camera is busy in another app. Close that app and try again, or use your phone’s camera below.',
  black: 'The live camera isn’t showing a picture here. Use your phone’s camera instead.',
};
CAM_ERRORS.SecurityError = CAM_ERRORS.NotAllowedError;
CAM_ERRORS.OverconstrainedError = CAM_ERRORS.NotFoundError;
CAM_ERRORS.AbortError = CAM_ERRORS.NotReadableError;
CAM_ERRORS.noframes = CAM_ERRORS.black;

/**
 * Live front camera with an oval guide. Start only from a user tap.
 * onCapture(canvas) gets the un-mirrored frame (exactly the area shown in the preview).
 * onFail(code) when the camera can't run; onClose(reason) when it closes without a photo.
 */
function createCamera({ onCapture, onFail, onClose, onReady }) {
  let stream = null, facing = 'user', timer = null, detector = null, stopped = false;
  let sawFrame = false, startedAt = 0, switching = false;
  const video = h('video', { playsinline: true, 'webkit-playsinline': true, muted: true, autoplay: true, 'aria-label': 'Camera preview' });
  video.muted = true; video.playsInline = true;
  const oval = ovalOverlay();
  const hint = h('div', { class: 'camhint', role: 'status' }, 'Starting camera…');
  const flash = h('div', { style: { position: 'absolute', inset: '0', background: '#fff', opacity: '0', transition: 'opacity .3s', pointerEvents: 'none' } });
  const round = { width: '48px', height: '48px', borderRadius: '50%', border: '0', background: 'rgba(255,255,255,.22)', color: '#fff',
    fontSize: '20px', display: 'grid', placeItems: 'center', cursor: 'pointer', WebkitBackdropFilter: 'blur(8px)', backdropFilter: 'blur(8px)' };
  const closeBtn = h('button', { type: 'button', 'aria-label': 'Close camera', style: round, onclick: () => { stop(); onClose('user'); } }, '✕');
  const shutter = h('button', { type: 'button', class: 'shutter', 'aria-label': 'Take photo', onclick: capture });
  const flipBtn = h('button', { type: 'button', 'aria-label': 'Switch camera', style: { ...round, visibility: 'hidden' }, onclick: flip }, '🔄');
  const el = h('div', { class: 'cam' }, video, oval.el, flash, hint, h('div', { class: 'bar' }, closeBtn, shutter, flipBtn));
  const small = document.createElement('canvas');
  const sctx = small.getContext('2d', { willReadFrequently: true });
  const setShutter = on => { shutter.disabled = !on; shutter.style.opacity = on ? '1' : '.45'; };
  setShutter(false);

  const onLeave = () => { if (!stopped) { stop(); } };
  const onVis = () => { if (document.hidden && !stopped) { stop(); onClose('hidden'); } };

  function kill() {
    if (stream) for (const t of stream.getTracks()) { try { t.stop(); } catch { /* ignore */ } }
    stream = null;
    try { video.pause(); } catch { /* ignore */ }
    video.srcObject = null;
  }
  function stop() {
    stopped = true;
    clearTimeout(timer); timer = null;
    kill();
    removeEventListener('hashchange', onLeave);
    removeEventListener('pagehide', onLeave);
    document.removeEventListener('visibilitychange', onVis);
  }

  async function open() {
    const md = navigator.mediaDevices;
    if (!md || !md.getUserMedia) return { error: window.isSecureContext === false ? 'insecure' : 'unsupported' };
    try {
      stream = await md.getUserMedia({ audio: false,
        video: { facingMode: { ideal: facing }, width: { ideal: 1920 }, height: { ideal: 1080 } } });
    } catch (e) {
      return { error: (e && e.name) || 'unsupported' };
    }
    if (stopped) { kill(); return { error: 'left' }; }       // left while the permission prompt was up
    video.classList.toggle('mirror', facing === 'user');
    video.srcObject = stream;
    const track = stream.getVideoTracks()[0];
    if (track) track.addEventListener('ended', () => { if (!stopped && !switching) { stop(); onClose('ended'); } });
    try { await video.play(); } catch { el.addEventListener('click', () => video.play().catch(() => {}), { once: true }); }
    const t0 = Date.now();
    while (!video.videoWidth && Date.now() - t0 < 8000 && !stopped) await new Promise(r => setTimeout(r, 100));
    if (stopped) return { error: 'left' };
    if (!video.videoWidth) { kill(); return { error: 'noframes' }; }
    return { ok: true };
  }

  async function start() {
    addEventListener('hashchange', onLeave);
    addEventListener('pagehide', onLeave);
    document.addEventListener('visibilitychange', onVis);
    const r = await open();
    if (r.error) { if (r.error !== 'left') { stop(); onFail(r.error); } return; }
    if (onReady) onReady();
    setShutter(true);
    hint.textContent = 'Fit your head inside the oval';
    startedAt = Date.now();
    if (navigator.mediaDevices.enumerateDevices) {
      navigator.mediaDevices.enumerateDevices().then(ds => {
        if (ds.filter(d => d.kind === 'videoinput').length > 1) flipBtn.style.visibility = 'visible';
      }).catch(() => {});
    }
    faceDetector().then(d => { detector = d; }).catch(() => { /* live hints are optional */ });
    loop();
  }

  async function flip() {
    if (switching || stopped) return;
    switching = true; setShutter(false); hint.textContent = 'Switching camera…';
    clearTimeout(timer); timer = null;
    const prev = facing;
    facing = facing === 'user' ? 'environment' : 'user';
    kill();
    let r = await open();
    if (r.error && r.error !== 'left') { facing = prev; toast('Couldn’t switch camera'); r = await open(); }
    switching = false;
    if (stopped) return;
    if (r.error) { stop(); onFail(r.error); return; }
    setShutter(true); sawFrame = false; startedAt = Date.now();
    hint.textContent = 'Fit your head inside the oval';
    loop();
  }

  function frameBox() {
    const r = el.getBoundingClientRect();
    return coverCrop(video.videoWidth, video.videoHeight, r.width, r.height);
  }

  function loop() {
    timer = null;
    if (stopped || switching || !stream) return;
    if (!el.isConnected) { stop(); return; }                 // page changed under us
    try {
      if (video.readyState >= 2 && video.videoWidth) {
        const cc = frameBox();
        const sw = 240, sh = Math.max(1, Math.round(240 * cc.sh / cc.sw));
        if (small.width !== sw || small.height !== sh) { small.width = sw; small.height = sh; }
        sctx.drawImage(video, cc.sx, cc.sy, cc.sw, cc.sh, 0, 0, sw, sh);
        const data = sctx.getImageData(0, 0, sw, sh).data;
        if (!sawFrame) {
          let s = 0, n = 0;
          for (let i = 0; i < data.length; i += 4 * 37) { s += data[i] + data[i + 1] + data[i + 2]; n++; }
          if (s / (n * 3) > 8) sawFrame = true;
          else if (Date.now() - startedAt > 6000) { stop(); onFail('black'); return; }
        }
        if (detector && sawFrame) {
          const faces = boxesFrom(detector.detect(small));
          const a = analyzeFaces(faces, { w: sw, h: sh, live: true, brightness: f => regionMeanGray(data, sw, sh, f) });
          const g = liveHint(a);
          hint.textContent = g.text;
          oval.set(g.ok ? 'ok' : 'warn');
        }
      }
    } catch (e) { console.warn(e); }
    timer = setTimeout(loop, 260);
  }

  function capture() {
    if (stopped || !video.videoWidth) return;
    const cc = frameBox();
    const c = newCanvas(cc.sw, cc.sh);
    // Raw frames are not mirrored: drawing them as-is gives the true, un-mirrored photo.
    try { ctx2d(c).drawImage(video, cc.sx, cc.sy, cc.sw, cc.sh, 0, 0, c.width, c.height); }
    catch (e) { console.error(e); freeCanvas(c); toast('Couldn’t take the photo. Please try again.', 'err'); return; }
    flash.style.opacity = '.85';
    setTimeout(() => { flash.style.opacity = '0'; }, 90);
    stop();
    onCapture(c);
  }

  return { el, start, stop };
}

// ════════════════════════════ the tool ════════════════════════════

export async function mount(root, toolId) {
  const exam = toolId === 'examphoto';
  const S = {
    src: null, srcW: 0, srcH: 0, base: 'photo', origin: null, ac: null, k: 1, preview: null,
    analysis: null, face: null, approved: false, token: 0, view: null, made: null, liveFailed: false, camCode: null,
  };
  let gen = 0;   // bumps when the document/size changes, so a stale make doesn't show
  let cam = null;

  // ── pickers (always attached so .click() works on iOS) ──
  const uploadPicker = filePicker({ accept: 'image/*', onFiles: f => { if (f[0]) fromFile(f[0], 'upload'); uploadPicker.reset(); } });
  const selfiePicker = filePicker({ accept: 'image/*', capture: 'user', onFiles: f => { if (f[0]) fromFile(f[0], 'selfie'); selfiePicker.reset(); } });
  const pickInput = p => p.querySelector('input[type=file]');
  const openUpload = () => { closeCamera(); pickInput(uploadPicker).click(); };
  const openSelfie = () => { closeCamera(); pickInput(selfiePicker).click(); };

  // ── 1. photo card ──
  const photoBody = h('div', { class: 'stack' });
  const show = (...nodes) => photoBody.replaceChildren(...nodes.filter(Boolean));
  const photoCard = card({ title: 'Your photo', sub: 'Front-facing, plain wall behind you. The background turns white automatically.' },
    photoBody, h('div', { class: 'hidden' }, uploadPicker, selfiePicker));

  const tips = () => h('details', { class: 'small muted' },
    h('summary', { style: { cursor: 'pointer', fontWeight: '600', color: 'var(--brand)', padding: '11px 0' } }, 'How to take a good photo'),
    h('ol', { style: { margin: '6px 0 0', paddingLeft: '20px', lineHeight: '1.6' } },
      h('li', {}, 'Face a window: light on your face, never behind you'),
      h('li', {}, 'Plain wall behind you (any colour, it becomes white)'),
      h('li', {}, 'Phone at eye level, about an arm’s length away'),
      h('li', {}, 'Head straight, neutral face, mouth closed'),
      h('li', {}, 'No glasses, no cap')));

  function renderChoose(msg) {
    show(
      msg || null,
      row(button('Use camera', () => openCamera(), { icon: '📷' }),
        button('Upload a photo', openUpload, { variant: 'secondary', icon: '🖼' })),
      tips());
  }

  function renderFallback(code) {
    S.liveFailed = true; S.camCode = code;
    const zone = filePicker({ accept: 'image/*', capture: 'user', icon: '🤳', label: 'Take a selfie', hint: 'Opens your phone’s camera',
      onFiles: f => { if (f[0]) fromFile(f[0], 'selfie'); } });
    const retry = ['NotAllowedError', 'SecurityError', 'NotReadableError', 'AbortError'].includes(code);
    show(notice(CAM_ERRORS[code] || CAM_ERRORS.unsupported, 'warn'), zone,
      row(button('Upload a photo', openUpload, { variant: 'secondary', icon: '🖼' }),
        retry ? button('Try live camera again', () => openCamera(true), { variant: 'ghost' }) : null),
      tips());
  }

  function closeCamera() { if (cam) { cam.stop(); cam = null; } }

  function openCamera(force = false) {
    closeCamera();
    if (S.liveFailed && !force) { renderFallback(S.camCode || 'unsupported'); return; }
    const c = createCamera({
      onReady: () => { S.liveFailed = false; S.camCode = null; },
      onCapture: canvas => { cam = null; usePhoto(canvas, canvas.width, canvas.height, 'selfie', 'camera'); },
      onFail: code => { cam = null; renderFallback(code); },
      onClose: reason => {
        cam = null;
        if (!root.isConnected) return;
        const msg = reason === 'ended' ? notice('The camera stopped. Tap “Use camera” to start it again.', 'info')
          : reason === 'hidden' ? notice('Camera paused while you were away. Tap “Use camera” to start it again.', 'info') : null;
        if (S.view && S.src) { show(S.view); if (msg) photoBody.prepend(msg); }
        else renderChoose(msg);
      },
    });
    cam = c;
    show(c.el, h('p', { class: 'small faint', style: { margin: '0', textAlign: 'center' } },
      'Keep the phone at eye level. The preview is mirrored; your photo won’t be.'));
    scrollToEl(photoCard);
    c.start().catch(e => { console.error(e); if (cam === c) { closeCamera(); renderFallback('unsupported'); } });
  }

  // ── 2. document card ──
  let getPreset;
  const docCard = exam ? examDocCard() : passportDocCard();

  function passportDocCard() {
    let key = store.get('passport:preset', DEFAULT_PRESET);
    if (!PRESETS[key]) key = DEFAULT_PRESET;
    const f = field({ label: 'Photo for', options: [] });
    for (const g of PRESET_GROUPS)
      f.input.append(h('optgroup', { label: g.label }, g.keys.map(k => h('option', { value: k }, PRESETS[k].label))));
    f.input.value = key;
    const spec = h('div', { class: 'small muted' }, specLine(PRESETS[key]));
    f.input.addEventListener('change', () => {
      key = PRESETS[f.input.value] ? f.input.value : DEFAULT_PRESET;
      store.set('passport:preset', key);
      spec.textContent = specLine(PRESETS[key]);
      presetChanged();
    });
    getPreset = () => ({ ok: true, preset: PRESETS[key] });
    return card({ title: 'Document' }, f.el, spec,
      h('div', { class: 'small faint' }, '⚠️ Rules change. Check the official portal before you submit.'));
  }

  function examDocCard() {
    let mode = store.get('passport:examMode', 'exam') === 'custom' ? 'custom' : 'exam';
    const saved = store.get('passport:custom', null) || {};
    const num = (label, value) => field({ label, type: 'number', value, inputmode: 'decimal', min: 1 });
    const fw = num('Width (px)', saved.w ?? CUSTOM_DEFAULTS.w);
    const fh = num('Height (px)', saved.h ?? CUSTOM_DEFAULTS.h);
    const fk = num('Max size (KB)', saved.kb ?? CUSTOM_DEFAULTS.max_kb);
    const spec = h('div', { class: 'small muted' });
    const err = h('div', { class: 'small', style: { color: 'var(--err)', fontWeight: '600' } });
    for (const f of [fw, fh, fk]) {
      f.el.style.flex = '1 1 86px';
      f.input.addEventListener('input', () => {
        store.set('passport:custom', { w: fw.value, h: fh.value, kb: fk.value });
        sync(); presetChanged();
      });
    }
    const customBox = h('div', { class: 'stack' }, row(fw.el, fh.el, fk.el), err);
    const sync = () => {
      customBox.classList.toggle('hidden', mode !== 'custom');
      if (mode === 'exam') { spec.textContent = specLine(PRESETS[EXAM_PRESET]); err.textContent = ''; return; }
      const r = customPreset(fw.value, fh.value, fk.value);
      spec.textContent = r.ok ? specLine(r.preset) : '';
      err.textContent = r.ok ? '' : r.error;
    };
    const seg = segmented([['exam', 'Exam portal (200×230)'], ['custom', 'Custom size']], mode, v => {
      mode = v; store.set('passport:examMode', v); sync(); presetChanged();
    });
    getPreset = () => mode === 'exam' ? { ok: true, preset: PRESETS[EXAM_PRESET] } : customPreset(fw.value, fh.value, fk.value);
    sync();
    return card({ title: 'Photo size' }, seg, customBox, spec,
      notice('Every exam sets its own photo size and KB limit. Check the exact numbers in the official notification or on the exam portal, and use Custom size if they differ.', 'info'),
      h('a', { href: '#/tool/signexam2', class: 'small', style: { fontWeight: '600', display: 'flex', alignItems: 'center', minHeight: '44px' } },
        'Need your signature too? Exam signature resizer ›'));
  }

  // ── action + results ──
  const out = h('div', {});
  const makeLabel = exam ? 'Make exam photo' : 'Make passport photo';
  const makeBtn = button(makeLabel, () => busy(makeBtn, onMake).then(() => { makeBtn.disabled = !S.approved; }),
    { full: true, icon: '✨', disabled: true });
  const privacy = h('p', { class: 'small faint', style: { textAlign: 'center', margin: '10px 0 0' } }, '🔒 Processed on your phone. Nothing is uploaded.');

  root.append(photoCard, docCard, makeBtn, privacy, out);
  renderChoose();

  // No unmount hook in the contract: when the router swaps the page out, stop the camera and
  // free the photo (blob URL + canvases). The router empties the view before this runs.
  const onRoute = () => {
    if (root.isConnected) return;
    removeEventListener('hashchange', onRoute);
    S.token++;
    closeCamera();
    releasePhoto();
  };
  addEventListener('hashchange', onRoute);

  function presetChanged() {
    gen++;
    if (out.childNodes.length) out.replaceChildren();
  }
  function setApproved(on) { S.approved = on; makeBtn.disabled = !on; }

  // ── photo in → analyse ──
  async function fromFile(file, origin) {
    closeCamera();
    const my = ++S.token;
    show(progressEl('Opening your photo…'));
    let img;
    try { img = await loadImage(file); }
    catch (e) {
      if (my !== S.token) return;
      renderChoose(notice(e.message || 'Couldn’t open that photo. Try a JPG or PNG.', 'err'));
      return;
    }
    if (my !== S.token) { revokeImg(img); return; }
    usePhoto(img, img.naturalWidth, img.naturalHeight, stem(file.name || 'photo'), origin, my);
  }

  function progressEl(label) { const p = progress(label); return p.el; }
  function revokeImg(img) { if (img && img.tagName === 'IMG' && img.src.startsWith('blob:')) URL.revokeObjectURL(img.src); }

  /** Free the current photo's canvases; keepSrc = re-analysing the same photo. */
  function releasePhoto(keepSrc = false) {
    if (S.ac && S.ac !== S.src) freeCanvas(S.ac);
    if (!keepSrc && S.src) { if (S.src.tagName === 'IMG') revokeImg(S.src); else freeCanvas(S.src); }
    freeCanvas(S.preview);
    if (S.made) freeCanvas(S.made.canvas);
    Object.assign(S, { src: null, ac: null, preview: null, made: null, analysis: null, face: null, view: null });
  }

  async function usePhoto(src, W, H, base, origin, token) {
    const my = token || ++S.token;
    releasePhoto(src === S.src);
    Object.assign(S, { src, srcW: W, srcH: H, base, origin });
    setApproved(false);
    out.replaceChildren();

    const status = h('div', { class: 'stack' });
    let preview;
    try {
      S.ac = (Math.max(W, H) > ANALYSIS_MAX || src.tagName !== 'CANVAS') ? toCanvas(src, ANALYSIS_MAX) : src;
      S.k = S.ac.width / W;
      preview = S.preview = toCanvas(S.ac, PREVIEW_MAX);
    } catch (e) {
      console.error(e);
      renderChoose(notice(sayError(e), 'err'));
      return;
    }
    Object.assign(preview.style, { maxHeight: '320px', width: 'auto', margin: '0 auto', borderRadius: '14px', boxShadow: '0 4px 18px rgba(0,0,0,.12)' });
    const view = S.view = h('div', { class: 'stack' }, preview, status);
    show(view);

    const p = progress('Checking your photo…');
    status.append(p.el);
    try {
      const fd = await loadModel('face', p);
      if (my !== S.token) return;
      p.set(null, 'Checking your photo…');
      await tick();
      const ac = S.ac;
      const faces = boxesFrom(fd.detect(ac));
      const ax = ctx2d(ac, true);
      const a = analyzeFaces(faces, {
        w: ac.width, h: ac.height, origW: W, origH: H,
        brightness: f => {
          const x0 = clamp(Math.floor(f.x), 0, ac.width - 1), y0 = clamp(Math.floor(f.y), 0, ac.height - 1);
          const x1 = clamp(Math.ceil(f.x + f.w), x0 + 1, ac.width), y1 = clamp(Math.ceil(f.y + f.h), y0 + 1, ac.height);
          const d = ax.getImageData(x0, y0, x1 - x0, y1 - y0);
          return regionMeanGray(d.data, d.width, d.height, { x: 0, y: 0, w: d.width, h: d.height });
        },
      });
      if (my !== S.token) return;
      S.analysis = a;
      S.face = a.face ? { x: a.face.x / S.k, y: a.face.y / S.k, w: a.face.w / S.k, h: a.face.h / S.k } : null;
      p.done();
      drawFaces(preview, a, preview.width / ac.width);
      status.replaceChildren(...checksView(a));
      if (a.ok) {
        setApproved(true);
        personSegmenter().catch(() => { /* warm-up only; real load reports errors */ });
      }
    } catch (e) {
      if (my !== S.token) return;
      console.error(e);
      p.done();
      status.replaceChildren(notice(sayError(e), 'err'),
        row(button('Try again', () => usePhoto(S.src, S.srcW, S.srcH, S.base, S.origin), { variant: 'secondary' }),
          button('Choose another', openUpload, { variant: 'ghost', icon: '🖼' })));
    }
  }

  function drawFaces(c, a, k) {
    const x = ctx2d(c);
    const lw = Math.max(2, Math.round(c.width / 220));
    x.lineWidth = lw;
    (a.faces || []).forEach((f, i) => {
      x.setLineDash(i === 0 ? [] : [lw * 3, lw * 2]);
      x.strokeStyle = i === 0 ? (a.ok ? '#11905A' : '#E0A100') : '#CF3434';
      x.strokeRect(f.x * k, f.y * k, f.w * k, f.h * k);
    });
    x.setLineDash([]);
  }

  function checksGrid(a) {
    const order = ['face', 'size', 'centre', 'light', 'top', 'res'].filter(id => a.checks[id] != null);
    return h('div', { class: 'small', style: { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '6px 12px' } },
      order.map(id => h('div', { style: { color: a.checks[id] ? 'var(--ok)' : 'var(--warn)', fontWeight: '600' } },
        (a.checks[id] ? '✓ ' : '✕ ') + CHECK_LABELS[id])));
  }

  function retake() { if (S.liveFailed) openSelfie(); else openCamera(); }

  function checksView(a) {
    const again = row(button('Retake', retake, { variant: a.ok ? 'ghost' : 'primary', icon: '📷' }),
      button('Choose another', openUpload, { variant: a.ok ? 'ghost' : 'secondary', icon: '🖼' }));
    if (a.ok) {
      return [notice(h('span', {}, h('b', {}, 'Great shot! '), `Every check passed. Pick the ${exam ? 'size' : 'document'} below, then tap “${makeLabel}”.`), 'ok'),
        checksGrid(a), again];
    }
    const nodes = [
      notice(h('div', {}, h('b', {}, 'Almost! Please retake:'),
        h('ul', { style: { margin: '6px 0 0', paddingLeft: '18px' } }, a.issues.map(i => h('li', {}, i.msg)))), 'warn'),
      checksGrid(a), again,
    ];
    if (!a.fatal) {
      const anyway = button('Use this photo anyway', () => {
        setApproved(true);
        anyway.replaceWith(h('p', { class: 'small faint', style: { margin: '0' } },
          'Using this photo. The result may not meet the official rules.'));
        personSegmenter().catch(() => {});
      }, { variant: 'ghost', full: true });
      nodes.push(anyway);
    }
    return nodes;
  }

  // ── make the photo (process_photo) ──
  async function onMake() {
    out.replaceChildren();
    if (!S.src || !S.face || !S.approved) { out.append(notice('Add a photo with a clear face first.', 'warn')); return; }
    const sel = getPreset();
    if (!sel.ok) { out.append(notice(sel.error, 'warn')); return; }
    const preset = sel.preset;
    const my = S.token, myGen = gen;
    const p = progress('Making your photo…');
    out.append(p.el);
    scrollToEl(p.el);
    try {
      const made = await makePhoto(preset, p);
      if (my !== S.token || myGen !== gen) { freeCanvas(made.canvas); p.done(); return; }
      if (S.made) freeCanvas(S.made.canvas);
      S.made = made;
      p.done();
      await showResult(made, preset);
    } catch (e) {
      console.error(e);
      if (p.el.isConnected) p.fail(sayError(e)); else out.append(notice(sayError(e), 'err'));
    }
  }

  async function makePhoto(preset, p) {
    const seg = await loadModel('seg', p);
    const face = S.face;
    const rect = cropRect(face, preset);
    const soft = rect.h < preset.h || rect.w < preset.w;
    // Work at up to 2× the target (never below it, and ≤ ~1700 px tall unless the target is
    // bigger), then one clean ≤2× reduction at the end.
    const workH = Math.round(clamp(rect.h, preset.h, Math.max(preset.h, Math.min(2 * preset.h, WORK_MAX))));
    const workW = Math.max(1, Math.round(workH * preset.w / preset.h));
    p.set(0.2, 'Framing head and shoulders…');
    await tick();
    const work = drawRegion(S.src, S.srcW, S.srcH, rect, workW, workH);
    p.set(0.4, 'Making the background white…');
    await tick();
    const fk = workW / rect.w;
    const faceWork = { x: (face.x - rect.left) * fk, y: (face.y - rect.top) * fk, w: face.w * fk, h: face.h * fk };
    let bg;
    try { bg = whiteBackground(seg, work, faceWork); }
    catch (e) { console.error(e); bg = { ok: false }; }
    p.set(0.75, `Fitting under ${preset.max_kb} KB…`);
    await tick();
    const final = resizeCanvas(work, preset.w, preset.h);
    if (final !== work) freeCanvas(work);
    const blob = await encodeJpeg(final, preset.max_kb * 1024);
    p.set(1, 'Done');
    return { canvas: final, blob, soft, bg, preset };
  }

  async function showResult(made, preset) {
    const { blob } = made;
    const under = blob.size <= preset.max_kb * 1024;
    const what = exam ? 'exam' : 'passport';
    const filename = `${S.base}_${what}_${preset.w}x${preset.h}.jpg`;
    const note = h('div', {},
      h('div', {}, `${preset.w} × ${preset.h} px · ${fmtBytes(blob.size)} (limit ${preset.max_kb} KB) · 300 DPI`),
      h('div', {}, `${under ? '✓' : '⚠️'} ${preset.label}`));
    const rc = await resultCard({ title: exam ? 'Exam photo ready' : 'Passport photo ready', blob, filename, note });
    out.append(rc);
    if (!under) out.append(notice(`Couldn’t get this photo under ${preset.max_kb} KB without ruining it. Try a smaller pixel size, or check the limit on the portal.`, 'warn'));
    if (!made.bg.ok) out.append(notice('Couldn’t separate you from the background cleanly, so the original background was kept. Stand in front of a plain, light wall and try again.', 'warn'));
    if (made.soft) out.append(notice('This photo may look soft: your face was smaller than the target size, so it was enlarged. For a crisper result, move closer or use the rear camera.', 'warn'));
    if (preset.sheet) out.append(sheetCard(made, preset));
    scrollToEl(rc);
  }

  // ── print sheet (build_print_sheet) ──
  function sheetCard(made, preset) {
    const opts = sheetCopyOptions(preset.w, preset.h);
    let copies = defaultCopies(preset.w, preset.h);
    const paperLine = h('div', { class: 'small muted' });
    const sheetOut = h('div', {});
    const update = () => {
      const L = sheetLayout(preset.w, preset.h, copies);
      paperLine.textContent = `${L.copies} photos of ${physical(preset)} on ${L.paper.label} paper, 300 dpi, with cut lines.`;
    };
    const seg = segmented(opts.map(n => [String(n), String(n)]), String(copies), v => { copies = Number(v); update(); sheetOut.replaceChildren(); });
    const btn = button('Make print sheet', () => busy(btn, async () => {
      sheetOut.replaceChildren();
      const p = progress('Laying out your sheet…');
      sheetOut.append(p.el);
      try { await buildSheet(made, preset, copies, sheetOut, p); }
      catch (e) { console.error(e); if (p.el.isConnected) p.fail(sayError(e)); else sheetOut.append(notice(sayError(e), 'err')); }
    }), { full: true, icon: '🖨' });
    update();
    return card({ title: 'Print sheet', sub: 'Several copies on one sheet, for any photo shop.' },
      h('div', { class: 'field' }, h('label', {}, 'Copies'), seg), paperLine, btn, sheetOut);
  }

  async function buildSheet(made, preset, copies, into, p) {
    const L = sheetLayout(preset.w, preset.h, copies);
    if (!L.copies) throw new Friendly('This photo is too big for a print sheet.');
    const sheet = newCanvas(L.paper.w, L.paper.h);
    const x = ctx2d(sheet);
    x.fillStyle = '#fff'; x.fillRect(0, 0, sheet.width, sheet.height);
    x.strokeStyle = 'rgb(190,190,190)'; x.lineWidth = 1;
    for (const [px, py] of L.positions) {
      x.drawImage(made.canvas, px, py);
      x.strokeRect(px - 0.5, py - 0.5, preset.w + 1, preset.h + 1);   // 1 px cut line just outside each photo
    }
    p.set(0.4, 'Saving the JPG…');
    await tick();
    let jpg;
    try { jpg = setJpegDpi(new Uint8Array(await (await canvasToBlob(sheet, 'image/jpeg', 0.92)).arrayBuffer()), PRINT_DPI); }
    finally { freeCanvas(sheet); }
    p.set(0.7, 'Saving the PDF…');
    await tick();
    const PDFLib = await libs.pdfLib();
    const pdf = await sheetPdf(PDFLib, jpg, L.paper);
    p.done();
    const base = `${S.base}_print_${L.paper.id}`;
    const jpgBlob = new Blob([jpg], { type: 'image/jpeg' });
    const pdfBlob = new Blob([pdf], { type: 'application/pdf' });
    into.append(
      await resultCard({ title: `${L.copies} copies on ${L.paper.label}`, blob: jpgBlob, filename: `${base}.jpg`,
        note: 'JPG for photo-lab machines.' }),
      await resultCard({ title: 'Same sheet as PDF', blob: pdfBlob, filename: `${base}.pdf`, preview: 'none',
        note: `For any print shop. Page is exactly ${L.paper.id === 'A4' ? 'A4 (210 × 297 mm)' : '4 × 6 in'}.` }),
      h('div', { style: { marginTop: '12px' } }, notice(h('span', {}, h('b', {}, 'Ask the shop for photo paper; print at 100% / actual size. '),
        'Not “fit to page”. Then cut along the light grey lines.'), 'info')));
  }

  function scrollToEl(el) {
    try {
      requestAnimationFrame(() => {
        const y = el.getBoundingClientRect().top + window.scrollY - 70;
        if (Math.abs(window.scrollY - y) > 40) window.scrollTo({ top: Math.max(0, y), behavior: 'smooth' });
      });
    } catch { /* ignore */ }
  }
}
