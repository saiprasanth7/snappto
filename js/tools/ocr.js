// SnappTo — text recognition (OCR) with tesseract.js, on the phone.
// Tool ids: ocr (scanned PDFs or photos, many pages), imgocr (one photo),
//           imgocr_lang (one photo, Hindi / Telugu first).
import { h, card, button, busy, filePicker, notice, progress, resultCard, segmented, outputBox, stem, loadImage, toCanvas, tick } from '../ui.js';
import { ocrWorker, ocrFiles, releaseOcr, vendorUrl } from '../lib.js';
import * as store from '../store.js';
import { UserError, friendlyError, errorNotice, messageFor, openPdfjs, renderPage, dropCanvas, joinPages, inkChars, wordCount, plural, pagesLabel } from './pdf-util.js';

const MODELS = { eng: { name: 'English', mb: 3 }, hin: { name: 'Hindi', mb: 1.4 }, tel: { name: 'Telugu', mb: 1.7 } };
const CHOICES = {
  ocr: [['eng', 'English'], ['hin', 'Hindi'], ['tel', 'Telugu'], ['eng+hin', 'English + Hindi']],
  imgocr: [['eng', 'English'], ['hin', 'Hindi'], ['tel', 'Telugu'], ['eng+hin', 'English + Hindi']],
  imgocr_lang: [['hin', 'Hindi'], ['tel', 'Telugu'], ['eng+hin', 'Hindi + English']],
};
const DEFAULT_LANG = { ocr: 'eng', imgocr: 'eng', imgocr_lang: 'hin' };

// Workers are cached by lib.js and keep the logger they were created with, so
// give them one stable relay and point it at whichever run is active.
let listener = null, owner = null;
const relay = m => { try { if (listener) listener(m); } catch { /* never break the worker */ } };
const started = new Set();   // language sets that started fine this session (their files are on the phone)
let active = 0;              // runs in progress, across tool pages

export async function mount(root, toolId) {
  releaseOnLeave(root);
  try {
    if (toolId === 'ocr') scanTool(root);
    else if (toolId === 'imgocr' || toolId === 'imgocr_lang') photoTool(root, toolId);
    else root.append(notice('This tool isn’t available here yet.', 'err'));
  } catch (e) { root.append(errorNotice(e)); }
}

/** Leaving the tool gives the worker's memory (100+ MB) back; the next run starts it again from the phone. */
function releaseOnLeave(root) {
  const view = root.parentNode;
  if (!view || typeof MutationObserver !== 'function') return;
  const watch = new MutationObserver(() => {
    if (root.isConnected) return;
    watch.disconnect();
    if (!active) releaseOcr();   // a run still going does it when it ends (see run)
  });
  watch.observe(view, { childList: true });
}

// ── model availability ──────────────────────────────────────────────
const langNames = langs => langs.split('+').map(l => MODELS[l]?.name || l).join(' and ');

/** The files OCR still needs for langs: [] when all are on the phone, null if we can't tell. */
async function missingFiles(langs) {
  if (typeof caches === 'undefined') return null;
  try {
    const out = [];
    for (const f of ocrFiles(langs)) if (!(await caches.match(vendorUrl(f)))) out.push(f);
    return out;
  } catch { return null; }
}

/** true / false if we can tell whether everything OCR needs is cached; null if we can't tell. */
async function modelsCached(langs) {
  if (started.has(langs)) return true;
  const missing = await missingFiles(langs);
  return missing && !missing.length;
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

const STALL_MS = 20000;   // a download that gets no data for this long has failed
const stoppedError = () => new UserError('Stopped.', 'stopped');

/** Settle like job, or reject as soon as Stop is pressed. */
function orStop(job, signal) {
  if (signal.aborted) return Promise.reject(stoppedError());
  return new Promise((res, rej) => {
    const onStop = () => rej(stoppedError());
    signal.addEventListener('abort', onStop, { once: true });
    job.then(res, rej).finally(() => signal.removeEventListener('abort', onStop));
  });
}

/**
 * Fetch one file OCR needs (the service worker keeps a copy), so a failed or stalled
 * download ends here with a clear message instead of inside tesseract.js, which never
 * reports it. onFrac(0..1) follows the download.
 */
async function download(path, signal, onFrac) {
  const ctl = new AbortController();
  const abort = () => ctl.abort();
  let timer;
  const wait = () => { clearTimeout(timer); timer = setTimeout(abort, STALL_MS); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    wait();
    const res = await fetch(vendorUrl(path), { signal: ctl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const total = Number(res.headers.get('content-length')) || 0;
    const head = [];
    let got = 0;
    const take = chunk => {
      wait();
      for (let i = 0; head.length < 2 && i < chunk.length; i++) head.push(chunk[i]);
      got += chunk.length;
      if (total) onFrac(Math.min(1, got / total));
    };
    if (res.body && res.body.getReader) {
      const reader = res.body.getReader();
      for (let r; !(r = await reader.read()).done;) take(r.value);
    } else take(new Uint8Array(await res.arrayBuffer()));
    // A captive portal answers with a web page; a model file is gzip.
    if (path.endsWith('.gz') && (head[0] !== 0x1f || head[1] !== 0x8b)) throw new Error('Not a model file');
  } catch {
    throw signal.aborted ? stoppedError() : new UserError('offline', 'offline');
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
  }
}

async function startWorker(langs, ui) {
  const { p, signal } = ui;
  // All tool pages share one worker. A run whose page was left must not take it from the
  // page on screen (asking for another language would stop that one's worker starting).
  const gone = () => signal.aborted || !ui.alive();
  if (gone()) throw stoppedError();
  const fresh = !started.has(langs);
  const missing = fresh ? await missingFiles(langs) : [];
  if (!navigator.onLine && missing && missing.length) throw new UserError('offline', 'offline');
  p.set(null, fresh ? 'Starting text recognition…' : 'Getting ready…');
  for (let i = 0; missing && i < missing.length; i++) {
    if (gone()) throw stoppedError();
    const label = /\/lang\//.test(missing[i]) ? `Downloading the ${langNames(langs)} model…` : 'Downloading text recognition…';
    p.set(i / missing.length, label);
    await download(missing[i], signal, f => p.set((i + f) / missing.length, label));
  }
  if (gone()) throw stoppedError();
  ui.listen(m => {   // after the downloads above, everything comes from the phone
    const s = String(m && m.status || '');
    if (/language/i.test(s)) p.set(null, missing ? `Loading the ${langNames(langs)} model…` : `Downloading the ${langNames(langs)} model…`);
    else if (/core|initiali/i.test(s)) p.set(null, 'Starting text recognition…');
  });
  const start = () => orStop(ocrWorker(langs, relay), signal);
  try {
    // Another run asked for a different language while this one started. This page is
    // still open, so it asks once more rather than reporting a failure.
    const w = await start().catch(e => (e && e.name === 'AbortError' && !gone() ? start() : Promise.reject(e)));
    started.add(langs);
    return w;
  } catch (e) {
    if (e instanceof UserError) {
      if (e.kind === 'stopped') releaseOcr();   // don't leave a half-started worker behind
      throw e;
    }
    if (e && e.name === 'AbortError' && gone()) throw stoppedError();   // the worker is the open page's now
    const msg = String((e && e.message) || e || '');
    if (!navigator.onLine || /network|fetch|load|import|failed/i.test(msg)) throw new UserError('offline', 'offline');
    throw new UserError('Text recognition couldn’t start on this device. Close other apps and tabs, then try again.', 'other');
  }
}

/**
 * OCR every page of every file, in order. Returns {parts:[{label,text,conf,failed?}], total, done, stopped, cut}.
 * A photo, file or page that can't be prepared is skipped (failed = its UserError) and the
 * rest carry on; cut is set when reading had to end early (out of memory, a browser too old,
 * or the reader itself failed), keeping what was read before.
 * ui: {p (progress), stopped(), alive(), signal (Stop), listen(fn) (worker progress)}
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
  const worker = await startWorker(langs, ui);
  const parts = [];
  let k = 0, cut = null;
  const read = async (canvas, label) => {
    k++;
    const at = k;
    const say = frac => p.set((at - 1 + frac) / total,
      total > 1 ? `Page ${at} of ${total} · recognising ${Math.round(frac * 100)}%` : `Recognising ${Math.round(frac * 100)}%`);
    say(0);
    ui.listen(m => { if (m && m.status === 'recognizing text') say(Math.max(0, Math.min(1, m.progress || 0))); });
    try {
      const { data } = await worker.recognize(canvas);
      parts.push({ label, text: String(data.text || '').trim(), conf: typeof data.confidence === 'number' ? data.confidence : null });
    } finally { dropCanvas(canvas); }
    await tick();
  };
  const skip = (label, e, pages = 1) => {
    const u = friendlyError(e, label);
    parts.push({ label, text: '', conf: null, failed: u });
    k += pages;
    if (u.kind === 'memory' || u.kind === 'browser') cut = u;   // every later page would fail the same way
  };
  const halt = () => cut || ui.stopped() || !ui.alive();

  try {
    for (const item of plan) {
      if (halt()) break;
      const name = item.f.name;
      if (!item.pdf) {
        const label = many ? name : 'Page 1';
        p.set(k / total, total > 1 ? `Page ${k + 1} of ${total} · preparing` : 'Preparing the photo…');
        let canvas;
        try { canvas = await photoCanvas(item.f); } catch (e) { skip(label, e); continue; }
        await read(canvas, label);
        continue;
      }
      let doc;
      try { doc = await openPdfjs(new Uint8Array(await item.f.arrayBuffer()), name); }
      catch (e) { skip(name, e, item.pages); continue; }
      try {
        for (let i = 1; i <= item.pages && !halt(); i++) {
          const label = many ? `${name} · page ${i}` : `Page ${i}`;
          p.set(k / total, total > 1 ? `Page ${k + 1} of ${total} · preparing` : 'Preparing the page…');
          let canvas;
          try { ({ canvas } = await renderPage(doc.pdf, i, 2, { maxPixels: 8e6 })); } catch (e) { skip(label, e); continue; }
          await read(canvas, label);
        }
      } finally { await doc.task.destroy(); }
    }
  } catch (e) {
    // The reader itself failed (often memory): keep the pages it already read.
    if (!parts.some(x => !x.failed)) throw e;
    cut = friendlyError(e);
  }
  return { parts, total, done: k, stopped: !cut && k < total, cut };
}

/** One warning naming what was skipped and why. */
function skippedNotice(failed) {
  const what = failed.length === 1 ? failed[0].label : `${plural(failed.length, 'page')} (${failed.map(x => x.label).join(', ')})`;
  const why = [...new Set(failed.map(x => messageFor(x.failed, { bot: false })))].slice(0, 2).join(' ');
  return notice(`Skipped ${what}. ${why}`, 'warn');
}

/** The shared run: progress + Stop, then the text with Copy, Download .txt and Share. */
async function run({ root, out, files, langs, base }) {
  out.replaceChildren();
  if (!files.length) { out.append(notice('Choose a file first.', 'warn')); return; }
  const p = progress('Getting ready…');
  const stop = new AbortController();
  const stopBtn = button('Stop', () => { stop.abort(); stopBtn.disabled = true; p.set(null, 'Stopping after this page…'); }, { variant: 'ghost', small: true });
  const live = h('div', { class: 'stack' }, p.el, h('div', { style: { display: 'flex', justifyContent: 'flex-end' } }, stopBtn));
  out.append(live);
  // Only the newest run drives the shared progress relay; an older one finishing can't blank it.
  const me = {};
  owner = me;
  active++;
  let res;
  try {
    res = await recognise(files, langs, {
      p, signal: stop.signal, stopped: () => stop.signal.aborted, alive: () => root.isConnected,
      listen: fn => { if (owner === me) listener = fn; },
    });
  } catch (e) {
    live.remove();
    out.append(e && e.kind === 'offline' ? offlineNotice()
      : e && e.kind === 'stopped' ? notice('Stopped before any text was read.', 'info')
        : errorNotice(e, undefined, { bot: false }));
    return;
  } finally {
    active--;
    if (owner === me) { owner = null; listener = null; }
    // Left the tool mid-run: give the worker's memory back unless another run needs it.
    if (!root.isConnected && !active) releaseOcr();
  }
  live.remove();
  if (!root.isConnected) return;

  const { parts, total, done, cut } = res;
  const read = parts.filter(x => !x.failed), skipped = parts.filter(x => x.failed && x.failed !== cut);
  if (!read.length && parts.length === 1) { out.append(errorNotice(parts[0].failed, undefined, { bot: false })); return; }
  const nodes = [];
  if (res.stopped) nodes.push(notice(`Stopped after ${done} of ${pagesLabel(total)}.`, 'info'));
  if (cut) nodes.push(notice(`Stopped after ${read.length} of ${pagesLabel(total)}. ${messageFor(cut, { bot: false })}`, 'warn'));
  if (skipped.length) nodes.push(skippedNotice(skipped));
  const ink = read.reduce((a, x) => a + inkChars(x.text), 0);
  if (!ink) {
    if (read.length) nodes.push(notice(`No text found. Try a sharper, well-lit, straight-on photo${langs.includes('+') ? '' : ', or check the language'}.`, 'warn'));
    out.append(...nodes);
    return;
  }
  const confs = read.map(x => x.conf).filter(c => c != null && c > 0);
  const avg = confs.length ? confs.reduce((a, c) => a + c, 0) / confs.length : 100;
  if (avg < 55) nodes.push(notice('Some words may be wrong — the image looks blurry or faint, or the language may not match.', 'warn'));

  // A skipped page keeps its place in the text, marked so it isn't mistaken for a blank one.
  const text = joinPages(parts.map(x => (x.failed ? { ...x, text: '(couldn’t read this page)' } : x)), '(no text found on this page)');
  const words = read.reduce((a, x) => a + wordCount(x.text), 0);
  nodes.push(await resultCard({
    title: 'Text ready', blob: new Blob([text], { type: 'text/plain' }), filename: `${base}_text.txt`, preview: 'none',
    note: `${read.length > 1 ? `${pagesLabel(read.length)} · ` : ''}${plural(words, 'word')}`,
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
