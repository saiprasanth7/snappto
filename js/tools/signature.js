// Signature tools: signclean, signtransparent, signexam / signexam2, signcolor.
// Input: a phone photo of a signature on paper. Everything runs on the phone.
//
// Pipeline (same idea as the bot's engine/signature.py, but robust to shadows):
//   grayscale → paper brightness map (per-block percentile, so uneven light and
//   shadows don't turn into ink) → ink darkness d = 1 − gray/paper → Otsu
//   threshold, shifted by the Light…Bold slider → soft alpha for smooth edges →
//   drop specks and border shadows → crop to the ink + padding.
import {
  h, card, button, busy, field, row, segmented, filePicker, notice, progress, resultCard, fmtBytes, stem, canvasToBlob, jpegUnder,
} from '../ui.js';
import {
  clamp, num, yielder, fitWithin, fitContain, paperMap, otsu, components, dilate, errMsg,
  newCanvas, ctxOf, free, getData, drawHQ, loadSource, thumb, slider, labelled, compareStrip, previewEl,
} from './img-util.js';

/** Long side (px) the photo is analysed at — plenty for a signature. */
export const SIGN_WORK = 1600;
/** Default exam spec — same as the bot's SIGN_SPEC. ⚠️ exams differ; users can set their own. */
export const SIGN_SPEC = { w: 300, h: 100, maxKB: 20 };
const BLUE = [0x1a, 0x3f, 0xb5], BLACK = [0, 0, 0], WHITE = [255, 255, 255];
const NOY = async () => {};

/* ───────────────────────── pure analysis (node-testable) ───────────────────────── */

/** Grayscale + paper map + ink darkness. rgba: Uint8ClampedArray W×H×4 (opaque). */
export async function analyzeSignature(rgba, W, H, y_ = NOY) {
  const n = W * H, gray = new Float32Array(n);
  for (let i = 0, o = 0; i < n; i++, o += 4) gray[i] = 0.299 * rgba[o] + 0.587 * rgba[o + 1] + 0.114 * rgba[o + 2];
  await y_();
  const paper = paperMap(gray, W, H);
  await y_();
  const d = new Float32Array(n);
  for (let i = 0; i < n; i++) { const v = 1 - gray[i] / (paper[i] < 8 ? 8 : paper[i]); d[i] = v < 0 ? 0 : v > 1 ? 1 : v; }
  const step = Math.max(1, Math.floor(n / 400000)), sub = new Float32Array(Math.ceil(n / step));
  for (let i = 0, j = 0; i < n; i += step, j++) sub[j] = d[i];
  return { d, W, H, tAuto: clamp(otsu(sub), 0.1, 0.45) };
}

/**
 * Ink alpha (0..1) cropped to the signature. strength 0 = light … 1 = bold.
 * Returns null when no signature-like ink is found.
 * → {alpha: Float32Array, w, h, inkArea, box:{x,y,w,h}}
 */
export function extractInk(an, strength = 0.5) {
  const { d, W, H, tAuto } = an, n = W * H;
  const t = clamp(tAuto * (1.35 - 0.7 * strength), 0.06, 0.6), lo = t * 0.65, hi = t * 1.35;
  const alpha = new Float32Array(n), bin = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    let a = (d[i] - lo) / (hi - lo);
    a = a < 0 ? 0 : a > 1 ? 1 : a;
    alpha[i] = a * a * (3 - 2 * a);
    bin[i] = d[i] >= t ? 1 : 0;
  }
  const { labels, comps } = components(bin, W, H);
  const minArea = Math.max(4, Math.round(n * 5e-6));
  const keep = comps.map(c => {
    if (c.area < minArea || c.area > n * 0.2) return false;                 // specks / big dark blobs
    const bw = c.x1 - c.x0 + 1, bh = c.y1 - c.y0 + 1;
    if (c.border && (bw > W * 0.3 || bh > H * 0.3)) return false;           // shadows / table edges at the frame
    return true;
  });
  const kept = new Uint8Array(n);
  let x0 = W, y0 = H, x1 = -1, y1 = -1, area = 0;
  for (let k = 0; k < comps.length; k++) {
    if (!keep[k]) continue;
    const c = comps[k]; area += c.area;
    if (c.x0 < x0) x0 = c.x0; if (c.y0 < y0) y0 = c.y0; if (c.x1 > x1) x1 = c.x1; if (c.y1 > y1) y1 = c.y1;
  }
  if (area < Math.max(40, n * 2e-4) || x1 < 0) return null;
  for (let i = 0; i < n; i++) if (bin[i] && keep[labels[i] - 1]) kept[i] = 1;
  const near = dilate(kept, W, H, 2);                                        // keep soft edges next to kept ink only
  const pad = Math.max(6, Math.round(0.05 * Math.max(x1 - x0 + 1, y1 - y0 + 1)));
  const bx = Math.max(0, x0 - pad), by = Math.max(0, y0 - pad);
  const bw = Math.min(W, x1 + pad + 1) - bx, bh = Math.min(H, y1 + pad + 1) - by;
  let out = new Float32Array(bw * bh);
  for (let y = 0; y < bh; y++) {
    const so = (by + y) * W + bx, oo = y * bw;
    for (let x = 0; x < bw; x++) out[oo + x] = near[so + x] ? alpha[so + x] : 0;
  }
  if (strength >= 0.8) out = thicken(out, bw, bh);
  return { alpha: out, w: bw, h: bh, inkArea: area, box: { x: bx, y: by, w: bw, h: bh } };
}

/** 1-px grey dilation (3×3 max) — makes thin pen strokes bolder. */
export function thicken(a, w, h) {
  const out = new Float32Array(a.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let m = 0;
    for (let dy = -1; dy <= 1; dy++) {
      const yy = y + dy; if (yy < 0 || yy >= h) continue;
      for (let dx = -1; dx <= 1; dx++) { const xx = x + dx; if (xx < 0 || xx >= w) continue; const v = a[yy * w + xx]; if (v > m) m = v; }
    }
    out[y * w + x] = m;
  }
  return out;
}

/** Ink alpha → RGBA bytes: ink colour over `bg` (opaque) or over transparency when bg is null. */
export function inkPixels(ink, rgb, bg) {
  const { alpha, w, h } = ink, d = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const a = alpha[i], o = i * 4;
    if (bg) { d[o] = bg[0] + (rgb[0] - bg[0]) * a; d[o + 1] = bg[1] + (rgb[1] - bg[1]) * a; d[o + 2] = bg[2] + (rgb[2] - bg[2]) * a; d[o + 3] = 255; }
    else { d[o] = rgb[0]; d[o + 1] = rgb[1]; d[o + 2] = rgb[2]; d[o + 3] = a * 255; }
  }
  return d;
}

/** Exam-spec validation. → {w,h,maxKB} or an error string. */
export function examSpec(wStr, hStr, kbStr) {
  const w = Math.round(num(wStr)), h = Math.round(num(hStr)), kb = num(kbStr);
  if (!(w >= 20 && w <= 3000) || !(h >= 20 && h <= 3000)) return 'Width and height must be between 20 and 3000 pixels.';
  if (!(kb >= 2 && kb <= 5000)) return 'Max size must be between 2 and 5000 KB.';
  return { w, h, maxKB: kb };
}

/* ─────────────────────────────── DOM ─────────────────────────────── */

function inkCanvas(ink, rgb, bg) {
  const c = newCanvas(ink.w, ink.h), x = ctxOf(c, true);
  const im = x.createImageData(ink.w, ink.h);
  im.data.set(inkPixels(ink, rgb, bg));
  x.putImageData(im, 0, 0);
  return c;
}

const hexRGB = hex => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  const v = m ? parseInt(m[1], 16) : 0;
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
};

export async function mount(root, toolId) {
  const kind = toolId === 'signexam2' ? 'signexam' : toolId;
  if (!['signclean', 'signtransparent', 'signexam', 'signcolor'].includes(kind)) {
    root.append(notice('This tool isn’t available here yet.', 'warn'));
    return;
  }
  const S = { file: null, src: null, an: null, before: null, ran: false };
  const out = h('div');

  /* ── input ── */
  const status = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } });
  const setStatus = (...nodes) => { status.replaceChildren(...nodes.filter(Boolean)); status.style.marginTop = status.childElementCount ? '12px' : '0'; };
  let tok = 0;
  const reset = () => { free(S.src && S.src.canvas, S.before); S.file = S.src = S.an = S.before = null; S.ran = false; out.replaceChildren(); };
  const picker = filePicker({
    accept: 'image/*', capture: 'environment', icon: '✍️',
    label: 'Take a photo of your signature', hint: 'Dark pen · plain white paper · good light',
    onFiles: async files => {
      const my = ++tok;
      reset();
      if (!files.length) { setStatus(); return; }
      const p = progress('Opening photo…');
      setStatus(p.el);
      try {
        const src = await loadSource(files[0]);
        if (my !== tok) { free(src.canvas); return; }
        S.file = files[0]; S.src = src;
        S.before = await thumb(src.canvas, 720);
        setStatus(previewEl(await thumb(S.before, 480), '150px'),
          h('div', { class: 'faint small', style: { textAlign: 'center' } }, `${src.origW} × ${src.origH} px · ${fmtBytes(files[0].size)}`));
      } catch (e) {
        if (my !== tok) return;
        console.error(e); reset();
        setStatus(notice(errMsg(e), 'err'));
      }
    },
  });
  // capture="environment" opens the camera straight away on phones; offer the photo library too.
  const fileInput = picker.querySelector('input[type=file]'), dropLbl = picker.querySelector('.drop .lbl');
  const touch = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  const srcSeg = touch && segmented([['cam', '📷 Camera'], ['lib', '🖼 Photos & files']], 'cam', v => {
    if (v === 'cam') fileInput.setAttribute('capture', 'environment'); else fileInput.removeAttribute('capture');
    if (dropLbl) dropLbl.textContent = v === 'cam' ? 'Take a photo of your signature' : 'Choose a photo of your signature';
  });
  if (!touch) { fileInput.removeAttribute('capture'); if (dropLbl) dropLbl.textContent = 'Choose a photo of your signature'; }

  /* ── options ── */
  const opts = [];
  const strength = slider({
    label: 'Ink strength', min: 0, max: 100, value: 50,
    fmt: v => (v < 34 ? 'Light' : v < 67 ? 'Normal' : 'Bold'), ends: ['Thinner, cleaner', 'Thicker, darker'],
    onInput: () => rerun(),
  });
  opts.push(strength.el);

  let inkMode = 'blue', inkHex = '#1A3FB5', bgMode = 'white';
  let preset = 'default';
  const fW = field({ label: 'Width (px)', type: 'number', inputmode: 'decimal', value: String(SIGN_SPEC.w), min: 20, step: 1 });
  const fH = field({ label: 'Height (px)', type: 'number', inputmode: 'decimal', value: String(SIGN_SPEC.h), min: 20, step: 1 });
  const fK = field({ label: 'Max size (KB)', type: 'number', inputmode: 'decimal', value: String(SIGN_SPEC.maxKB), min: 2, step: 1 });
  if (kind === 'signexam') {
    for (const f of [fW, fH, fK]) { f.el.style.flex = '1 1 80px'; f.input.addEventListener('change', () => rerun()); }
    const customRow = row(fW.el, fH.el, fK.el);
    customRow.classList.add('hidden');
    const presetSeg = segmented([['default', `Default ${SIGN_SPEC.w}×${SIGN_SPEC.h} ≤${SIGN_SPEC.maxKB} KB`], ['custom', 'Custom']], preset, v => {
      preset = v; customRow.classList.toggle('hidden', v !== 'custom'); rerun();
    });
    presetSeg.style.flexWrap = 'wrap';
    for (const b of presetSeg.children) b.style.flex = '1 0 auto';
    opts.push(labelled('Size', presetSeg), customRow,
      notice('Check your exam’s exact size on its portal — every exam sets its own pixel size and KB limit.', 'info'));
  }
  if (kind === 'signcolor') {
    const colorIn = h('input', { type: 'color', value: inkHex, 'aria-label': 'Custom ink colour', style: { width: '56px', height: '40px', padding: '0', border: '0', background: 'none', borderRadius: '10px', cursor: 'pointer' } });
    const colorRow = h('div', { class: 'hidden', style: { display: 'flex', alignItems: 'center', gap: '10px' } }, colorIn, h('span', { class: 'faint small' }, 'Tap to pick any ink colour'));
    colorIn.addEventListener('input', () => { inkHex = colorIn.value; rerun(); });
    const inkSeg = segmented([['blue', 'Blue'], ['black', 'Black'], ['custom', 'Custom']], inkMode, v => {
      inkMode = v; colorRow.classList.toggle('hidden', v !== 'custom'); rerun();
    });
    const bgSeg = segmented([['white', 'White'], ['transparent', 'Transparent']], bgMode, v => { bgMode = v; rerun(); });
    opts.push(labelled('Ink colour', inkSeg), colorRow, labelled('Background', bgSeg));
  }
  if (kind === 'signtransparent') {
    opts.push(h('div', { class: 'faint small' }, 'Black ink on a transparent background. Want blue ink? Use ', h('a', { href: '#/tool/signcolor' }, 'Change ink colour'), '.'));
  }

  /* ── processing ── */
  async function ensureAnalysis(p) {
    if (S.an) return S.an;
    if (p) p.set(0.15, 'Reading your photo…');
    const f = fitWithin(S.src.w, S.src.h, SIGN_WORK);
    const work = await drawHQ(S.src.canvas, f.w, f.h, { bg: '#fff' });
    const data = getData(work).data;
    free(work);
    if (p) p.set(0.35, 'Finding the paper and ink…');
    S.an = await analyzeSignature(data, f.w, f.h, yielder());
    return S.an;
  }

  async function render(ink) {
    const name = stem(S.file.name);
    if (kind === 'signclean') {
      const c = inkCanvas(ink, BLACK, WHITE);
      const blob = await canvasToBlob(c, 'image/jpeg', 0.92); free(c);
      return { blob, filename: `${name}_signature.jpg`, title: 'Clean signature', note: `${ink.w} × ${ink.h} px · black ink on pure white, cropped to the signature` };
    }
    if (kind === 'signtransparent') {
      const c = inkCanvas(ink, BLACK, null);
      const blob = await canvasToBlob(c, 'image/png'); free(c);
      return { blob, filename: `${name}_signature.png`, title: 'Transparent signature', note: `${ink.w} × ${ink.h} px PNG · paste it onto any document`, checker: true };
    }
    if (kind === 'signcolor') {
      const rgb = inkMode === 'blue' ? BLUE : inkMode === 'black' ? BLACK : hexRGB(inkHex);
      const transparent = bgMode === 'transparent';
      const c = inkCanvas(ink, rgb, transparent ? null : WHITE);
      const type = transparent ? 'image/png' : 'image/jpeg';
      const blob = await canvasToBlob(c, type, 0.92); free(c);
      const what = inkMode === 'custom' ? 'ink' : inkMode;
      return { blob, filename: `${name}_signature_${what}.${transparent ? 'png' : 'jpg'}`, title: `${inkMode === 'custom' ? 'Recoloured' : inkMode === 'blue' ? 'Blue' : 'Black'} signature`, note: `${ink.w} × ${ink.h} px · ${transparent ? 'transparent PNG' : 'JPEG on white'}`, checker: transparent };
    }
    // signexam
    const spec = preset === 'custom' ? examSpec(fW.value, fH.value, fK.value) : { ...SIGN_SPEC };
    if (typeof spec === 'string') return { error: spec };
    const { w: W, h: H, maxKB } = spec;
    const clean = inkCanvas(ink, BLACK, WHITE);
    const fit = fitContain(ink.w, ink.h, W, H);
    const scaled = await drawHQ(clean, fit.w, fit.h);
    free(clean);
    const box = newCanvas(W, H), bx = ctxOf(box, true);
    bx.fillStyle = '#fff'; bx.fillRect(0, 0, W, H);
    bx.drawImage(scaled, fit.x, fit.y);
    free(scaled);
    // Shrinking thins the strokes; darken the grey edges so it stays legible.
    const im = bx.getImageData(0, 0, W, H), dd = im.data;
    for (let i = 0; i < dd.length; i += 4) for (let c = 0; c < 3; c++) dd[i + c] = 255 * Math.pow(dd[i + c] / 255, 1.6);
    bx.putImageData(im, 0, 0);
    const limit = Math.round(maxKB * 1000);   // under the limit whether the portal counts 1 KB as 1000 or 1024 bytes
    const blob = await jpegUnder(box, limit, { start: 0.95, floor: 0.2, step: 0.05 });
    free(box);
    const fits = blob.size <= limit;
    return {
      blob, filename: `${name}_signature_${W}x${H}.jpg`, outline: true,
      title: fits ? `${W} × ${H} px · under ${maxKB} KB ✓` : `${W} × ${H} px`,
      note: `Exactly ${W} × ${H} px · ${fmtBytes(blob.size)} (limit ${maxKB} KB)`,
      extra: fits ? null : notice(`Couldn’t get under ${maxKB} KB at this size — this is the smallest we could make it (${fmtBytes(blob.size)}). Check the limit, or try a larger one.`, 'warn'),
    };
  }

  async function doRun(showProgress) {
    if (!S.src) { out.replaceChildren(notice('Take or choose a photo of your signature first.', 'warn')); return; }
    const p = showProgress ? progress('Cleaning your signature…') : null;
    if (p) out.replaceChildren(p.el);
    try {
      const an = await ensureAnalysis(p);
      if (p) p.set(0.7, 'Tidying the ink…');
      const ink = extractInk(an, strength.value / 100);
      if (!ink) {
        out.replaceChildren(notice('Couldn’t find a signature in this photo. Sign with a dark pen on plain white paper, take the photo in good light, fill the frame — then try again. Moving “Ink strength” towards Bold can also help.', 'err'));
        return;
      }
      const r = await render(ink);
      if (r.error) { out.replaceChildren(notice(r.error, 'warn')); return; }
      const rc = await resultCard({ title: r.title, blob: r.blob, filename: r.filename, note: r.note, preview: 'none' });
      const before = newCanvas(S.before.width, S.before.height);
      ctxOf(before).drawImage(S.before, 0, 0);
      rc.prepend(compareStrip(before, r.blob, { checker: !!r.checker, outline: !!r.outline }));
      out.replaceChildren(...[r.extra, rc].filter(Boolean));
      if (showProgress && rc.scrollIntoView) rc.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      S.ran = true;
    } catch (e) {
      console.error(e);
      out.replaceChildren(notice(errMsg(e), 'err'));
    } finally { if (p) p.done(); }
  }

  // One run at a time; option changes after the first result re-run automatically.
  let running = null, again = false, timer = 0;
  function process(showProgress) {
    if (running) { again = true; return running; }
    running = doRun(showProgress).finally(() => {
      running = null;
      if (again) { again = false; process(false); }
    });
    return running;
  }
  function rerun() {
    if (!S.ran || !S.src) return;
    clearTimeout(timer);
    timer = setTimeout(() => process(false), 180);
  }

  const LABEL = { signclean: 'Clean signature', signtransparent: 'Make transparent PNG', signexam: 'Make exam signature', signcolor: 'Change ink colour' };
  const go = button(LABEL[kind], () => busy(go, () => process(true)), { full: true });

  root.append(
    card({ title: 'Your signature', sub: 'Sign on plain white paper with a dark pen, then photograph it in good light.' },
      h('div', { class: 'stack' }, srcSeg, h('div', {}, picker, status))),
    card({ title: 'Options', sub: 'Adjust after the first result — the preview updates by itself.' }, ...opts),
    go, out);
}
