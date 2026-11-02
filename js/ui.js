// SnappTo UI kit — the ONLY building blocks tool modules should use, so every
// screen looks and behaves the same. All helpers return plain DOM nodes.

/** h('div', {class:'x', onclick:fn, style:{...}, dataset:{...}}, ...children) */
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  if (props && (typeof props !== 'object' || props instanceof Node || Array.isArray(props))) {
    children.unshift(props); props = {};
  }
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  append(el, children);
  return el;
}
function append(el, kids) {
  for (const c of kids.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}
export const $ = (sel, root = document) => root.querySelector(sel);

/** A white rounded card. card({title, sub}, ...children) or card(...children) */
export function card(opts, ...children) {
  if (opts instanceof Node || typeof opts === 'string' || Array.isArray(opts)) { children.unshift(opts); opts = {}; }
  opts = opts || {};
  return h('section', { class: 'card' },
    opts.title && h('h3', { class: 'card-title' }, opts.title),
    opts.sub && h('p', { class: 'card-sub' }, opts.sub),
    h('div', { class: 'stack' }, ...children));
}

export function button(label, onClick, { variant = 'primary', disabled = false, full = false, small = false, icon } = {}) {
  const b = h('button', {
    type: 'button',
    class: `btn btn-${variant}${full ? ' btn-full' : ''}${small ? ' btn-sm' : ''}`,
    disabled, onclick: onClick,
  }, icon && h('span', {}, icon), h('span', { class: 'lbl' }, label));
  return b;
}

/** Run an async fn while showing a spinner on the button; re-enables after. */
export async function busy(btn, fn) {
  const lbl = btn.querySelector('.lbl'); const old = lbl ? lbl.textContent : '';
  btn.disabled = true;
  const sp = h('span', { class: 'spin' }); btn.prepend(sp);
  try { return await fn(); }
  finally { sp.remove(); btn.disabled = false; if (lbl) lbl.textContent = old; }
}

let _fid = 0;
/** Text / number / select / textarea field. Returns {el, input, value}. */
export function field({ label, type = 'text', value = '', placeholder = '', hint, options, rows, min, max, step, inputmode, autocomplete = 'off' } = {}) {
  const id = 'f' + (++_fid);
  let input;
  if (options) {
    input = h('select', { id });
    for (const o of options) {
      const [val, txt] = Array.isArray(o) ? o : [o, o];
      input.append(h('option', { value: val }, txt));
    }
    input.value = value;
  } else if (type === 'textarea') {
    input = h('textarea', { id, placeholder, rows: rows || 5, spellcheck: 'false' });
    input.value = value;
  } else {
    input = h('input', { id, type, placeholder, min, max, step, inputmode, autocomplete, spellcheck: 'false' });
    input.value = value;
  }
  const el = h('div', { class: 'field' }, label && h('label', { for: id }, label), input, hint && h('div', { class: 'hint' }, hint));
  return { el, input, get value() { return input.value; }, set value(v) { input.value = v; } };
}

export function row(...children) { return h('div', { class: 'row' }, ...children); }

/** Pill switcher. options: [[value,label],...]. */
export function segmented(options, value, onChange) {
  const wrap = h('div', { class: 'seg', role: 'tablist' });
  const set = v => { value = v; for (const b of wrap.children) b.classList.toggle('on', b.dataset.v === String(v)); };
  for (const o of options) {
    const [v, t] = Array.isArray(o) ? o : [o, o];
    wrap.append(h('button', { type: 'button', dataset: { v }, onclick: () => { set(v); onChange && onChange(v); } }, t));
  }
  set(value);
  wrap.setValue = set;
  return wrap;
}

/**
 * File picker + drop zone (tap, drag-drop, or paste). Calls onFiles(File[]).
 * Shows the chosen files with sizes; `multiple` keeps an ordered list you can remove from.
 */
export function filePicker({ accept = '*/*', multiple = false, label = 'Choose a file', hint = '', icon = '📎', capture, onFiles } = {}) {
  const input = h('input', { type: 'file', accept, class: 'hidden', multiple: multiple || null, capture: capture || null });
  let files = [];
  const list = h('div', { class: 'files' });
  const zone = h('div', { class: 'drop', role: 'button', tabindex: '0' },
    h('div', { class: 'big' }, icon), h('div', { class: 'lbl' }, label), hint && h('div', { class: 'hint' }, hint));
  const emit = () => { renderList(); onFiles && onFiles(files.slice()); };
  const renderList = () => {
    list.replaceChildren(...files.map((f, i) => h('div', { class: 'file' },
      h('span', {}, iconFor(f)), h('span', { class: 'n' }, f.name), h('span', { class: 's' }, fmtBytes(f.size)),
      h('button', { type: 'button', 'aria-label': 'Remove', onclick: e => { e.stopPropagation(); files.splice(i, 1); emit(); } }, '×'))));
  };
  const add = fl => {
    const arr = [...fl].filter(f => accept === '*/*' || matchesAccept(f, accept));
    if (!arr.length) { toast('That file type isn’t supported here', 'err'); return; }
    files = multiple ? files.concat(arr) : arr.slice(0, 1);
    emit();
  };
  zone.addEventListener('click', () => input.click());
  zone.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') input.click(); });
  input.addEventListener('change', () => { if (input.files.length) add(input.files); input.value = ''; });
  zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('over'));
  zone.addEventListener('drop', e => { e.preventDefault(); zone.classList.remove('over'); add(e.dataTransfer.files); });
  const el = h('div', {}, zone, input, list);
  el.reset = () => { files = []; renderList(); };
  el.getFiles = () => files.slice();
  return el;
}
function matchesAccept(f, accept) {
  return accept.split(',').map(s => s.trim().toLowerCase()).some(a =>
    a.startsWith('.') ? f.name.toLowerCase().endsWith(a)
      : a.endsWith('/*') ? (f.type || '').startsWith(a.slice(0, -1))
      : (f.type || '') === a);
}
function iconFor(f) {
  const t = f.type || '';
  if (t.startsWith('image/')) return '🖼';
  if (t === 'application/pdf' || /\.pdf$/i.test(f.name)) return '📄';
  if (t.startsWith('audio/')) return '🎵';
  if (t.startsWith('video/')) return '🎬';
  if (/zip/.test(t) || /\.zip$/i.test(f.name)) return '🗜';
  return '📎';
}

/** Inline message box. kind: info | ok | warn | err */
export function notice(content, kind = 'info') {
  const icon = { info: 'ℹ️', ok: '✅', warn: '⚠️', err: '⛔' }[kind] || 'ℹ️';
  return h('div', { class: `notice ${kind}` }, h('span', { class: 'ni' }, icon), h('div', {}, content));
}

/** Progress bar. set(fraction 0..1 or null for indeterminate, label). */
export function progress(label = 'Working…') {
  const fill = h('div', { class: 'fill' });
  // Only the stage label is live, so screen readers hear "Reading page 3" but not
  // every percent tick; the bar's value is there when they ask for it.
  const pct = h('span', { class: 'faint', 'aria-hidden': 'true' });
  const lab = h('span', { role: 'status' }, label);
  const bar = h('div', { class: 'bar', role: 'progressbar', 'aria-label': label }, fill);
  const el = h('div', { class: 'prog indet' }, h('div', { class: 'pl' }, lab, pct), bar);
  return {
    el,
    set(frac, text) {
      if (text && text !== lab.textContent) { lab.textContent = text; bar.setAttribute('aria-label', text); }
      if (frac == null) { el.classList.add('indet'); pct.textContent = ''; fill.style.width = ''; bar.removeAttribute('aria-valuenow'); }
      else {
        el.classList.remove('indet'); const p = Math.max(0, Math.min(1, frac));
        fill.style.width = (p * 100).toFixed(1) + '%'; pct.textContent = Math.round(p * 100) + '%'; bar.setAttribute('aria-valuenow', Math.round(p * 100));
      }
    },
    done() { el.remove(); },
    fail(msg) { el.replaceWith(notice(msg, 'err')); announce(typeof msg === 'string' ? msg : msg?.textContent); },
  };
}

// A preview URL pins its whole blob in memory until it's revoked. The shell frees
// every preview when you leave a page (releasePreviews), a preview that can never be
// shown again frees itself once the browser collects it, and a tool can free one
// early with card.dispose() or by passing its UrlBag as `bag`.
const previewUrls = new Set();
const previewGone = typeof FinalizationRegistry === 'function'
  ? new FinalizationRegistry(url => { URL.revokeObjectURL(url); previewUrls.delete(url); }) : null;
export function releasePreviews() {
  for (const u of previewUrls) URL.revokeObjectURL(u);
  previewUrls.clear();
}

/**
 * The standard "here's your file" card: preview, size change, Download + Share.
 * resultCard({title, blob, filename, before, after, note, preview:'auto'|'image'|'none', bag})
 * `bag` (optional, a UrlBag) also revokes the preview when the bag is cleared.
 */
export async function resultCard({ title = 'Done', blob, filename = 'output', before, after, note, preview = 'auto', bag } = {}) {
  const size = after ?? blob?.size;
  const isImg = blob && /^image\//.test(blob.type);
  const box = h('div', { class: 'result' });
  box.dispose = () => {};
  if (blob && (preview === 'image' || (preview === 'auto' && isImg))) {
    const url = bag ? bag.add(blob) : URL.createObjectURL(blob);
    const img = h('img', { src: url, alt: 'Result preview' });
    previewUrls.add(url);
    previewGone?.register(img, url);
    box.dispose = () => { URL.revokeObjectURL(url); previewUrls.delete(url); };
    const rp = h('div', { class: 'rp' + (blob.type === 'image/png' || blob.type === 'image/webp' ? ' checker' : '') }, img);
    box.append(rp);
  }
  const deltaEl = (before && size != null) ? (() => {
    const pct = Math.round((1 - size / before) * 100);
    const shrink = size < before;
    return h('div', { class: 'delta' + (shrink ? '' : ' up') },
      `${fmtBytes(before)} → ${fmtBytes(size)}  (${shrink ? '−' : '+'}${Math.abs(pct)}%)`);
  })() : null;
  box.append(h('div', { class: 'rb' },
    h('div', { class: 'rt' }, '✅', title),
    h('div', { class: 'meta' }, [filename, size != null ? fmtBytes(size) : null].filter(Boolean).join(' · ')),
    deltaEl,
    note && h('div', { class: 'meta', style: { marginTop: '8px' } }, note),
    blob && h('div', { class: 'acts' },
      button('Download', () => download(blob, filename), { variant: 'primary' }),
      canShareFiles() && button('Share', () => share(blob, filename), { variant: 'secondary' }))));
  announce(title);
  return box;
}

export function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

export function canShareFiles() {
  try { return !!(navigator.canShare && navigator.canShare({ files: [new File([''], 'x.txt', { type: 'text/plain' })] })); }
  catch { return false; }
}

/** Native share sheet (iOS/Android "Save to Files", WhatsApp, etc.); falls back to download. */
export async function share(blob, filename, title = filename) {
  const file = new File([blob], filename, { type: blob.type || 'application/octet-stream' });
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title }); return; }
  } catch (e) { if (e && e.name === 'AbortError') return; }
  download(blob, filename);
}

// Live regions are made when the app starts, not with their first message: TalkBack with
// Chrome and NVDA often skip text that arrives together with its region.
let srHost, toastHost;
function liveRegions() {
  if (srHost) return;
  srHost = h('div', { class: 'sr-only', role: 'status', 'aria-live': 'polite' });
  toastHost = h('div', { class: 'toasts', 'aria-live': 'polite' });
  document.body.append(srHost, toastHost);
}
if (typeof document !== 'undefined' && document.body) liveRegions();

/** Tell screen readers about a change without showing anything, e.g. announce('3 results'). */
export function announce(msg) {
  if (!msg) return;
  liveRegions();
  if ([...srHost.children].some(c => c.textContent === msg)) return;   // a batch of "Done" cards says it once
  const m = h('div', {}, msg);
  srHost.append(m);
  setTimeout(() => m.remove(), 4000);
}

export function toast(msg, kind = '') {
  liveRegions();
  const t = h('div', { class: `toast ${kind}` }, msg);
  toastHost.append(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; setTimeout(() => t.remove(), 320); }, 2600);
}

export function fmtBytes(n) {
  if (n == null || isNaN(n)) return '';
  if (n < 1024) return n + ' B';
  const u = ['KB', 'MB', 'GB']; let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return (n >= 100 ? n.toFixed(0) : n >= 10 ? n.toFixed(1) : n.toFixed(2)).replace(/\.0+$/, '') + ' ' + u[i];
}

/** Read-only text output with a Copy button. */
export function outputBox(text = '', { mono = false } = {}) {
  const out = h('div', { class: 'out' + (mono ? ' mono' : '') }, text);
  const c = copyButton(() => out.textContent);
  c.classList.add('copy');
  const wrap = h('div', { class: 'out-wrap' }, out, c);
  wrap.set = t => { out.textContent = t; };
  return wrap;
}

export function copyButton(textOrFn, label = 'Copy') {
  const b = button(label, async () => {
    const t = typeof textOrFn === 'function' ? textOrFn() : textOrFn;
    try { await navigator.clipboard.writeText(t); toast('Copied', 'ok'); }
    catch { toast('Couldn’t copy — select and copy manually', 'err'); }
  }, { variant: 'ghost', small: true });
  return b;
}

/** Big "answer" block for calculators. */
export function answer(main, sub) {
  return h('div', {}, h('div', { class: 'big-answer' }, main), sub && h('div', { class: 'muted small' }, sub));
}

/** Grid of small labelled stats: stats([['Words', 120], ...]) */
export function stats(pairs) {
  return h('div', { class: 'stat' }, pairs.map(([k, v]) => h('div', { class: 's' }, h('div', { class: 'v' }, v), h('div', { class: 'k' }, k))));
}

// ── file & image helpers ────────────────────────────────────────────
export function stem(name = 'file') { return name.replace(/\.[^.]+$/, '') || 'file'; }
export const readArrayBuffer = f => f.arrayBuffer();
export const readText = f => f.text();

/** Decode an image (File/Blob/URL) with EXIF orientation applied. */
export async function loadImage(src) {
  const url = typeof src === 'string' ? src : URL.createObjectURL(src);
  const img = new Image();
  img.decoding = 'async';
  // onload, not img.decode(): decode() can stay pending forever while the page
  // isn't being painted, and Safari rejects it for some very large photos.
  const ok = await new Promise(res => {
    img.onload = () => res(img.naturalWidth > 0);
    img.onerror = () => res(false);
    img.src = url;
  });
  if (!ok) {
    if (url !== src) URL.revokeObjectURL(url);
    throw new Error('Couldn’t read that image (HEIC? try JPG/PNG, or set iPhone Camera ▸ Formats ▸ Most Compatible)');
  }
  return img;
}

/** Draw an image onto a new canvas (optionally scaled to fit maxSide). */
export function toCanvas(img, maxSide = 0) {
  let w = img.naturalWidth || img.width, h0 = img.naturalHeight || img.height;
  if (maxSide && Math.max(w, h0) > maxSide) { const s = maxSide / Math.max(w, h0); w = Math.round(w * s); h0 = Math.round(h0 * s); }
  const c = document.createElement('canvas'); c.width = w; c.height = h0;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, w, h0);
  return c;
}

export function canvasToBlob(canvas, type = 'image/jpeg', quality = 0.92) {
  return new Promise((res, rej) => canvas.toBlob(b => b ? res(b) : rej(new Error('Couldn’t encode the image')), type, quality));
}

/** Encode JPEG under a size cap by stepping quality down. Returns the Blob. */
export async function jpegUnder(canvas, maxBytes, { start = 0.95, floor = 0.35, step = 0.05 } = {}) {
  let q = start, b = await canvasToBlob(canvas, 'image/jpeg', q);
  // Rounded steps: plain q -= step drifts and stopped one step above the floor.
  while (b.size > maxBytes && q > floor + 1e-9) {
    q = Math.max(floor, Math.round((q - step) * 1000) / 1000);
    b = await canvasToBlob(canvas, 'image/jpeg', q);
  }
  return b;
}

/** Yield to the browser so progress bars can repaint during heavy loops. */
export const tick = () => new Promise(r => setTimeout(r, 0));
