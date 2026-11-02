// SnappTo — PDF tools. Everything runs on the phone with pdf-lib (edit/build)
// and PDF.js (read/render); nothing is uploaded.
// Tool ids: merge, splitpdf, pdfcompress, img2pdf, rotate, extract, delpages,
//           pagenumbers, watermark, pdftext
import {
  h, card, button, busy, field, row, segmented, filePicker, notice, progress, resultCard,
  fmtBytes, outputBox, stem, loadImage, toCanvas, canvasToBlob, tick,
} from '../ui.js';
import { libs } from '../lib.js';
import {
  UserError, friendlyError, errorNotice, plural, pagesLabel, parseRanges, uniqueSorted, compactRanges,
  openPdf, newPdf, copyToNew, copyPagesInto, savePdf, pdfBytes, rotatePages, addPageNumbers, addWatermark, needsPicture,
  WATERMARK_COLOURS, NUMBER_FORMATS, pageNumberText, imagePageLayout, openPdfjs, renderPage, dropCanvas,
  textItemsToText, joinPages, inkChars, wordCount,
} from './pdf-util.js';

const PDF_ACCEPT = 'application/pdf,.pdf';

const TOOLS = {
  merge: mergeTool,
  splitpdf: splitTool,
  pdfcompress: compressTool,
  img2pdf: imagesTool,
  rotate: rotateTool,
  extract: root => pagesTool(root, false),
  delpages: root => pagesTool(root, true),
  pagenumbers: numbersTool,
  watermark: watermarkTool,
  pdftext: textTool,
};

export async function mount(root, toolId) {
  const build = TOOLS[toolId];
  if (!build) { root.append(notice('This tool isn’t available here yet.', 'err')); return; }
  try { build(root); }
  catch (e) { root.append(errorNotice(e)); }
}

// ── building blocks ─────────────────────────────────────────────────

/** A segmented control with a field-style label above it. */
function labelled(label, control, hint) {
  return h('div', { class: 'field' }, h('label', {}, label), control, hint);
}
const hintEl = text => h('div', { class: 'hint' }, text);

/** Two-line label for a segmented button: bold title, small subtitle. */
const twoLine = (title, sub) => h('span', { style: { display: 'block', lineHeight: '1.25' } }, title,
  h('span', { style: { display: 'block', fontSize: '12px', fontWeight: '500', opacity: '.75' } }, sub));

/** Scroll new results into view when they land below the fold (tab bar included). */
function reveal(el) {
  requestAnimationFrame(() => {
    const top = el.getBoundingClientRect().top;
    if (top > innerHeight - 160) scrollBy({ top: top - innerHeight * 0.3, behavior: 'smooth' });
  });
}

/**
 * The one primary button. fn(prog) does the work and returns node(s) to show.
 * prog.set(frac|null, label) shows the progress bar on first use. Errors land in place.
 */
function runButton(label, out, fn) {
  const btn = button(label, () => busy(btn, async () => {
    out.replaceChildren();
    const p = progress('Working…');
    const prog = { set(f, t) { if (!p.el.isConnected) out.append(p.el); p.set(f, t); } };
    let nodes;
    try { nodes = await fn(prog); }
    catch (e) { nodes = errorNotice(e); }
    p.done();
    try { nodes = (await Promise.all([].concat(nodes ?? []))).filter(Boolean); }
    catch (e) { nodes = [errorNotice(e)]; }
    if (nodes.length) { out.append(...nodes); reveal(out); }
  }), { full: true });
  return btn;
}

/**
 * Single-PDF input: picker + "12 pages · 3.4 MB" line (or the error, right away).
 * engine 'lib' parses with pdf-lib (needed to edit); 'pdfjs' only reads (text tools).
 * readOnly: a note to show when the PDF has editing restrictions. Such a PDF is then
 * still accepted (src.restricted holds the error for runs that need to edit it).
 * get() → {file, bytes, pages, doc?, restricted?} or throws a UserError.
 */
function pdfInput({ engine = 'lib', readOnly, onReady } = {}) {
  let cur = null;
  const info = h('div', { class: 'hidden' });
  const show = (...nodes) => {
    nodes = nodes.filter(Boolean);
    info.replaceChildren(...nodes);
    info.classList.toggle('hidden', !nodes.length);
  };
  const picker = filePicker({
    accept: PDF_ACCEPT, label: 'Choose a PDF', hint: 'Tap to pick, or drop a file here', icon: '📄',
    onFiles: fl => choose(fl[0]),
  });
  async function choose(file) {
    if (!file) { cur = null; show(); onReady && onReady(null); return; }
    const mine = { file };
    cur = mine;
    show(h('div', { class: 'muted small' }, 'Reading the PDF…'));
    mine.promise = (async () => {
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (engine === 'pdfjs') {
        const { pdf, task } = await openPdfjs(bytes);
        const pages = pdf.numPages;
        await task.destroy();
        return { file, bytes, pages };
      }
      try {
        const doc = await openPdf(bytes);
        return { file, bytes, doc, pages: doc.getPageCount(), used: false };
      } catch (e) {
        if (!readOnly || !(e instanceof UserError) || e.kind !== 'restricted') throw e;
        const { pdf, task } = await openPdfjs(bytes);
        const pages = pdf.numPages;
        await task.destroy();
        return { file, bytes, pages, restricted: e };
      }
    })();
    try {
      const src = await mine.promise;
      if (cur !== mine) return;
      show(h('div', { class: 'muted small' }, `📄 ${pagesLabel(src.pages)} · ${fmtBytes(file.size)}`),
        src.restricted && notice(readOnly, 'info'),
        file.size > 60 * 1024 * 1024 && notice('This is a big file, so it may take a while on a phone.', 'info'));
      onReady && onReady(src);
    } catch (e) {
      if (cur !== mine) return;
      show(errorNotice(e));
      onReady && onReady(null);
    }
  }
  return {
    nodes: [picker, info],
    get() {
      if (!cur) return Promise.reject(new UserError('Choose a PDF first.', 'warn'));
      return cur.promise;
    },
  };
}

/** The parsed document for an editing run: the one parsed at pick time first, a fresh copy after that. */
async function freshDoc(src) {
  if (!src.used) { src.used = true; return src.doc; }
  return openPdf(src.bytes);
}

/**
 * Page-range text field with a live summary under it.
 * summary(indices, pageCount) → text, or {err: text} to flag a problem early.
 */
function rangeInput({ label, placeholder = 'e.g. 1-3, 5, 8-10', summary }) {
  const f = field({ label, placeholder, hint: ' ' });
  f.input.setAttribute('autocapitalize', 'off');
  f.input.setAttribute('enterkeyhint', 'done');
  const hint = f.el.querySelector('.hint');
  let count = 0;
  const say = (t, bad) => { hint.textContent = t; hint.style.color = bad ? 'var(--err)' : ''; };
  const refresh = () => {
    const t = f.value.trim();
    if (!count) return say('Use commas and dashes, e.g. 1-3, 5, 8-10');
    if (!t) return say(`Pages 1 to ${count}. Use commas and dashes, e.g. 1-3, 5`);
    try {
      const s = summary(parseRanges(t, count), count);
      if (s && s.err) say(s.err, true); else say(s);
    } catch (e) { say(e.message, true); }
  };
  f.input.addEventListener('input', refresh);
  refresh();
  return { el: f.el, get value() { return f.value; }, setCount(n) { count = n || 0; refresh(); } };
}

/**
 * Ordered file list with ↑ ↓ × on each row (the kit's picker only adds/removes).
 * describe(file) → Promise<string> adds e.g. "3 pages" next to the size.
 */
function fileList({ accept, label, hint, icon, thumbs = false, describe, onChange }) {
  let files = [];
  const thumbEls = new Map();
  const listEl = h('div', { class: 'files' });
  const foot = h('div', { class: 'hidden', style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', marginTop: '10px' } });
  const changed = () => { render(); onChange && onChange(files.slice()); };
  const picker = filePicker({
    accept, multiple: true, label, hint, icon,
    onFiles: fl => { if (!fl.length) return; picker.reset(); files = files.concat(fl); changed(); },
  });

  const thumb = f => {
    if (!thumbs || !/^image\//.test(f.type || '')) return h('span', { style: { flex: 'none', width: '22px', textAlign: 'center' } }, thumbs ? '🖼' : '📄');
    if (!thumbEls.has(f)) {
      const url = URL.createObjectURL(f);
      const img = h('img', { alt: '', src: url, style: { width: '40px', height: '40px', objectFit: 'cover', borderRadius: '8px', flex: 'none', background: 'var(--surface-2)' } });
      const free = () => URL.revokeObjectURL(url);
      img.addEventListener('load', free, { once: true });
      img.addEventListener('error', () => { free(); img.replaceWith(h('span', { style: { flex: 'none', width: '40px', textAlign: 'center' } }, '🖼')); }, { once: true });
      thumbEls.set(f, img);
    }
    return thumbEls.get(f);
  };
  const iconBtn = (txt, aria, onclick, disabled) => h('button', {
    type: 'button', 'aria-label': aria, disabled, onclick,
    style: { width: '40px', height: '44px', flex: 'none', fontSize: '19px', opacity: disabled ? '.28' : '' },
  }, txt);

  function render() {
    for (const f of [...thumbEls.keys()]) if (!files.includes(f)) thumbEls.delete(f);
    listEl.replaceChildren(...files.map((f, i) => {
      const meta = h('div', { class: 's' }, fmtBytes(f.size));
      if (describe) describe(f).then(t => { meta.textContent = `${fmtBytes(f.size)} · ${t}`; }, e => {
        const k = friendlyError(e).kind;
        meta.textContent = k === 'locked' ? 'Password-protected' : k === 'restricted' ? 'Editing restricted' : k === 'invalid' ? 'Not a readable PDF' : 'Can’t read this file';
        meta.style.color = 'var(--err)';
      });
      const move = d => { [files[i], files[i + d]] = [files[i + d], files[i]]; changed(); };
      return h('div', { class: 'file', style: { gap: '6px', padding: '4px 2px 4px 10px' } },
        thumb(f),
        h('div', { style: { flex: '1', minWidth: '0' } }, h('div', { class: 'n' }, f.name), meta),
        iconBtn('↑', `Move ${f.name} up`, () => move(-1), i === 0),
        iconBtn('↓', `Move ${f.name} down`, () => move(1), i === files.length - 1),
        iconBtn('×', `Remove ${f.name}`, () => { files.splice(i, 1); changed(); }));
    }));
    foot.classList.toggle('hidden', files.length < 2);
    foot.replaceChildren(
      h('span', { class: 'faint small' }, `${plural(files.length, 'file')} · ↑ ↓ set the order`),
      button('Remove all', () => { files = []; changed(); }, { variant: 'ghost', small: true }));
  }
  return { el: h('div', {}, picker, listEl, foot), files: () => files.slice() };
}

const fileStem = src => stem(src.file.name);

// ── Merge ───────────────────────────────────────────────────────────
function mergeTool(root) {
  const out = h('div');
  const loaded = new Map();
  const load = f => {
    if (!loaded.has(f)) {
      const pr = f.arrayBuffer().then(b => openPdf(new Uint8Array(b), f.name));
      pr.catch(() => {});
      loaded.set(f, pr);
    }
    return loaded.get(f);
  };
  const list = fileList({
    accept: PDF_ACCEPT, label: 'Choose PDFs', hint: 'Pick two or more — you can add more any time', icon: '📄',
    describe: async f => pagesLabel((await load(f)).getPageCount()),
    onChange: files => { out.replaceChildren(); for (const f of [...loaded.keys()]) if (!files.includes(f)) loaded.delete(f); },
  });
  const go = runButton('Merge PDFs', out, async p => {
    const files = list.files();
    if (files.length < 2) throw new UserError(files.length ? 'Add at least one more PDF to merge with.' : 'Choose two or more PDFs first.', 'warn');
    const merged = await newPdf();
    let total = 0;
    for (let i = 0; i < files.length; i++) {
      p.set(i / files.length, `Adding file ${i + 1} of ${files.length}`);
      await tick();
      const src = await load(files[i]);
      total += (await copyPagesInto(merged, src, src.getPageIndices())).length;
    }
    p.set(null, 'Saving…'); await tick();
    const blob = await savePdf(merged);
    return resultCard({ title: 'Merged', blob, filename: 'merged.pdf', note: `${plural(files.length, 'file')} · ${pagesLabel(total)}` });
  });
  root.append(card({ title: 'Your PDFs', sub: 'They’re joined in the order shown.' }, list.el), go, out);
}

// ── Split ───────────────────────────────────────────────────────────
function splitTool(root) {
  const out = h('div');
  let mode = 'every';
  const ranges = rangeInput({ label: 'Pages for the new PDF', summary: idx => `New PDF with ${pagesLabel(idx.length)}` });
  const rangeWrap = h('div', { class: 'hidden' }, ranges.el);
  const modeHint = hintEl('Each page becomes its own PDF, all in one ZIP.');
  const input = pdfInput({ onReady: src => { out.replaceChildren(); ranges.setCount(src && src.pages); } });
  const modes = segmented([['every', 'Every page'], ['ranges', 'Ranges']], mode, v => {
    mode = v; out.replaceChildren();
    rangeWrap.classList.toggle('hidden', v !== 'ranges');
    modeHint.textContent = v === 'ranges' ? 'Pick pages and get them back as one PDF.' : 'Each page becomes its own PDF, all in one ZIP.';
  });
  const go = runButton('Split PDF', out, async p => {
    const src = await input.get();
    const base = fileStem(src);
    if (mode === 'ranges') {
      const idx = parseRanges(ranges.value, src.pages);
      p.set(null, 'Building your PDF…'); await tick();
      const blob = await savePdf(await copyToNew(src.doc, idx));
      return resultCard({ title: 'Your new PDF', blob, filename: `${base}_split.pdf`, note: `Pages ${compactRanges(idx)} · ${pagesLabel(idx.length)}` });
    }
    if (src.pages < 2) throw new UserError('This PDF has only one page, so there’s nothing to split.', 'warn');
    const { zipSync } = await libs.fflate();
    const entries = {};
    const digits = Math.max(3, String(src.pages).length);
    for (let i = 0; i < src.pages; i++) {
      p.set(i / src.pages, `Page ${i + 1} of ${src.pages}`);
      const one = await copyToNew(src.doc, [i]);
      entries[`${base}_p${String(i + 1).padStart(digits, '0')}.pdf`] = [await pdfBytes(one), { level: 0 }];
      await tick();
      if (!root.isConnected) return null;
    }
    p.set(null, 'Packing the ZIP…'); await tick();
    const blob = new Blob([zipSync(entries)], { type: 'application/zip' });
    return resultCard({ title: 'Split into pages', blob, filename: `${base}_pages.zip`, note: `${plural(src.pages, 'PDF')} in one ZIP — one per page` });
  });
  root.append(
    card({ title: 'Your PDF' }, ...input.nodes),
    card({ title: 'How to split' }, modes, modeHint, rangeWrap),
    go, out);
}

// ── Compress ────────────────────────────────────────────────────────
const STRONG = { low: { dpi: 72, q: 0.5 }, medium: { dpi: 110, q: 0.6 }, high: { dpi: 150, q: 0.72 } };

function compressTool(root) {
  const out = h('div');
  let mode = 'smart', quality = 'medium';
  const input = pdfInput({ readOnly: 'This PDF has editing restrictions, so only Strong can compress it.', onReady: () => out.replaceChildren() });
  const smartHint = hintEl('Keeps text, links and bookmarks. Best for PDFs made by apps; scans barely shrink.');
  const strong = h('div', { class: 'stack hidden' },
    labelled('Quality', segmented([['low', 'Low'], ['medium', 'Medium'], ['high', 'High']], quality, v => { quality = v; out.replaceChildren(); }),
      hintEl('Low is smallest (≈72 dpi) · Medium ≈110 dpi · High is sharpest (≈150 dpi).')),
    notice('Pages are turned into pictures, so text won’t be selectable or searchable afterwards, and links stop working.', 'warn'));
  const modes = segmented([['smart', twoLine('Smart', 'keeps text')], ['strong', twoLine('Strong', 'best for scans')]], mode, v => {
    mode = v; out.replaceChildren();
    strong.classList.toggle('hidden', v !== 'strong');
    smartHint.classList.toggle('hidden', v !== 'smart');
  });

  const outcome = async (file, blob) => {
    const name = `${stem(file.name)}_compressed.pdf`;
    if (blob.size < file.size) return resultCard({ title: 'Compressed', blob, filename: name, before: file.size });
    const why = mode === 'smart'
      ? 'Smart mode couldn’t make this PDF any smaller — it’s already well packed. If it’s a scan, try Strong.'
      : quality === 'low'
        ? 'Even at Low quality this PDF doesn’t get smaller — it’s already compact.'
        : `At ${quality === 'high' ? 'High' : 'Medium'} quality this PDF doesn’t get smaller (it would be ${fmtBytes(blob.size)}). Try Low.`;
    return [notice(why, 'warn'),
      await resultCard({ title: 'Your original, unchanged', blob: file, filename: file.name, note: 'Still the smallest version you have.' })];
  };

  const go = runButton('Compress PDF', out, async p => {
    const src = await input.get();
    if (mode === 'smart') {
      if (src.restricted) throw src.restricted;
      p.set(null, 'Compressing…'); await tick();
      return outcome(src.file, await savePdf(await freshDoc(src)));
    }
    const { dpi, q } = STRONG[quality];
    const { pdf, task } = await openPdfjs(src.bytes);
    try {
      const doc = await newPdf();
      const n = pdf.numPages;
      for (let i = 1; i <= n; i++) {
        p.set((i - 1) / n, `Page ${i} of ${n}`);
        const { canvas, width, height } = await renderPage(pdf, i, dpi / 72, { maxPixels: 10e6 });
        let jpg;
        try { jpg = await canvasToBlob(canvas, 'image/jpeg', q); } finally { dropCanvas(canvas); }
        const img = await doc.embedJpg(new Uint8Array(await jpg.arrayBuffer()));
        doc.addPage([width, height]).drawImage(img, { x: 0, y: 0, width, height });
        await tick();
        if (!root.isConnected) return null;
      }
      p.set(null, 'Saving…'); await tick();
      return outcome(src.file, await savePdf(doc));
    } finally {
      await task.destroy();
    }
  });
  root.append(
    card({ title: 'Your PDF' }, ...input.nodes),
    card({ title: 'How hard to squeeze' }, modes, smartHint, strong),
    go, out);
}

// ── Images → PDF ────────────────────────────────────────────────────
function hasTransparency(canvas) {
  const { data } = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height);
  for (let i = 3; i < data.length; i += 4) if (data[i] < 255) return true;
  return false;
}

function imagesTool(root) {
  const out = h('div');
  let paper = 'fit', margin = 0;
  const list = fileList({
    accept: 'image/*', label: 'Choose photos', hint: 'JPG, PNG, WebP or screenshots — add more any time', icon: '🖼',
    thumbs: true, onChange: () => out.replaceChildren(),
  });
  const go = runButton('Make PDF', out, async p => {
    const files = list.files();
    if (!files.length) throw new UserError('Choose one or more photos first.', 'warn');
    const doc = await newPdf();
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      p.set(i / files.length, `Adding photo ${i + 1} of ${files.length}`);
      await tick();
      let img;
      try { img = await loadImage(f); }
      catch { throw new UserError(`Couldn’t read “${f.name}” — it may be HEIC or damaged. Remove it, or save it as JPG first (iPhone: Camera ▸ Formats ▸ Most Compatible).`, 'warn'); }
      const canvas = toCanvas(img, 3000);   // EXIF orientation already applied by loadImage
      if (img.src.startsWith('blob:')) URL.revokeObjectURL(img.src);
      const W = canvas.width, H = canvas.height;
      let bytes, png;
      try {
        png = /png|webp|gif|avif/i.test(f.type || '') && hasTransparency(canvas);
        const blob = await canvasToBlob(canvas, png ? 'image/png' : 'image/jpeg', 0.9);
        bytes = new Uint8Array(await blob.arrayBuffer());
      } finally { dropCanvas(canvas); }
      const pic = png ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
      const L = imagePageLayout(W, H, paper, margin);
      doc.addPage([L.pageW, L.pageH]).drawImage(pic, { x: L.x, y: L.y, width: L.w, height: L.h });
      if (!root.isConnected) return null;
    }
    p.set(null, 'Saving…'); await tick();
    const blob = await savePdf(doc);
    return resultCard({ title: 'PDF ready', blob, filename: `${stem(files[0].name)}_images.pdf`, note: pagesLabel(files.length) });
  });
  root.append(
    card({ title: 'Your photos', sub: 'One photo per page, in the order shown.' }, list.el),
    card({ title: 'Page setup' },
      labelled('Page size', segmented([['fit', 'Fit to image'], ['a4', 'A4'], ['letter', 'Letter']], paper, v => { paper = v; out.replaceChildren(); }),
        hintEl('A4 and Letter turn sideways automatically for landscape photos.')),
      labelled('Margin', segmented([[0, 'None'], [18, 'Small'], [36, 'Normal']], margin, v => { margin = v; out.replaceChildren(); }))),
    go, out);
}

// ── Rotate ──────────────────────────────────────────────────────────
const TURN_LABEL = { 90: '90° right', 180: '180°', 270: '90° left' };

function rotateTool(root) {
  const out = h('div');
  let which = 'all', turn = 90;
  const ranges = rangeInput({ label: 'Pages to rotate', summary: idx => `Rotates ${pagesLabel(uniqueSorted(idx).length)}` });
  const rangeWrap = h('div', { class: 'hidden' }, ranges.el);
  const input = pdfInput({ onReady: src => { out.replaceChildren(); ranges.setCount(src && src.pages); } });
  const go = runButton('Rotate pages', out, async p => {
    const src = await input.get();
    const idx = which === 'all' ? [...Array(src.pages).keys()] : uniqueSorted(parseRanges(ranges.value, src.pages));
    p.set(null, 'Rotating…'); await tick();
    const doc = await freshDoc(src);
    await rotatePages(doc, idx, turn);
    const blob = await savePdf(doc);
    const what = which === 'all' ? (src.pages === 1 ? 'The page' : `All ${src.pages} pages`) : `${idx.length === 1 ? 'Page' : 'Pages'} ${compactRanges(idx)}`;
    return resultCard({ title: 'Rotated', blob, filename: `${fileStem(src)}_rotated.pdf`, note: `${what} turned ${TURN_LABEL[turn]}` });
  });
  root.append(
    card({ title: 'Your PDF' }, ...input.nodes),
    card({ title: 'Rotate' },
      labelled('Which pages', segmented([['all', 'All pages'], ['some', 'Some pages']], which, v => {
        which = v; out.replaceChildren(); rangeWrap.classList.toggle('hidden', v !== 'some');
      })),
      rangeWrap,
      labelled('Direction', segmented([[90, '↻ 90° right'], [180, '180°'], [270, '↺ 90° left']], turn, v => { turn = v; out.replaceChildren(); }),
        hintEl('Adds to any rotation the pages already have.'))),
    go, out);
}

// ── Extract / Delete pages ──────────────────────────────────────────
function pagesTool(root, del) {
  const out = h('div');
  const ranges = rangeInput({
    label: del ? 'Pages to delete' : 'Pages to keep',
    summary: (idx, n) => {
      if (!del) return `Keeps ${pagesLabel(idx.length)} of ${n}, in this order`;
      const k = uniqueSorted(idx).length;
      return k >= n ? { err: 'That’s every page — keep at least one.' } : `Deletes ${pagesLabel(k)} · ${pagesLabel(n - k)} left`;
    },
  });
  const input = pdfInput({ onReady: src => { out.replaceChildren(); ranges.setCount(src && src.pages); } });
  const go = runButton(del ? 'Delete pages' : 'Extract pages', out, async p => {
    const src = await input.get();
    const idx = parseRanges(ranges.value, src.pages);
    let keep, note;
    if (del) {
      const gone = uniqueSorted(idx), drop = new Set(gone);
      keep = [...Array(src.pages).keys()].filter(i => !drop.has(i));
      if (!keep.length) throw new UserError('That would delete every page — keep at least one.', 'warn');
      note = `Removed ${gone.length === 1 ? 'page' : 'pages'} ${compactRanges(gone)} · ${pagesLabel(keep.length)} left`;
    } else {
      keep = idx;
      note = `${idx.length === 1 ? 'Page' : 'Pages'} ${compactRanges(idx)} · ${pagesLabel(idx.length)}`;
    }
    p.set(null, 'Building your PDF…'); await tick();
    const blob = await savePdf(await copyToNew(src.doc, keep));
    return resultCard({
      title: del ? 'Pages deleted' : 'Pages extracted', blob, note,
      filename: `${fileStem(src)}_${del ? 'pages_removed' : 'extracted'}.pdf`,
    });
  });
  root.append(
    card({ title: 'Your PDF' }, ...input.nodes),
    card({ title: del ? 'Which pages to remove' : 'Which pages to keep',
      sub: del ? null : 'They come out in the order you type — “3, 1, 2” puts page 3 first.' }, ranges.el),
    go, out);
}

// ── Page numbers ────────────────────────────────────────────────────
function numbersTool(root) {
  const out = h('div');
  let pos = 'bc', fmt = 'of', size = 11, pages = 0;
  const start = field({ label: 'Start at', value: '1', inputmode: 'numeric' });
  const sample = h('div', { class: 'faint small' });
  const startNum = () => {
    const t = start.value.trim();
    if (t === '') return 1;
    const n = Number(t);
    return Number.isInteger(n) && n >= 0 && n <= 99999 ? n : null;
  };
  const updateSample = () => {
    const s = startNum(), N = pages || 12;
    sample.textContent = s == null ? '' : `Looks like: “${pageNumberText(fmt, s, s + N - 1)}” … “${pageNumberText(fmt, s + N - 1, s + N - 1)}”`;
  };
  start.input.addEventListener('input', () => { out.replaceChildren(); updateSample(); });
  const input = pdfInput({ onReady: src => { out.replaceChildren(); pages = src ? src.pages : 0; updateSample(); } });
  const reset = () => { out.replaceChildren(); updateSample(); };
  const go = runButton('Add page numbers', out, async p => {
    const src = await input.get();
    const s = startNum();
    if (s == null) throw new UserError('“Start at” should be a whole number, like 1.', 'warn');
    const doc = await freshDoc(src);
    const n = src.pages;
    p.set(0, `Numbering ${pagesLabel(n)}…`); await tick();
    await addPageNumbers(doc, {
      pos, fmt, start: s, size,
      onPage: async (i) => { if (i % 20 === 19) { p.set((i + 1) / n, `Page ${i + 1} of ${n}`); await tick(); } },
    });
    p.set(null, 'Saving…'); await tick();
    const blob = await savePdf(doc);
    return resultCard({ title: 'Page numbers added', blob, filename: `${fileStem(src)}_numbered.pdf`,
      note: `“${pageNumberText(fmt, s, s + n - 1)}” to “${pageNumberText(fmt, s + n - 1, s + n - 1)}”` });
  });
  updateSample();
  root.append(
    card({ title: 'Your PDF' }, ...input.nodes),
    card({ title: 'Style' },
      labelled('Position', segmented([['bc', 'Bottom centre'], ['br', 'Bottom right'], ['tr', 'Top right']], pos, v => { pos = v; reset(); })),
      labelled('Format', segmented(NUMBER_FORMATS, fmt, v => { fmt = v; reset(); })),
      row(start.el, labelled('Text size', segmented([[9, 'S'], [11, 'M'], [14, 'L']], size, v => { size = v; reset(); }))),
      sample),
    go, out);
}

// ── Watermark ───────────────────────────────────────────────────────
/** Draw text onto a transparent PNG with the phone's own fonts (any script). Sizes are per 1 pt of font size. */
async function textPicture(text, colour) {
  const P = 200;
  const css = `700 ${P}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Noto Sans", "Noto Sans Devanagari", "Noto Sans Telugu", "Nirmala UI", sans-serif`;
  const [r, g, b] = (WATERMARK_COLOURS[colour] || WATERMARK_COLOURS.grey).map(v => Math.round(v * 255));
  const c = document.createElement('canvas');
  let ctx = c.getContext('2d');
  ctx.font = css;
  const m = ctx.measureText(text);
  const left = Math.max(0, m.actualBoundingBoxLeft || 0);
  const right = Math.max(m.actualBoundingBoxRight || 0, m.width);
  const asc = m.actualBoundingBoxAscent || P * 0.8, desc = m.actualBoundingBoxDescent || P * 0.25;
  const pad = P * 0.08;
  const w = left + right + 2 * pad, hh = asc + desc + 2 * pad;
  const s = Math.min(1, 4000 / w);
  c.width = Math.max(1, Math.round(w * s));
  c.height = Math.max(1, Math.round(hh * s));
  ctx = c.getContext('2d');
  ctx.scale(s, s);
  ctx.font = css;
  ctx.fillStyle = `rgb(${r},${g},${b})`;
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(text, pad + left, pad + asc);
  try {
    const blob = await canvasToBlob(c, 'image/png');
    return { bytes: new Uint8Array(await blob.arrayBuffer()), widthAt1: w / P, heightAt1: hh / P };
  } finally { dropCanvas(c); }
}

function watermarkTool(root) {
  const out = h('div');
  let layout = 'diagonal', size = 'm', opacity = 0.3, colour = 'grey';
  const text = field({ label: 'Watermark text', placeholder: 'e.g. CONFIDENTIAL', hint: 'Tip: on ID copies, say who it’s for — “For SBI KYC only”.' });
  text.input.maxLength = 80;
  text.input.addEventListener('input', () => out.replaceChildren());
  const input = pdfInput({ onReady: () => out.replaceChildren() });
  const pick = (opts, val, set) => segmented(opts, val, v => { set(v); out.replaceChildren(); });
  const go = runButton('Add watermark', out, async p => {
    const src = await input.get();
    const t = text.value.replace(/\s+/g, ' ').trim();
    if (!t) throw new UserError('Type the watermark text first.', 'warn');
    p.set(null, 'Stamping…'); await tick();
    const png = (await needsPicture(t)) ? await textPicture(t, colour) : null;
    const doc = await freshDoc(src);
    const n = src.pages;
    await addWatermark(doc, {
      text: t, layout, size, opacity, colour, png,
      onPage: async (i) => { if (i % 10 === 9) { p.set((i + 1) / n, `Page ${i + 1} of ${n}`); await tick(); } },
    });
    p.set(null, 'Saving…'); await tick();
    const blob = await savePdf(doc);
    return resultCard({ title: 'Watermark added', blob, filename: `${fileStem(src)}_watermarked.pdf`,
      note: `“${t}” on ${n === 1 ? 'the page' : `all ${pagesLabel(n)}`}` });
  });
  root.append(
    card({ title: 'Your PDF' }, ...input.nodes),
    card({ title: 'Watermark' },
      text.el,
      labelled('Layout', pick([['diagonal', 'Diagonal centre'], ['tiled', 'Tiled']], layout, v => { layout = v; })),
      labelled('Size', pick([['s', 'Small'], ['m', 'Medium'], ['l', 'Large']], size, v => { size = v; })),
      labelled('Strength', pick([[0.15, 'Light'], [0.3, 'Medium'], [0.5, 'Strong']], opacity, v => { opacity = v; })),
      labelled('Colour', pick([['grey', 'Grey'], ['red', 'Red'], ['blue', 'Blue']], colour, v => { colour = v; }))),
    go, out);
}

// ── PDF → Text ──────────────────────────────────────────────────────
const SHOW_MAX = 300000;   // characters shown on screen; the download always has everything

function textTool(root) {
  const out = h('div');
  const input = pdfInput({ engine: 'pdfjs', onReady: () => out.replaceChildren() });
  const go = runButton('Get text', out, async p => {
    const src = await input.get();
    const { pdf, task } = await openPdfjs(src.bytes);
    const parts = [];
    const n = pdf.numPages;
    try {
      for (let i = 1; i <= n; i++) {
        p.set((i - 1) / n, `Reading page ${i} of ${n}`);
        const page = await pdf.getPage(i);
        try { parts.push({ label: `Page ${i}`, text: textItemsToText((await page.getTextContent()).items) }); }
        finally { page.cleanup(); }
        await tick();
        if (!root.isConnected) return null;
      }
    } finally {
      await task.destroy();
    }
    const ink = parts.reduce((a, x) => a + inkChars(x.text), 0);
    const nodes = [];
    if (ink < 15 * n) {
      nodes.push(notice(h('span', {},
        ink ? 'Hardly any text was found' : 'No text was found', ' — this looks like a scanned PDF. Try ',
        h('a', { href: '#/tool/ocr' }, 'Scan → searchable text'), ' to read it.'), ink ? 'warn' : 'info'));
    }
    if (!ink) return nodes;
    const text = joinPages(parts);
    const blob = new Blob([text], { type: 'text/plain' });
    nodes.push(await resultCard({
      title: 'Text ready', blob, filename: `${fileStem(src)}_text.txt`, preview: 'none',
      note: `${pagesLabel(n)} · ${plural(parts.reduce((a, x) => a + wordCount(x.text), 0), 'word')}`,
    }));
    const long = text.length > SHOW_MAX;
    nodes.push(h('div', { class: 'stack', style: { marginTop: '12px' } },
      long && notice('This is a long text, so only the start is shown here. Download has all of it.', 'info'),
      outputBox(long ? text.slice(0, SHOW_MAX) + '\n…' : text)));
    return nodes;
  });
  root.append(card({ title: 'Your PDF' }, ...input.nodes), go, out);
}
