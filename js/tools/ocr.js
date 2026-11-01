// SnappTo — text recognition (OCR) with tesseract.js, on the phone.
// Tool ids: ocr (scanned PDFs or photos, many pages), imgocr (one photo),
//           imgocr_lang (one photo, Hindi / Telugu first).
import { h, card, button, busy, filePicker, notice, progress, resultCard, segmented, outputBox, stem, loadImage, toCanvas, tick } from '../ui.js';
import { ocrWorker, vendorUrl } from '../lib.js';
import * as store from '../store.js';
import { UserError, errorNotice, openPdfjs, renderPage, dropCanvas, joinPages, inkChars, wordCount, plural, pagesLabel } from './pdf-util.js';

const MODELS = { eng: { name: 'English', mb: 3 }, hin: { name: 'Hindi', mb: 1.4 }, tel: { name: 'Telugu', mb: 1.7 } };
const CHOICES = {
  ocr: [['eng', 'English'], ['hin', 'Hindi'], ['tel', 'Telugu'], ['eng+hin', 'English + Hindi']],
  imgocr: [['eng', 'English'], ['hin', 'Hindi'], ['tel', 'Telugu'], ['eng+hin', 'English + Hindi']],
  imgocr_lang: [['hin', 'Hindi'], ['tel', 'Telugu'], ['eng+hin', 'Hindi + English']],
};
const DEFAULT_LANG = { ocr: 'eng', imgocr: 'eng', imgocr_lang: 'hin' };

// Workers are cached by lib.js and keep the logger they were created with, so
// give them one stable relay and point it at whichever run is active.
let listener = null;
const relay = m => { try { if (listener) listener(m); } catch { /* never break the worker */ } };
const started = new Set();   // language sets with a live worker this session

export async function mount(root, toolId) {
  try {
    if (toolId === 'ocr') scanTool(root);
    else if (toolId === 'imgocr' || toolId === 'imgocr_lang') photoTool(root, toolId);
    else root.append(notice('This tool isn’t available here yet.', 'err'));
  } catch (e) { root.append(errorNotice(e)); }
}

// ── model availability ──────────────────────────────────────────────
const langNames = langs => langs.split('+').map(l => MODELS[l]?.name || l).join(' and ');

/** true / false if we can tell whether everything OCR needs is cached; null if we can't tell. */
async function modelsCached(langs) {
  if (started.has(langs)) return true;
  if (typeof caches === 'undefined') return null;
  try {
    const has = async p => !!(await caches.match(vendorUrl(p)));
    for (const l of langs.split('+')) if (!(await has(`tesseract/lang/${l}.traineddata.gz`))) return false;
    if (!(await has('tesseract/worker.min.js')) || !(await has('tesseract/tesseract.esm.min.js'))) return false;
    for (const v of ['relaxedsimd-lstm', 'simd-lstm', 'lstm']) if (await has(`tesseract/core/tesseract-core-${v}.wasm.js`)) return true;
    return false;
  } catch { return null; }
}

function modelHint(langs, cached) {
  if (cached) return '✓ Ready — works offline.';
  const parts = langs.split('+');
  const mb = parts.reduce((a, l) => a + (MODELS[l]?.mb || 0), 0);
  return `First use downloads the ${langNames(langs)} model${parts.length > 1 ? 's' : ''} (about ${+mb.toFixed(1)} MB). After that it works offline.`;
}

const offlineNotice = () => notice(h('span', {},
  'Text recognition isn’t downloaded yet — connect once, or download it in ',
  h('a', { href: '#/more' }, 'More ▸ Use offline'), '.'), 'warn');

/** Language segmented control + a hint that says what (if anything) will download. */
function languagePicker(toolId) {
  const opts = CHOICES[toolId] || CHOICES.ocr;
  const key = `ocr-lang:${toolId}`;
  let value = store.get(key, DEFAULT_LANG[toolId] || 'eng');
  if (!opts.some(o => o[0] === value)) value = opts[0][0];
  const hint = h('div');
  const seg = segmented(opts, value, v => { value = v; store.set(key, v); refresh(); });
  for (const b of seg.children) b.style.padding = '9px 6px';   // four languages fit at 375 px
  async function refresh() {
    const v = value;
    const cached = await modelsCached(v);
    if (v !== value) return;
    hint.replaceChildren(!cached && !navigator.onLine
      ? offlineNotice()
      : h('div', { class: 'faint small' }, modelHint(v, cached)));
  }
  const onNet = () => {
    if (!hint.isConnected) { removeEventListener('online', onNet); removeEventListener('offline', onNet); return; }
    refresh();
  };
  addEventListener('online', onNet);
  addEventListener('offline', onNet);
  refresh();
  return { nodes: [seg, hint], get value() { return value; }, refresh };
}

// ── recognition ─────────────────────────────────────────────────────
const isPdf = f => f.type === 'application/pdf' || /\.pdf$/i.test(f.name || '');

/** Photo → canvas sized for OCR: EXIF-upright, huge photos scaled down, tiny ones up. */
async function photoCanvas(f) {
  let img;
  try { img = await loadImage(f); }
  catch { throw new UserError(`Couldn’t read “${f.name}” — it may be HEIC or damaged. Try a JPG or PNG (iPhone: Camera ▸ Formats ▸ Most Compatible).`, 'warn'); }
  try {
    const w = img.naturalWidth || img.width, hh = img.naturalHeight || img.height;
    const long = Math.max(w, hh);
    if (long >= 1000) return toCanvas(img, 3000);
    const s = Math.min(2, 1600 / Math.max(long, 1));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w * s)); c.height = Math.max(1, Math.round(hh * s));
    const ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, c.width, c.height);
    return c;
  } finally {
    if (img.src.startsWith('blob:')) URL.revokeObjectURL(img.src);
  }
}

async function startWorker(langs, p) {
  const fresh = !started.has(langs);
  const cached = fresh ? await modelsCached(langs) : true;
  if (!navigator.onLine && cached === false) throw new UserError('offline', 'offline');
  listener = m => {
    const s = String(m && m.status || '');
    if (/language/i.test(s)) p.set(null, cached ? `Loading the ${langNames(langs)} model…` : `Downloading the ${langNames(langs)} model…`);
    else if (/core|initiali/i.test(s)) p.set(null, 'Starting text recognition…');
  };
  p.set(null, fresh ? 'Starting text recognition…' : 'Getting ready…');
  try {
    const w = await ocrWorker(langs, relay);
    started.add(langs);
    return w;
  } catch (e) {
    const msg = String((e && e.message) || e || '');
    if (!navigator.onLine || /network|fetch|load|import|failed/i.test(msg)) throw new UserError('offline', 'offline');
    throw new UserError('Text recognition couldn’t start on this device. Please try again — or use the Telegram bot.', 'other');
  }
}

/**
 * OCR every page of every file, in order. Returns {parts:[{label,text,conf}], total, done, stopped}.
 * ui: {p (progress), stopped(), alive()}
 */
async function recognise(files, langs, ui) {
  const { p } = ui;
  const many = files.length > 1;
  // 1. Count pages first so the progress bar is honest.
  p.set(null, 'Opening your files…');
  const plan = [];
  for (const f of files) {
    if (isPdf(f)) {
      const { pdf, task } = await openPdfjs(new Uint8Array(await f.arrayBuffer()), many ? f.name : undefined);
      plan.push({ f, pdf: true, pages: pdf.numPages });
      await task.destroy();
    } else plan.push({ f, pdf: false, pages: 1 });
  }
  const total = plan.reduce((a, x) => a + x.pages, 0);

  // 2. Recognise page by page.
  const worker = await startWorker(langs, p);
  const parts = [];
  let k = 0;
  const read = async (canvas, label) => {
    k++;
    const at = k;
    const say = frac => p.set((at - 1 + frac) / total,
      total > 1 ? `Page ${at} of ${total} · recognising ${Math.round(frac * 100)}%` : `Recognising ${Math.round(frac * 100)}%`);
    say(0);
    listener = m => { if (m && m.status === 'recognizing text') say(Math.max(0, Math.min(1, m.progress || 0))); };
    try {
      const { data } = await worker.recognize(canvas);
      parts.push({ label, text: String(data.text || '').trim(), conf: typeof data.confidence === 'number' ? data.confidence : null });
    } finally { dropCanvas(canvas); }
    await tick();
  };
  const halt = () => ui.stopped() || !ui.alive();

  for (const item of plan) {
    if (halt()) break;
    const name = item.f.name;
    if (!item.pdf) {
      p.set(k / total, total > 1 ? `Page ${k + 1} of ${total} · preparing` : 'Preparing the photo…');
      await read(await photoCanvas(item.f), many ? name : 'Page 1');
      continue;
    }
    const { pdf, task } = await openPdfjs(new Uint8Array(await item.f.arrayBuffer()), many ? name : undefined);
    try {
      for (let i = 1; i <= item.pages && !halt(); i++) {
        p.set(k / total, total > 1 ? `Page ${k + 1} of ${total} · preparing` : 'Preparing the page…');
        const { canvas } = await renderPage(pdf, i, 2, { maxPixels: 8e6 });
        await read(canvas, many ? `${name} · page ${i}` : `Page ${i}`);
      }
    } finally { await task.destroy(); }
  }
  return { parts, total, done: k, stopped: k < total };
}

/** The shared run: progress + Stop, then the text with Copy, Download .txt and Share. */
async function run({ root, out, files, langs, base }) {
  out.replaceChildren();
  if (!files.length) { out.append(notice('Choose a file first.', 'warn')); return; }
  const p = progress('Getting ready…');
  let stop = false;
  const stopBtn = button('Stop', () => { stop = true; stopBtn.disabled = true; p.set(null, 'Stopping after this page…'); }, { variant: 'ghost', small: true });
  const live = h('div', { class: 'stack' }, p.el, h('div', { style: { display: 'flex', justifyContent: 'flex-end' } }, stopBtn));
  out.append(live);
  let res;
  try {
    res = await recognise(files, langs, { p, stopped: () => stop, alive: () => root.isConnected });
  } catch (e) {
    live.remove();
    out.append(e && e.kind === 'offline' ? offlineNotice() : errorNotice(e));
    return;
  } finally { listener = null; }
  live.remove();
  if (!root.isConnected) return;

  const { parts, total, done } = res;
  const nodes = [];
  if (res.stopped) nodes.push(notice(`Stopped after ${done} of ${pagesLabel(total)}.`, 'info'));
  const ink = parts.reduce((a, x) => a + inkChars(x.text), 0);
  if (!ink) {
    if (done) nodes.push(notice(`No text found. Try a sharper, well-lit, straight-on photo${langs.includes('+') ? '' : ', or check the language'}.`, 'warn'));
    out.append(...nodes);
    return;
  }
  const confs = parts.map(x => x.conf).filter(c => c != null && c > 0);
  const avg = confs.length ? confs.reduce((a, c) => a + c, 0) / confs.length : 100;
  if (avg < 55) nodes.push(notice('Some words may be wrong — the image looks blurry or faint, or the language may not match.', 'warn'));

  const text = joinPages(parts, '(no text found on this page)');
  const words = parts.reduce((a, x) => a + wordCount(x.text), 0);
  nodes.push(await resultCard({
    title: 'Text ready', blob: new Blob([text], { type: 'text/plain' }), filename: `${base}_text.txt`, preview: 'none',
    note: `${done > 1 ? `${pagesLabel(done)} · ` : ''}${plural(words, 'word')}`,
  }));
  nodes.push(h('div', { style: { marginTop: '12px' } }, outputBox(text)));
  out.append(...nodes);
  requestAnimationFrame(() => {
    const top = out.getBoundingClientRect().top;
    if (top > innerHeight - 160) scrollBy({ top: top - innerHeight * 0.3, behavior: 'smooth' });
  });
}

// ── Scan → searchable text (PDFs and photos, many pages) ────────────
function scanTool(root) {
  const out = h('div');
  let files = [];
  const picker = filePicker({
    accept: 'application/pdf,.pdf,image/*', multiple: true, icon: '📄',
    label: 'Choose scanned PDFs or photos', hint: 'Read in the order shown — add more any time',
    onFiles: f => { files = f; out.replaceChildren(); },
  });
  const lang = languagePicker('ocr');
  const go = button('Read text', () => busy(go, () =>
    run({ root, out, files, langs: lang.value, base: files[0] ? stem(files[0].name) : 'scan' })), { full: true });
  root.append(
    card({ title: 'Your scan' }, picker),
    card({ title: 'Language of the text' }, ...lang.nodes),
    go, out);
}

// ── Text from one photo (or the camera) ─────────────────────────────
function photoTool(root, toolId) {
  const out = h('div');
  let file = null;
  const preview = h('div', { class: 'hidden', style: { textAlign: 'center' } });
  const setFile = (f, caption) => {
    file = f || null;
    out.replaceChildren();
    preview.replaceChildren();
    preview.classList.toggle('hidden', !file);
    if (!file) return;
    const url = URL.createObjectURL(file);
    const img = h('img', { src: url, alt: 'Your photo', style: { maxHeight: '240px', width: 'auto', margin: '0 auto', borderRadius: '12px' } });
    img.addEventListener('load', () => URL.revokeObjectURL(url), { once: true });
    img.addEventListener('error', () => { URL.revokeObjectURL(url); img.remove(); }, { once: true });
    preview.append(img);
    if (caption) preview.append(h('div', { class: 'faint small', style: { marginTop: '6px' } }, caption));
  };
  const picker = filePicker({
    accept: 'image/*', icon: '🖼', label: 'Choose a photo', hint: 'Flat, sharp and well lit works best',
    onFiles: f => setFile(f[0]),
  });
  const cam = h('input', { type: 'file', accept: 'image/*', capture: 'environment', class: 'hidden' });
  cam.addEventListener('change', () => {
    const f = cam.files && cam.files[0];
    cam.value = '';
    if (f) { picker.reset(); setFile(f, 'Camera photo'); }
  });
  const touch = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  const camBtn = touch && button('Take a photo', () => cam.click(), { variant: 'secondary', full: true, icon: '📷' });

  const lang = languagePicker(toolId);
  const go = button('Read text', () => busy(go, () =>
    run({ root, out, files: file ? [file] : [], langs: lang.value, base: file ? stem(file.name) : 'photo' })), { full: true });
  root.append(
    card({ title: 'Your photo' }, picker, camBtn, cam, preview),
    card({ title: 'Language of the text' }, ...lang.nodes),
    go, out);
}
