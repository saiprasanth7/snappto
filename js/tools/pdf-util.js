// Shared helpers for the PDF tools (pdf.js) and text recognition (ocr.js).
//
// The pure parts (page ranges, page geometry, rebuilding text lines) are
// exported so they can be unit-tested in Node. The rest wraps pdf-lib and
// PDF.js so every tool loads, saves and fails the same friendly way.
import { h, notice, tick } from '../ui.js';
import { libs, vendorUrl } from '../lib.js';

// ── errors ──────────────────────────────────────────────────────────
/** An error whose message is already fit to show. kind: warn | locked | restricted | invalid | memory | browser | other */
export class UserError extends Error {
  constructor(message, kind = 'warn', file) { super(message); this.name = 'UserError'; this.kind = kind; this.file = file; }
}

const quoted = name => (name ? `“${name}”` : 'This PDF');

export function lockedError(name) {
  return new UserError(`${quoted(name)} is password-protected — remove the password first (Unlock PDF runs in the Telegram bot).`, 'locked', name);
}

/** The PDF opens without a password but its maker set editing restrictions (an owner password). */
export function restrictedError(name) {
  return new UserError(`${quoted(name)} has editing restrictions set by whoever made it, so it can’t be changed here. PDF → Text and Compress ▸ Strong still work on it.`, 'restricted', name);
}

const OLD_BROWSER = 'Your browser is too old for this tool — update it (iPhone: Settings ▸ General ▸ Software Update)';

/** Map anything thrown by pdf-lib / PDF.js / the browser to a UserError with a human message. */
export function friendlyError(e, name) {
  if (e instanceof UserError) return e;
  const msg = String((e && e.message) || e || '');
  const ename = (e && e.name) || '';
  // PDF.js 6 relies on very new JavaScript built-ins; older browsers fail with "x is not a function".
  if (ename === 'SyntaxError' || /sumPrecise|getOrInsert|fromBase64|toBase64|toHex|withResolvers|Promise\.try|\.try is not a function|toArray is not a function/.test(`${msg} ${(e && e.details) || ''}`)) {
    return new UserError(`${OLD_BROWSER}, or use the Telegram bot.`, 'browser', name);
  }
  if (ename === 'PasswordException' || /is encrypted|password/i.test(msg)) return lockedError(name);
  if (ename === 'InvalidPDFException' || ename === 'MissingPDFException' || /call stack/i.test(msg) ||
      /Failed to parse|PDF header|Invalid PDF|invalid object|Expected instance of|Invalid object ref|xref/i.test(msg)) {
    return new UserError(`${quoted(name)} doesn’t look like a valid PDF — it may be damaged or only partly downloaded.`, 'invalid', name);
  }
  // WebAssembly engines (text recognition) abort with "Aborted(OOM)" or "Cannot enlarge memory".
  if (e instanceof RangeError || /out of memory|allocation failed|Array buffer allocation|Invalid array length|Aborted\(OOM\)|Cannot enlarge memory/i.test(msg)) {
    return new UserError('Your phone ran out of memory on this file — try a smaller file, or fewer pages at a time.', 'memory', name);
  }
  if (typeof console !== 'undefined') console.error(e);
  return new UserError(`Something went wrong${msg ? ` (${msg.slice(0, 160)})` : ''}. Please try again, or try a different file.`, 'other', name);
}

/** The words to show for a UserError. bot: false leaves out "use the Telegram bot" for tools the bot doesn't have. */
export const messageFor = (u, { bot = true } = {}) => (u.kind === 'browser' && !bot ? `${OLD_BROWSER}.` : u.message);

/**
 * The in-place error box for any failure. Password-protected PDFs get a link to Unlock PDF,
 * and PDFs with editing restrictions get links to the tools that still work. bot: as for messageFor.
 */
export function errorNotice(e, name, { bot = true } = {}) {
  const u = friendlyError(e, name);
  if (u.kind === 'locked') {
    return notice(h('span', {}, `${quoted(u.file)} is password-protected — remove the password first (`,
      h('a', { href: '#/tool/unlock' }, 'Unlock PDF'), ' runs in the Telegram bot).'), 'err');
  }
  if (u.kind === 'restricted') {
    return notice(h('span', {}, `${quoted(u.file)} has editing restrictions set by whoever made it, so it can’t be changed here. `,
      h('a', { href: '#/tool/pdftext' }, 'PDF → Text'), ' and ', h('a', { href: '#/tool/pdfcompress' }, 'Compress ▸ Strong'), ' still work on it.'), 'err');
  }
  return notice(messageFor(u, { bot }), u.kind === 'warn' ? 'warn' : 'err');
}

/** For failures while *opening* a file: anything that isn't a password or memory problem means the PDF is unreadable. */
function openError(e, name) {
  const u = friendlyError(e, name);
  return u.kind === 'other'
    ? new UserError(`${quoted(name)} doesn’t look like a valid PDF — it may be damaged or only partly downloaded.`, 'invalid', name)
    : u;
}

// ── words ───────────────────────────────────────────────────────────
export const plural = (n, one, many = one + 's') => `${n.toLocaleString('en-IN')} ${n === 1 ? one : many}`;
export const pagesLabel = n => plural(n, 'page');

// ── page ranges ─────────────────────────────────────────────────────
/**
 * "1-3, 5, 8-10" → zero-based page indices in the order given (duplicates kept).
 * 1-based, spaces and any dash style are fine; "8-" means 8 to the end, "-3" means 1 to 3.
 * Throws UserError naming the token that is wrong.
 */
export function parseRanges(text, pageCount) {
  const n = Math.max(0, pageCount | 0);
  const norm = String(text ?? '').replace(/[‐-―−]/g, '-').replace(/\s*-\s*/g, '-').trim();
  const tokens = norm.split(/[\s,;]+/).filter(Boolean);
  if (!tokens.length) throw new UserError('Type the pages you want, e.g. 1-3, 5', 'warn');
  const out = [];
  for (const tok of tokens) {
    let a, b, m;
    if ((m = /^(\d+)$/.exec(tok))) a = b = parseInt(m[1], 10);
    else if ((m = /^(\d*)-(\d*)$/.exec(tok)) && (m[1] || m[2])) {
      a = m[1] ? parseInt(m[1], 10) : 1;
      b = m[2] ? parseInt(m[2], 10) : n;
    } else throw new UserError(`“${tok}” isn’t a page number — use numbers like 1-3, 5`, 'warn');
    if (a < 1 || b < 1) throw new UserError(`“${tok}”: there’s no page 0 — pages start at 1`, 'warn');
    if (a > n || b > n) throw new UserError(`“${tok}” goes past the end — this PDF has ${pagesLabel(n)}`, 'warn');
    if (a > b) throw new UserError(`“${tok}” runs backwards — did you mean ${b}-${a}?`, 'warn');
    for (let p = a; p <= b; p++) out.push(p - 1);
  }
  return out;
}

export const uniqueSorted = idx => [...new Set(idx)].sort((a, b) => a - b);

/** [0,1,2,4] → "1–3, 5" (keeps the given order; only ascending runs are joined). */
export function compactRanges(idx) {
  const parts = [];
  for (let i = 0; i < idx.length;) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1] === idx[j] + 1) j++;
    parts.push(j > i ? `${idx[i] + 1}–${idx[j] + 1}` : `${idx[i] + 1}`);
    i = j + 1;
  }
  return parts.join(', ');
}

// ── page geometry ───────────────────────────────────────────────────
// A page is shown rotated `rot` degrees clockwise (its /Rotate). We lay things
// out in the "visual" frame the reader sees (origin bottom-left, y up, size W×H)
// and map back to PDF user space, so stamps sit where intended and read upright
// on rotated pages and pages whose crop box does not start at 0,0.

/** Any /Rotate value → 0 | 90 | 180 | 270. */
export const normAngle = a => (((Math.round((Number(a) || 0) / 90) * 90) % 360) + 360) % 360;

/** box = crop box {x, y, width, height}; returns the size the reader sees. */
export function visualSize(box, rot) {
  return normAngle(rot) % 180 ? { W: box.height, H: box.width } : { W: box.width, H: box.height };
}

/** Point in the visual frame → PDF user space. */
export function visualToUser(vx, vy, box, rot) {
  const { x, y, width: w, height: hh } = box;
  switch (normAngle(rot)) {
    case 90: return [x + w - vy, y + vx];
    case 180: return [x + w - vx, y + hh - vy];
    case 270: return [x + vy, y + hh - vx];
    default: return [x + vx, y + vy];
  }
}

/**
 * Where to draw a stamp (text or image) so that its anchor point lands on the
 * visual point (cx, cy), turned `theta` degrees anticlockwise as the reader sees it.
 * (ax, ay) is the anchor measured from the stamp's own origin (text baseline-left
 * or image bottom-left). Returns pdf-lib {x, y, rotate} (rotate in degrees).
 */
export function placeStamp({ cx, cy, theta = 0, ax = 0, ay = 0, box, rot = 0 }) {
  const t = theta * Math.PI / 180, c = Math.cos(t), s = Math.sin(t);
  const [x, y] = visualToUser(cx - (c * ax - s * ay), cy - (s * ax + c * ay), box, rot);
  return { x, y, rotate: (((normAngle(rot) + theta) % 360) + 360) % 360 };
}

// page numbers
export const NUMBER_FORMATS = [['n', '1'], ['of', '1 / N'], ['page', 'Page 1 of N']];
export function pageNumberText(fmt, n, total) {
  if (fmt === 'of') return `${n} / ${total}`;
  if (fmt === 'page') return `Page ${n} of ${total}`;
  return String(n);
}
/** Small margin that scales with the page: ~7 mm on A4, never cramped, never huge. */
export const pageMargin = (W, H) => Math.min(36, Math.max(14, Math.min(W, H) * 0.035));

/** Baseline-left point (visual frame) for a page number. pos: bc | br | tr */
export function pageNumberSpot({ W, H, pos, textWidth, size }) {
  const m = pageMargin(W, H);
  if (pos === 'br') return { vx: W - m - textWidth, vy: m };
  if (pos === 'tr') return { vx: W - m - textWidth, vy: H - m - size * 0.72 };
  return { vx: (W - textWidth) / 2, vy: m };
}

// watermark
const DIAG_FRAC = { s: 0.45, m: 0.65, l: 0.85 };   // share of the page diagonal the text spans
const DIAG_CAP = { s: 0.12, m: 0.18, l: 0.25 };    // …but never taller than this share of the short side (short words)
const TILE_FRAC = { s: 0.03, m: 0.045, l: 0.065 }; // font size as a share of the short side
export const TILE_ANGLE = 30;

/** Font size for a stamp whose width at size 1 is widthAt1 (height heightAt1). */
export function watermarkFontSize({ W, H, layout, size = 'm', widthAt1, heightAt1 = 1 }) {
  const short = Math.min(W, H);
  if (layout === 'tiled') return Math.max(6, short * (TILE_FRAC[size] || TILE_FRAC.m));
  const fit = (DIAG_FRAC[size] || DIAG_FRAC.m) * Math.hypot(W, H) / Math.max(widthAt1, 1e-6);
  return Math.max(6, Math.min(fit, (short * (DIAG_CAP[size] || DIAG_CAP.m)) / Math.max(heightAt1, 1e-6)));
}

/** Centres (visual frame) for a staggered grid of stamps turned theta degrees, covering the page. */
export function tileCentres({ W, H, stampW, stampH, theta = TILE_ANGLE }) {
  const stepX = stampW + Math.max(stampH * 3, 12);
  const stepY = Math.max(stampH * 3.2, 8);
  const D = Math.hypot(W, H);
  const t = theta * Math.PI / 180, c = Math.cos(t), s = Math.sin(t);
  const r = Math.hypot(stampW, stampH) / 2;
  const nx = Math.ceil(D / stepX) + 1, ny = Math.ceil(D / stepY) + 1;
  const pts = [];
  for (let j = -ny; j <= ny; j++) {
    const off = (j & 1) ? stepX / 2 : 0;
    for (let i = -nx; i <= nx; i++) {
      const u = i * stepX + off, v = j * stepY;
      const x = W / 2 + c * u - s * v, y = H / 2 + s * u + c * v;
      if (x < -r || x > W + r || y < -r || y > H + r) continue;
      pts.push([x, y]);
    }
  }
  return pts;
}

/**
 * All placements for one page. stamp = {widthAt1, heightAt1, ax1, ay1} (sizes at font size 1,
 * anchor = the stamp's centre measured from its drawing origin).
 */
export function watermarkPlacements({ box, rot, layout, size, stamp }) {
  const { W, H } = visualSize(box, rot);
  const fs = watermarkFontSize({ W, H, layout, size, widthAt1: stamp.widthAt1, heightAt1: stamp.heightAt1 });
  const theta = layout === 'tiled' ? TILE_ANGLE : Math.atan2(H, W) * 180 / Math.PI;
  const sw = stamp.widthAt1 * fs, sh = stamp.heightAt1 * fs;
  const centres = layout === 'tiled' ? tileCentres({ W, H, stampW: sw, stampH: sh, theta }) : [[W / 2, H / 2]];
  const spots = centres.map(([cx, cy]) => placeStamp({ cx, cy, theta, ax: stamp.ax1 * fs, ay: stamp.ay1 * fs, box, rot }));
  return { size: fs, width: sw, height: sh, spots };
}

// images → PDF
export const PAPER = { a4: [595.28, 841.89], letter: [612, 792] };
/**
 * Page size and image rectangle for one picture. paper: fit | a4 | letter; margin in points.
 * "fit" gives the page the picture's shape with its long side as long as A4's;
 * paper sizes turn landscape automatically for landscape pictures.
 */
export function imagePageLayout(imgW, imgH, paper = 'fit', margin = 0) {
  imgW = Math.max(1, imgW); imgH = Math.max(1, imgH);
  if (!PAPER[paper]) {
    const s = PAPER.a4[1] / Math.max(imgW, imgH);
    const w = imgW * s, hh = imgH * s;
    return { pageW: w + 2 * margin, pageH: hh + 2 * margin, x: margin, y: margin, w, h: hh };
  }
  let [pw, ph] = PAPER[paper];
  if (imgW > imgH) [pw, ph] = [ph, pw];
  const aw = pw - 2 * margin, ah = ph - 2 * margin;
  const s = Math.min(aw / imgW, ah / imgH);
  const w = imgW * s, hh = imgH * s;
  return { pageW: pw, pageH: ph, x: (pw - w) / 2, y: (ph - hh) / 2, w, h: hh };
}

// ── text from PDF.js text items ─────────────────────────────────────
const derotate = (x, y, q) => (q === 1 ? [y, -x] : q === 2 ? [-x, -y] : q === 3 ? [-y, x] : [x, y]);

/**
 * Rebuild readable lines from PDF.js getTextContent().items: items are grouped
 * into lines by baseline (in the page's dominant text direction, so sideways
 * pages work too), ordered left→right, with spaces restored at word gaps and a
 * blank line at paragraph gaps.
 */
export function textItemsToText(items) {
  const its = [];
  for (const it of items || []) {
    if (!it || typeof it.str !== 'string' || !it.str || !Array.isArray(it.transform)) continue;
    const [a, b, c, d, e, f] = it.transform.map(Number);
    const size = Math.hypot(c, d) || Math.hypot(a, b) || Number(it.height) || 10;
    const q = (((Math.round(Math.atan2(b, a) / (Math.PI / 2))) % 4) + 4) % 4;
    its.push({ s: it.str, e, f, w: Math.abs(Number(it.width) || 0), size, q });
  }
  if (!its.length) return '';
  const votes = [0, 0, 0, 0];
  for (const t of its) votes[t.q] += t.s.length;
  const q = votes.indexOf(Math.max(...votes));
  for (const t of its) [t.x, t.y] = derotate(t.e, t.f, q);
  its.sort((A, B) => B.y - A.y || A.x - B.x);

  const lines = [];
  for (const t of its) {
    const L = lines[lines.length - 1];
    if (L && L.y - t.y <= 0.5 * Math.max(L.size, t.size)) { L.items.push(t); L.size = Math.max(L.size, t.size); }
    else lines.push({ y: t.y, size: t.size, items: [t] });
  }
  const out = [];
  lines.forEach((L, i) => {
    L.items.sort((A, B) => A.x - B.x);
    let s = '', end = null, prev = 0;
    for (const t of L.items) {
      if (end != null) {
        const gap = t.x - end, sz = Math.max(t.size, prev);
        const edgeSpace = /\s$/.test(s) || /^\s/.test(t.s);
        if (gap > 3 * sz) s = s.replace(/\s+$/, '') + '    ';
        else if (gap > 0.18 * sz && !edgeSpace) s += ' ';
      }
      s += t.s;
      end = Math.max(end ?? -Infinity, t.x + t.w);
      prev = t.size;
    }
    if (i) {
      const P = lines[i - 1];
      if (P.y - L.y > 1.75 * Math.max(P.size, L.size)) out.push('');
    }
    out.push(s.replace(/\s+$/, ''));
  });
  return out.join('\n').replace(/^\s*\n+/, '').replace(/\n+\s*$/, '');
}

/** Count of visible characters (for "is there real text here?" checks). */
export const inkChars = s => (String(s).match(/\S/g) || []).length;
export const wordCount = s => (String(s).match(/\S+/g) || []).length;

/** Join per-page texts with the same separators the Telegram bot uses. */
export function joinPages(parts, emptyNote = '(no text on this page)') {
  if (parts.length === 1) return parts[0].text.trim();
  return parts.map(p => `── ${p.label} ──\n${p.text.trim() || emptyNote}`).join('\n\n');
}

// ── pdf-lib ─────────────────────────────────────────────────────────
/** True if the bytes start like a PDF (some files have junk before the header). */
export function looksLikePdf(bytes) {
  const n = Math.min(bytes.length, 1024) - 5;
  for (let i = 0; i <= n; i++) {
    if (bytes[i] === 0x25 && bytes[i + 1] === 0x50 && bytes[i + 2] === 0x44 && bytes[i + 3] === 0x46 && bytes[i + 4] === 0x2d) return true;
  }
  return false;
}

/** Open with pdf-lib. Throws UserError (locked / restricted / invalid / …) — never a raw library error. */
export async function openPdf(bytes, name) {
  const { PDFDocument } = await libs.pdfLib();
  if (!looksLikePdf(bytes)) throw new UserError(name ? `“${name}” isn’t a PDF file.` : 'That file isn’t a PDF.', 'invalid', name);
  let doc;
  try {
    doc = await PDFDocument.load(bytes, { updateMetadata: false });
    if (!doc.getPageCount()) throw new Error('Invalid PDF: no pages');
  } catch (e) {
    // pdf-lib can't decrypt anything. If PDF.js opens the file with no password, only an
    // owner password (editing restrictions) is set, and Unlock would just ask for a password.
    if (/is encrypted/i.test(String(e && e.message)) && await opensWithoutPassword(bytes)) throw restrictedError(name);
    throw openError(e, name);
  }
  return doc;
}

async function opensWithoutPassword(bytes) {
  try { const { task } = await openPdfjs(bytes); await task.destroy(); return true; } catch { return false; }
}

export async function newPdf() {
  const { PDFDocument } = await libs.pdfLib();
  const doc = await PDFDocument.create();
  doc.setProducer('SnappTo'); doc.setCreator('SnappTo');
  return doc;
}

/** Copy pages (zero-based, in order, repeats allowed) of src into a new PDF. One copy pass, so shared fonts stay shared. */
export async function copyToNew(src, indices) {
  const out = await newPdf();
  await copyPagesInto(out, src, indices);
  return out;
}

/**
 * Copy pages (zero-based, in order, repeats allowed) of src onto the end of out; returns them.
 * pdf-lib's copyPages follows every link, so a table of contents would drag every page it
 * points to into the file, invisible but readable. Here each page is copied through its
 * own ref, so links between copied pages land on the copies, and nothing leads into a
 * page left behind: links to it are removed, and so are form-field and article ties.
 */
export async function copyPagesInto(out, src, indices) {
  const L = await libs.pdfLib();
  const { PDFObjectCopier, PDFPage, PDFPageLeaf, PDFRef, PDFDict, PDFName, PDFNull } = L;
  await src.flush();
  const pages = src.getPages();
  const keep = new Set(indices.map(i => pages[i].ref));
  const annotRefs = p => (p.node.Annots()?.asArray() || []).filter(a => a instanceof PDFRef);
  // Pages left behind, and annotations that live only on them.
  const gone = new Set(pages.map(p => p.ref).filter(r => !keep.has(r)));
  const partial = gone.size > 0;
  for (const p of pages) if (gone.has(p.ref)) for (const a of annotRefs(p)) gone.add(a);
  for (const p of pages) if (keep.has(p.ref)) for (const a of annotRefs(p)) gone.delete(a);

  const Subtype = PDFName.of('Subtype'), Widget = PDFName.of('Widget'), Parent = PDFName.of('Parent'), B = PDFName.of('B');
  const copier = PDFObjectCopier.for(src.context, out.context);
  const copy = copier.copy;
  copier.copy = obj => {
    if (obj instanceof PDFRef && gone.has(obj)) return PDFNull;
    if (partial && obj instanceof PDFDict) {
      // A form field's other widgets (and their values) and article beads lead to other pages.
      const cut = obj instanceof PDFPageLeaf ? B : obj.get(Subtype) === Widget ? Parent : null;
      if (cut && obj.has(cut)) { obj = obj.clone(); obj.delete(cut); }
    }
    return copy(obj);
  };

  const added = [], copied = new Set();
  for (const i of indices) {
    const { ref } = pages[i];
    let page;
    if (copied.has(ref)) {   // a repeat gets a page object of its own
      const node = copier.copy(pages[i].node);
      page = PDFPage.of(node, out.context.register(node), out);
    } else {
      copied.add(ref);
      const to = copier.copy(ref);
      page = PDFPage.of(out.context.lookup(to), to, out);
    }
    out.addPage(page);
    added.push(page);
  }
  for (const page of added) dropDeadLinks(page, L);
  return added;
}

/** Remove links whose target page was left behind (copyPagesInto turned the target into null). */
function dropDeadLinks(page, { PDFDict, PDFArray, PDFName, PDFNull }) {
  const annots = page.node.Annots();
  if (!annots) return;
  const Link = PDFName.of('Link'), A = PDFName.of('A');
  for (let i = annots.size() - 1; i >= 0; i--) {
    const a = annots.lookup(i);
    if (!(a instanceof PDFDict) || a.get(PDFName.of('Subtype')) !== Link) continue;
    const act = a.lookup(A);
    const dest = a.lookup(PDFName.of('Dest')) || (act instanceof PDFDict ? act.lookup(PDFName.of('D')) : undefined);
    if (dest instanceof PDFArray && dest.get(0) === PDFNull) annots.remove(i);
  }
}

/**
 * Drop every object nothing in the document points to any more (pages left behind, links
 * just removed, leftovers of earlier edits), so they never travel inside the saved file.
 */
async function dropUnreachable(doc) {
  const { PDFRef, PDFDict, PDFArray, PDFStream } = await libs.pdfLib();
  const ctx = doc.context, seen = new Set();
  const todo = [ctx.trailerInfo.Root, ctx.trailerInfo.Info, ctx.trailerInfo.Encrypt];
  while (todo.length) {
    const o = todo.pop();
    if (!o || seen.has(o)) continue;
    seen.add(o);
    if (o instanceof PDFRef) todo.push(ctx.lookup(o));
    else if (o instanceof PDFDict) { for (const v of o.values()) todo.push(v); }
    else if (o instanceof PDFArray) { for (const v of o.asArray()) todo.push(v); }
    else if (o instanceof PDFStream) todo.push(o.dict);
  }
  for (const [ref] of ctx.enumerateIndirectObjects()) if (!seen.has(ref)) ctx.delete(ref);
}

/** The finished file's bytes. */
export async function pdfBytes(doc) {
  await dropUnreachable(doc);
  return doc.save({ useObjectStreams: true });
}

export async function savePdf(doc) {
  return new Blob([await pdfBytes(doc)], { type: 'application/pdf' });
}

/** Turn pages by delta (90 | 180 | 270, clockwise) on top of their current rotation. */
export async function rotatePages(doc, indices, delta) {
  const { degrees } = await libs.pdfLib();
  const pages = doc.getPages();
  for (const i of indices) pages[i].setRotation(degrees(normAngle(pages[i].getRotation().angle + delta)));
}

const GREY = [0.3, 0.3, 0.3];
/**
 * Number every page. opts: {pos: bc|br|tr, fmt: n|of|page, start, size, onPage(i, n)}.
 * Respects each page's rotation and crop box.
 */
export async function addPageNumbers(doc, { pos = 'bc', fmt = 'of', start = 1, size = 11, onPage } = {}) {
  const { StandardFonts, rgb, degrees } = await libs.pdfLib();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const pages = doc.getPages();
  const total = start + pages.length - 1;
  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    const box = page.getCropBox(), rot = normAngle(page.getRotation().angle);
    const { W, H } = visualSize(box, rot);
    const text = pageNumberText(fmt, start + i, total);
    const tw = font.widthOfTextAtSize(text, size);
    const { vx, vy } = pageNumberSpot({ W, H, pos, textWidth: tw, size });
    const at = placeStamp({ cx: vx, cy: vy, box, rot });
    page.drawText(text, { x: at.x, y: at.y, size, font, color: rgb(...GREY), rotate: degrees(at.rotate) });
    if (onPage && (await onPage(i, pages.length)) === false) return false;
  }
  return true;
}

export const WATERMARK_COLOURS = { grey: [0.5, 0.5, 0.5], red: [0.85, 0.15, 0.15], blue: [0.15, 0.35, 0.85] };

/** True if pdf-lib's standard fonts (WinAnsi) can write this text. */
export function standardFontCanWrite(font, text) {
  try { font.encodeText(text); font.widthOfTextAtSize(text, 10); return true; } catch { return false; }
}

/** True if Helvetica can't write this text (Hindi, Telugu, ₹, emoji…), so it must be drawn as a picture. */
export async function needsPicture(text) {
  const { PDFDocument, StandardFonts } = await libs.pdfLib();
  const probe = await PDFDocument.create();
  return !standardFontCanWrite(await probe.embedFont(StandardFonts.HelveticaBold), text);
}

/**
 * Stamp a watermark on every page.
 * opts: {text, layout: diagonal|tiled, size: s|m|l, opacity, colour: grey|red|blue, png, onPage}
 * `png` = {bytes, widthAt1, heightAt1} — a pre-rendered picture of the text, used instead of
 * Helvetica Bold when the text has characters the standard fonts can't write.
 */
export async function addWatermark(doc, { text, layout = 'diagonal', size = 'm', opacity = 0.3, colour = 'grey', png, onPage } = {}) {
  const { StandardFonts, rgb, degrees } = await libs.pdfLib();
  let font = null, image = null, stamp;
  if (png) {
    image = await doc.embedPng(png.bytes);
    stamp = { widthAt1: png.widthAt1, heightAt1: png.heightAt1, ax1: png.widthAt1 / 2, ay1: png.heightAt1 / 2 };
  } else {
    font = await doc.embedFont(StandardFonts.HelveticaBold);
    const w1 = font.widthOfTextAtSize(text, 1);
    stamp = { widthAt1: w1, heightAt1: 1, ax1: w1 / 2, ay1: 0.36 };   // centre of the capitals
  }
  const color = rgb(...(WATERMARK_COLOURS[colour] || WATERMARK_COLOURS.grey));
  const pages = doc.getPages();
  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    const L = watermarkPlacements({ box: page.getCropBox(), rot: page.getRotation().angle, layout, size, stamp });
    for (const at of L.spots) {
      if (image) page.drawImage(image, { x: at.x, y: at.y, width: L.width, height: L.height, rotate: degrees(at.rotate), opacity });
      else page.drawText(text, { x: at.x, y: at.y, size: L.size, font, color, rotate: degrees(at.rotate), opacity });
    }
    if (onPage && (await onPage(i, pages.length)) === false) return false;
  }
  return true;
}

// ── PDF.js ──────────────────────────────────────────────────────────
/** Open with PDF.js → {pdf, task}. Always `await task.destroy()` when done (it owns a worker). */
export async function openPdfjs(bytes, name) {
  const pdfjs = await libs.pdfjs();
  if (!looksLikePdf(bytes)) throw new UserError(name ? `“${name}” isn’t a PDF file.` : 'That file isn’t a PDF.', 'invalid', name);
  // PDF.js hands the buffer to its worker (detaching it), so give it a copy.
  const task = pdfjs.getDocument({
    data: bytes.slice(), isEvalSupported: false, stopAtErrors: false,
    // Decoders for scanned-page images (JBIG2 / CCITT / JPEG 2000), the 14
    // standard fonts that PDFs may reference without embedding, CJK cmaps, and
    // the CMYK profile. Without these, many scans render as blank pages.
    wasmUrl: vendorUrl('pdfjs/wasm/'),
    standardFontDataUrl: vendorUrl('pdfjs/standard_fonts/'),
    cMapUrl: vendorUrl('pdfjs/cmaps/'), cMapPacked: true,
    iccUrl: vendorUrl('pdfjs/iccs/'),
  });
  try { return { pdf: await task.promise, task, pdfjs }; }
  catch (e) { try { await task.destroy(); } catch { /* ignore */ } throw openError(e, name); }
}

/**
 * Render one page (1-based) to a new canvas at `scale` (1 = 72 dpi), capped at maxPixels
 * so phones don't run out of canvas memory. Returns {canvas, width, height} where
 * width/height are the page's visual size in points. Release the canvas with dropCanvas().
 */
export async function renderPage(pdf, pageNo, scale, { maxPixels = 12e6 } = {}) {
  const page = await pdf.getPage(pageNo);
  try {
    const base = page.getViewport({ scale: 1 });
    let s = scale;
    if (base.width * base.height * s * s > maxPixels) s = Math.sqrt(maxPixels / (base.width * base.height));
    const vp = page.getViewport({ scale: s });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.floor(vp.width));
    canvas.height = Math.max(1, Math.floor(vp.height));
    // annotationMode 3 = ENABLE_STORAGE: filled-in form fields are drawn too.
    try { await page.render({ canvas, viewport: vp, annotationMode: 3 }).promise; }
    catch (e) { dropCanvas(canvas); throw e; }
    return { canvas, width: base.width, height: base.height };
  } finally {
    page.cleanup();
  }
}

/** Free a canvas's backing memory right away (matters on iPhone). */
export function dropCanvas(c) { if (c) { c.width = 0; c.height = 0; } }

export { tick };
