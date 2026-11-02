// Image tools: removebg, imgcompress, resize, crop, imgrotate, convert_img,
// enhance, blurbg, stripmeta. Everything runs on the phone; nothing is uploaded.
//
// iPhone Safari notes baked in here:
//  • no ctx.filter → blur / sharpen / levels are done on ImageData (img-util.js)
//  • toBlob('image/webp') silently returns PNG → we check blob.type and say so
//  • big photos → one source canvas capped at ~16 MP, heavy pixel work on a
//    ~2400 px working copy, and loops yield to the browser so the UI repaints.
import {
  h, card, button, busy, field, row, segmented, filePicker, notice, progress,
  resultCard, fmtBytes, stem, canvasToBlob, jpegUnder,
} from '../ui.js';
import { personSegmenter } from '../lib.js';
import {
  MAX_AREA, clamp, num, yielder, fitWithin, nextScale, blurPlane, lumaPlane, resamplePlane,
  guidedAB, guidedUpsample, rampPlane, maskedBlurField, bilinearAxis, unsharp3, levelsLUT, applyLUT,
  ratioRect, moveRect, dragCorner, intRect, ORIENT_ID, ORIENT_OPS, orientMul, orientSize, describeOrient,
  parseMeta, fmtExifDate, fmtLatLon, keepType, extFor, typeName, errMsg,
  newCanvas, ctxOf, free, getData, drawHQ, loadSource, flatten, canEncodeWebP, encodeAs, thumb,
  UrlBag, slider, chipSeg, optionRow, labelled, kvList, previewEl, addBeforeAfter,
} from './img-util.js';

/** Working sizes (long side, px) — raise for quality, lower for older phones. */
export const WORK = { removebg: 2400, blurbg: 2400, guide: 1024, enhanceMax: 3200 };

export async function mount(root, toolId) {
  const fn = TOOLS[toolId];
  if (!fn) { root.append(notice('This tool isn’t available here yet.', 'warn')); return; }
  try { await fn(root); }
  catch (e) { console.error(e); root.append(notice(errMsg(e), 'err')); }
}

/* ───────────────────────── shared scaffolding ───────────────────────── */

function photoState() {
  const S = { file: null, src: null, before: null, matte: null, gen: 0, bag: new UrlBag() };
  S.reset = () => {
    S.gen++;                 // a run still busy with the old photo sees this and drops its result
    S.bag.clear();
    free(S.src && S.src.canvas, S.before, S.matte && S.matte.work);
    S.file = S.src = S.before = S.matte = null;
  };
  return S;
}

/**
 * The input card. Loads the photo into S.src (≤16 MP canvas, orientation applied),
 * makes S.before (≤1200 px copy for Before/After) and shows a small preview.
 */
function photoCard(S, { title = 'Your photo', sub, preview = true, onLoad, onClear } = {}) {
  const status = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } });
  const setStatus = (...nodes) => {
    status.replaceChildren(...nodes.filter(Boolean));
    status.style.marginTop = status.childElementCount ? '12px' : '0';
  };
  let tok = 0;
  const picker = filePicker({
    accept: 'image/*', icon: '🖼', label: 'Choose a photo', hint: 'JPG, PNG or WebP · stays on your phone',
    onFiles: async files => {
      const my = ++tok;
      S.reset();
      if (onClear) onClear();
      if (!files.length) { setStatus(); return; }
      const file = files[0];
      const p = progress('Opening photo…');
      setStatus(p.el);
      try {
        const src = await loadSource(file);
        if (my !== tok) { free(src.canvas); return; }
        S.file = file; S.src = src;
        S.before = await thumb(src.canvas, 1200);
        const pv = preview ? previewEl(await thumb(S.before, 640), '180px') : null;
        setStatus(pv, h('div', { class: 'faint small', style: { textAlign: 'center' } }, describeSrc(file, src)));
        if (onLoad) await onLoad(file, src);
      } catch (e) {
        if (my !== tok) return;
        console.error(e);
        S.reset();
        setStatus(notice(errMsg(e), 'err'));
      }
    },
  });
  return card({ title, sub }, h('div', {}, picker, status));
}

function describeSrc(file, src) {
  return `${src.origW} × ${src.origH} px · ${fmtBytes(file.size)}` +
    (src.scaled ? ` · working at ${src.w} × ${src.h} (browser limit)` : '');
}
/** Result-note sentence for photos that were scaled down on load (empty otherwise). */
const capNote = src => src.scaled && `The original ${src.origW} × ${src.origH} photo was larger than your browser can handle, so it was scaled to about 16 MP first`;

/** Thrown when a new photo is picked mid-run; runner() drops it quietly. */
const STALE = new Error('stale');

/**
 * Wrap a tool's work: clears old results, shows progress, catches every error.
 * If a new photo is picked while it runs, the old photo's result (or error) is dropped.
 */
function runner(S, out) {
  return (btn, work) => busy(btn, async () => {
    out.replaceChildren();
    S.bag.clear();
    if (!S.src) { out.append(notice('Choose a photo first.', 'warn')); return; }
    const gen = S.gen, p = progress('Working…');
    out.append(p.el);
    try {
      const nodes = [].concat(await work(p)).filter(Boolean);
      p.done();
      if (S.gen !== gen) return;
      out.append(...nodes);
      if (nodes[0] && nodes[0].scrollIntoView) nodes[0].scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (e) {
      p.done();
      if (e === STALE || S.gen !== gen) return;
      console.error(e);
      out.append(notice(errMsg(e), 'err'));
    }
  });
}

const hexRGB = hex => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  const v = m ? parseInt(m[1], 16) : 0xffffff;
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
};
const outName = (file, what, ext) => `${stem(file.name)}_${what}.${ext}`;
const yieldWith = (p, a, b) => {
  // a yielder that also nudges the progress bar between fractions a..b
  let f = a;
  return yielder(28, () => { f = Math.min(b, f + (b - f) * 0.08); p.set(f); });
};

/* ───────────────────── person matte (removebg, blurbg) ───────────────────── */

/**
 * Soft person matte at working size: MediaPipe selfie segmenter on a ≤1024 px
 * copy, then a guided filter so the edge follows the real outline at full size.
 * Cached on S until a new photo is picked. → {work, W, H, q: Float32Array 0..1}
 * Throws STALE (and caches nothing) if a new photo is picked while it works.
 */
async function getMatte(S, p, maxSide) {
  if (S.matte) return S.matte;
  const src = S.src, gen = S.gen;
  p.set(null, 'Loading the cut-out model…');
  let seg;
  try { seg = await personSegmenter(); }
  catch (e) {
    console.error(e);
    throw new Error(navigator.onLine
      ? 'Couldn’t start the cut-out model on this device. Close other tabs and try again.'
      : 'The cut-out model isn’t saved on this phone yet. Open this tool once while online, or download “Face detection & background removal” under More ▸ Use offline.');
  }
  if (S.gen !== gen) throw STALE;
  const f = fitWithin(src.w, src.h, maxSide);
  const W = f.w, H = f.h;
  p.set(0.15, 'Finding the person…');
  const work = await drawHQ(src.canvas, W, H, { bg: '#fff' });
  const g = fitWithin(W, H, WORK.guide);
  const guide = await drawHQ(work, g.w, g.h);
  if (S.gen !== gen) { free(work, guide); throw STALE; }
  let mask, mw, mh;
  const res = seg.segment(guide);
  try {
    const ms = res && res.confidenceMasks;
    if (!ms || !ms.length) throw new Error('Couldn’t analyse this photo. Try a different one.');
    const m0 = ms[0];
    mw = m0.width; mh = m0.height;
    const a = m0.getAsFloat32Array();
    mask = new Float32Array(a.length);
    if (ms.length > 1) for (let i = 0; i < a.length; i++) mask[i] = 1 - a[i];   // multi-class model: [0] = background
    else mask.set(a);
  } finally { if (res && res.close) res.close(); }
  if (mw !== g.w || mh !== g.h) mask = resamplePlane(mask, mw, mh, g.w, g.h);

  p.set(0.35, 'Refining the edges…');
  const y0 = yieldWith(p, 0.35, 0.65);
  const y = async () => { await y0(); if (S.gen !== gen) throw STALE; };   // stop soon after a new photo is picked
  const I = lumaPlane(getData(guide).data, g.w * g.h);
  free(guide);
  const r = Math.max(4, Math.round(Math.max(g.w, g.h) / 90));
  let q;
  try {
    const { A, B } = await guidedAB(I, mask, g.w, g.h, r, 3e-3, y);
    q = await guidedUpsample(A, B, g.w, g.h, getData(work).data, W, H, y);
    if (S.gen !== gen) throw STALE;
  } catch (e) { free(work); throw e; }
  S.matte = { work, W, H, q };
  return S.matte;
}

function personCoverage(alpha) {
  let n = 0; const step = Math.max(1, Math.floor(alpha.length / 200000)), total = Math.ceil(alpha.length / step);
  for (let i = 0; i < alpha.length; i += step) if (alpha[i] > 0.5) n++;
  return n / total;
}
const NO_PERSON = 'Couldn’t find a person in this photo. This tool is made for photos of people (selfies and portraits) — it can’t cut out objects, pets or products.';

/** Decontaminated foreground colour at alpha a: (C − (1−a)·B) / a, kept stable for small a. */
function unmix(c, b, a) { return clamp((c - (1 - a) * b) / (a > 0.2 ? a : 0.2), 0, 255); }

/* ─────────────────────────────── removebg ─────────────────────────────── */

async function removeBg(root) {
  const S = photoState(), out = h('div'), run = runner(S, out);
  let mode = 'transparent', color = '#2F6FDB';

  const colorIn = h('input', { type: 'color', value: color, 'aria-label': 'Pick any background colour', style: { width: '52px', height: '40px', padding: '0', border: '0', background: 'none', borderRadius: '10px', cursor: 'pointer' } });
  const SW = [['#CFE3FF', 'Light blue'], ['#2F6FDB', 'Blue'], ['#E6E6E6', 'Light grey'], ['#D93636', 'Red'], ['#111111', 'Black']];
  const swatches = SW.map(([hex, name]) => h('button', {
    type: 'button', 'aria-label': name, title: name,
    style: { width: '40px', height: '40px', borderRadius: '50%', border: '2px solid var(--surface)', background: hex, cursor: 'pointer', padding: '0', flex: 'none' },
    onclick: () => { color = hex; colorIn.value = hex; mark(); },
  }));
  const mark = () => swatches.forEach((b, i) => { b.style.boxShadow = SW[i][0].toLowerCase() === color.toLowerCase() ? '0 0 0 2.5px var(--brand)' : '0 0 0 1px var(--line-2)'; });
  colorIn.addEventListener('input', () => { color = colorIn.value; mark(); });
  mark();
  const colorRow = h('div', { class: 'hidden', style: { display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' } },
    swatches, colorIn, h('span', { class: 'faint small' }, 'or any colour'));
  const bgSeg = segmented([['transparent', 'Transparent'], ['white', 'White'], ['color', 'Colour']], mode, v => {
    mode = v; colorRow.classList.toggle('hidden', v !== 'color');
  });
  const soft = slider({ label: 'Edge softness', min: 0, max: 100, value: 30, fmt: v => (v < 20 ? 'Crisp' : v < 60 ? 'Natural' : 'Soft'), ends: ['Crisp', 'Soft'] });

  const go = button('Remove background', () => run(go, async p => {
    const m = await getMatte(S, p, WORK.removebg);
    const { W, H } = m, y = yieldWith(p, 0.65, 0.9);
    p.set(0.65, 'Cutting out…');
    const t = soft.value / 100, half = 0.07 + 0.3 * t;
    const alpha = rampPlane(Float32Array.from(m.q), 0.5 - half, 0.5 + half);
    const sig = (t * Math.max(W, H)) / 700;
    if (sig > 0.4) await blurPlane(alpha, W, H, sig, y);
    if (personCoverage(alpha) < 0.003) return notice(NO_PERSON, 'warn');

    const img = getData(m.work), d = img.data;
    const F = await maskedBlurField(d, W, H, alpha, Math.max(W, H) / 120, y);   // local old-background colour
    const X = bilinearAxis(F.bw, W), Yx = bilinearAxis(F.bh, H);
    const solid = mode !== 'transparent', bg = mode === 'white' ? [255, 255, 255] : hexRGB(color);
    for (let yy = 0; yy < H; yy++) {
      const r0 = Yx.i0[yy] * F.bw, r1 = Yx.i1[yy] * F.bw, fy = Yx.f[yy];
      for (let x = 0; x < W; x++) {
        const i = yy * W + x, o = i * 4, a = alpha[i];
        let R = d[o], G = d[o + 1], Bc = d[o + 2];
        if (a > 0.002 && a < 0.995) {         // edge pixel: strip the old background's tint
          const k0 = r0 + X.i0[x], k1 = r0 + X.i1[x], k2 = r1 + X.i0[x], k3 = r1 + X.i1[x], fx = X.f[x];
          const w00 = (1 - fx) * (1 - fy), w01 = fx * (1 - fy), w10 = (1 - fx) * fy, w11 = fx * fy;
          R = unmix(R, F.R[k0] * w00 + F.R[k1] * w01 + F.R[k2] * w10 + F.R[k3] * w11, a);
          G = unmix(G, F.G[k0] * w00 + F.G[k1] * w01 + F.G[k2] * w10 + F.G[k3] * w11, a);
          Bc = unmix(Bc, F.B[k0] * w00 + F.B[k1] * w01 + F.B[k2] * w10 + F.B[k3] * w11, a);
        }
        if (solid) {
          d[o] = R * a + bg[0] * (1 - a); d[o + 1] = G * a + bg[1] * (1 - a); d[o + 2] = Bc * a + bg[2] * (1 - a); d[o + 3] = 255;
        } else {
          d[o] = R; d[o + 1] = G; d[o + 2] = Bc; d[o + 3] = a * 255;
        }
      }
      if ((yy & 31) === 31) await y();
    }
    p.set(0.92, 'Saving…');
    const c = newCanvas(W, H);
    ctxOf(c, true).putImageData(img, 0, 0);
    const type = solid ? 'image/jpeg' : 'image/png';
    const blob = await canvasToBlob(c, type, 0.92);
    free(c);
    const rc = await resultCard({
      title: 'Background removed', blob, filename: outName(S.file, solid ? 'newbg' : 'nobg', extFor(type)),
      note: `${W} × ${H} px · ${solid ? 'JPEG on a solid background' : 'PNG with a transparent background'}. Rough edges? Try more edge softness, or a photo with a plainer background.`,
    });
    return addBeforeAfter(rc, S.before, S.bag);
  }), { full: true });

  root.append(
    photoCard(S, { sub: 'Works best on photos of people — selfies, portraits and half-body shots.', onClear: () => out.replaceChildren() }),
    card({ title: 'Options' }, labelled('New background', bgSeg), colorRow, soft.el),
    go, out);
}

/* ─────────────────────────────── blurbg ─────────────────────────────── */

async function blurBg(root) {
  const S = photoState(), out = h('div'), run = runner(S, out);
  const strength = slider({ label: 'Blur strength', min: 1, max: 100, value: 50, fmt: v => (v < 30 ? 'Subtle' : v < 70 ? 'Medium' : 'Strong'), ends: ['Subtle', 'Strong'] });

  const go = button('Blur background', () => run(go, async p => {
    const m = await getMatte(S, p, WORK.blurbg);
    const { W, H } = m, y = yieldWith(p, 0.65, 0.9);
    p.set(0.65, 'Blurring the background…');
    const alpha = rampPlane(Float32Array.from(m.q), 0.3, 0.7);
    await blurPlane(alpha, W, H, Math.max(1, Math.max(W, H) / 900), y);
    if (personCoverage(alpha) < 0.003) return notice(NO_PERSON, 'warn');

    const sigma = Math.max(W, H) * (0.002 + (0.018 * strength.value) / 100);
    const img = getData(m.work), d = img.data;
    // background blurred from background pixels only → no glow of the person around the edges
    const F = await maskedBlurField(d, W, H, alpha, sigma, y);
    const X = bilinearAxis(F.bw, W), Yx = bilinearAxis(F.bh, H);
    for (let yy = 0; yy < H; yy++) {
      const r0 = Yx.i0[yy] * F.bw, r1 = Yx.i1[yy] * F.bw, fy = Yx.f[yy];
      for (let x = 0; x < W; x++) {
        const i = yy * W + x, o = i * 4, a = alpha[i];
        if (a >= 0.999) continue;
        const k0 = r0 + X.i0[x], k1 = r0 + X.i1[x], k2 = r1 + X.i0[x], k3 = r1 + X.i1[x], fx = X.f[x], b = 1 - a;
        const w00 = (1 - fx) * (1 - fy) * b, w01 = fx * (1 - fy) * b, w10 = (1 - fx) * fy * b, w11 = fx * fy * b;
        d[o] = d[o] * a + F.R[k0] * w00 + F.R[k1] * w01 + F.R[k2] * w10 + F.R[k3] * w11;
        d[o + 1] = d[o + 1] * a + F.G[k0] * w00 + F.G[k1] * w01 + F.G[k2] * w10 + F.G[k3] * w11;
        d[o + 2] = d[o + 2] * a + F.B[k0] * w00 + F.B[k1] * w01 + F.B[k2] * w10 + F.B[k3] * w11;
        d[o + 3] = 255;
      }
      if ((yy & 31) === 31) await y();
    }
    p.set(0.92, 'Saving…');
    const c = newCanvas(W, H);
    ctxOf(c, true).putImageData(img, 0, 0);
    const blob = await canvasToBlob(c, 'image/jpeg', 0.92);
    free(c);
    const rc = await resultCard({
      title: 'Background blurred', blob, filename: outName(S.file, 'portrait', 'jpg'), before: S.file.size,
      note: `${W} × ${H} px${S.src.w > W || S.src.h > H ? ` (resized from ${S.src.w} × ${S.src.h} for speed)` : ''}`,
    });
    return addBeforeAfter(rc, S.before, S.bag);
  }), { full: true });

  root.append(
    photoCard(S, { sub: 'Works best on photos of people — the person stays sharp, everything behind them softens.', onClear: () => out.replaceChildren() }),
    card({ title: 'Options' }, strength.el),
    go, out);
}

/* ───────────────────────────── imgcompress ───────────────────────────── */

const KB = 1000;   // "200 KB" → 200,000 bytes: under the limit whichever way a portal counts

async function compressImage(root) {
  const S = photoState(), out = h('div'), run = runner(S, out);
  let mode = 'target', preset = '200';
  const PRESETS = [['50', '50 KB'], ['100', '100 KB'], ['200', '200 KB'], ['500', '500 KB'], ['1000', '1 MB'], ['custom', 'Custom']];
  const custom = field({ label: 'Size limit (KB)', type: 'number', inputmode: 'decimal', value: '150', min: 5, step: 1 });
  custom.el.classList.add('hidden');
  const chips = chipSeg(PRESETS, preset, v => { preset = v; custom.el.classList.toggle('hidden', v !== 'custom'); });
  const quality = slider({ label: 'Quality', min: 10, max: 100, value: 70, fmt: v => v + '%', ends: ['Smaller file', 'Better quality'] });
  const targetBox = h('div', { class: 'stack' }, labelled('Make it smaller than', chips), custom.el);
  const qualityBox = h('div', { class: 'hidden' }, quality.el);
  const modeSeg = segmented([['target', 'Target size'], ['quality', 'Quality']], mode, v => {
    mode = v; targetBox.classList.toggle('hidden', v !== 'target'); qualityBox.classList.toggle('hidden', v !== 'quality');
  });
  const pngNote = h('div', { class: 'hidden' }, notice('Saved as JPEG (the smallest format for photos). Any transparent areas become white.', 'info'));

  const go = button('Compress', () => run(go, async p => {
    const { src, file } = S;
    const opaque = /jpe?g/i.test(file.type) ? src.canvas : null;
    const base = opaque || flatten(src.canvas);
    try {
      if (mode === 'quality') {
        p.set(null, 'Compressing…');
        const q = quality.value / 100;
        const blob = await canvasToBlob(base, 'image/jpeg', q);
        const rc = await resultCard({
          title: 'Compressed', blob, filename: outName(file, 'compressed', 'jpg'), before: file.size,
          note: [`${src.w} × ${src.h} px · quality ${quality.value}%${blob.size >= file.size ? ' — bigger than the original, try a lower quality' : ''}`, capNote(src)].filter(Boolean).join('. '),
        });
        return addBeforeAfter(rc, S.before, S.bag);
      }
      const kb = preset === 'custom' ? num(custom.value) : +preset;
      if (!(kb >= 5)) return notice('Enter a size limit of at least 5 KB.', 'warn');
      const target = Math.round(kb * KB), label = kb >= 1000 && kb % 1000 === 0 ? `${kb / 1000} MB` : `${kb} KB`;
      if (file.size <= target && /jpe?g/i.test(file.type)) {
        return [notice(`Your photo is already ${fmtBytes(file.size)} — under ${label}. No need to shrink it.`, 'ok'),
          await resultCard({ title: 'Already small enough', blob: file, filename: file.name, note: `${src.origW} × ${src.origH} px` })];
      }
      const FLOOR = 0.4;
      let scale = 1, cur = base, w = src.w, h0 = src.h, blob = null;
      for (let i = 0; i < 24 && !blob; i++) {
        p.set(Math.min(0.9, 0.1 + i * 0.12), scale < 1 ? `Trying ${w} × ${h0} px…` : 'Compressing…');
        const probe = await canvasToBlob(cur, 'image/jpeg', FLOOR);
        if (probe.size <= target) {
          const best = await jpegUnder(cur, target, { start: 0.92, floor: FLOOR, step: 0.04 });
          blob = best.size <= target ? best : probe;
          break;
        }
        if (Math.min(w, h0) <= 48) break;
        scale = nextScale(scale, probe.size, target);
        w = Math.max(16, Math.round(src.w * scale)); h0 = Math.max(16, Math.round(src.h * scale));
        const next = await drawHQ(src.canvas, w, h0, { bg: '#fff' });
        if (cur !== base) free(cur);
        cur = next;
      }
      if (cur !== base) free(cur);
      if (!blob) return notice(`Couldn’t get this photo under ${label}. Try a larger limit.`, 'err');
      const resized = w !== src.w || h0 !== src.h;
      const rc = await resultCard({
        title: `Under ${label} ✓`, blob, filename: outName(file, 'compressed', 'jpg'), before: file.size,
        note: [resized ? `Resized ${src.w} × ${src.h} → ${w} × ${h0} px to reach the limit` : `${w} × ${h0} px${src.scaled ? '' : ' · same size, lower file weight'}`,
          capNote(src)].filter(Boolean).join('. '),
      });
      return addBeforeAfter(rc, S.before, S.bag);
    } finally { if (base !== src.canvas) free(base); }
  }), { full: true });

  root.append(
    photoCard(S, { onLoad: file => pngNote.classList.toggle('hidden', /jpe?g/i.test(file.type)), onClear: () => out.replaceChildren() }),
    card({ title: 'How small?' }, modeSeg, targetBox, qualityBox, pngNote),
    go, out);
}

/* ─────────────────────────────── resize ─────────────────────────────── */

async function resizeImage(root) {
  const S = photoState(), out = h('div'), run = runner(S, out);
  let mode = 'px', locked = true;
  const fw = field({ label: 'Width (px)', type: 'number', inputmode: 'decimal', min: 1, step: 1 });
  const fh = field({ label: 'Height (px)', type: 'number', inputmode: 'decimal', min: 1, step: 1 });
  const lock = button('Keep proportions', () => {
    locked = !locked;
    lock.className = `btn btn-${locked ? 'secondary' : 'ghost'} btn-sm`;
    lock.querySelector('.lbl').textContent = locked ? 'Keep proportions' : 'Free (may stretch)';
    lock.firstChild.textContent = locked ? '🔒' : '🔓';
    if (locked) syncFrom('w');
    readout();
  }, { variant: 'secondary', small: true, icon: '🔒' });
  lock.style.alignSelf = 'flex-start';
  const pct = slider({ label: 'Scale', min: 5, max: 200, step: 1, value: 50, fmt: v => v + '%', ends: ['5%', '200%'], onInput: () => readout() });
  const info = h('div', { class: 'muted small', style: { fontWeight: '600' } });
  const pxBox = h('div', { class: 'stack' }, row(fw.el, fh.el), lock);
  const pctBox = h('div', { class: 'hidden' }, pct.el);
  const modeSeg = segmented([['px', 'Pixels'], ['pct', 'Percentage']], mode, v => {
    mode = v; pxBox.classList.toggle('hidden', v !== 'px'); pctBox.classList.toggle('hidden', v !== 'pct'); readout();
  });

  const syncFrom = which => {
    if (!locked || !S.src) return;
    const { w, h: H } = S.src;
    if (which === 'w') { const v = Math.round(num(fw.value)); if (v > 0) fh.value = Math.max(1, Math.round((v * H) / w)); }
    else { const v = Math.round(num(fh.value)); if (v > 0) fw.value = Math.max(1, Math.round((v * w) / H)); }
  };
  fw.input.addEventListener('input', () => { syncFrom('w'); readout(); });
  fh.input.addEventListener('input', () => { syncFrom('h'); readout(); });

  const target = () => {
    if (!S.src) return null;
    if (mode === 'pct') { const s = pct.value / 100; return { w: Math.max(1, Math.round(S.src.w * s)), h: Math.max(1, Math.round(S.src.h * s)) }; }
    const w = Math.round(num(fw.value)), H = Math.round(num(fh.value));
    return w > 0 && H > 0 ? { w, h: H } : null;
  };
  function readout() {
    const t = target();
    info.textContent = !S.src ? '' : t ? `${S.src.w} × ${S.src.h} → ${t.w} × ${t.h} px` : 'Enter a width and height';
  }

  const go = button('Resize', () => run(go, async p => {
    const t = target();
    if (!t) return notice('Enter a width and height in pixels.', 'warn');
    if (t.w > 20000 || t.h > 20000 || t.w * t.h > MAX_AREA) return notice('That size is too big for a phone browser (about 16 megapixels max). Try smaller numbers.', 'warn');
    p.set(null, 'Resizing…');
    const c = await drawHQ(S.src.canvas, t.w, t.h);
    const enc = await encodeAs(c, keepType(S.file.type), 0.92);
    free(c);
    return resultCard({
      title: 'Resized', blob: enc.blob, filename: outName(S.file, `${t.w}x${t.h}`, enc.ext), before: S.file.size,
      note: [`${S.src.w} × ${S.src.h} → ${t.w} × ${t.h} px · ${typeName(enc.type)}`, enc.note].filter(Boolean).join('. '),
    });
  }), { full: true });

  root.append(
    photoCard(S, {
      onLoad: (_, src) => { fw.value = src.w; fh.value = src.h; readout(); },
      onClear: () => { out.replaceChildren(); fw.value = ''; fh.value = ''; readout(); },
    }),
    card({ title: 'New size', sub: 'Keeps the original format (JPEG, PNG or WebP).' }, modeSeg, pxBox, pctBox, info),
    go, out);
}

/* ──────────────────────────────── crop ──────────────────────────────── */

const RATIOS = { free: 0, '1:1': 1, '4:5': 4 / 5, '3:4': 3 / 4, '4:3': 4 / 3, '16:9': 16 / 9, '9:16': 9 / 16 };

async function cropImage(root) {
  const S = photoState(), out = h('div'), run = runner(S, out);
  let rect = null, ratio = 0, k = 1, drag = null, dpr = 1;

  const cvs = h('canvas', { style: { display: 'block', width: '100%', height: '100%' }, 'aria-label': 'Photo being cropped' });
  const line = (pos, vert) => h('div', { style: Object.assign({ position: 'absolute', background: 'rgba(255,255,255,.45)', pointerEvents: 'none' }, vert ? { top: '0', bottom: '0', left: pos, width: '1px' } : { left: '0', right: '0', top: pos, height: '1px' }) });
  const box = h('div', {
    'aria-label': 'Crop area — drag to move',
    style: { position: 'absolute', boxSizing: 'border-box', border: '1.5px solid rgba(255,255,255,.95)', boxShadow: '0 0 0 9999px rgba(10,8,20,.55)', touchAction: 'none', cursor: 'move', pointerEvents: 'auto' },
  }, line('33.333%', true), line('66.667%', true), line('33.333%', false), line('66.667%', false));
  const clip = h('div', { style: { position: 'absolute', top: '0', left: '0', right: '0', bottom: '0', overflow: 'hidden', pointerEvents: 'none' } }, box);
  const bracket = c => {
    const s = { position: 'absolute', width: '20px', height: '20px', borderStyle: 'solid', borderColor: '#fff', borderWidth: '0', filter: 'drop-shadow(0 0 1.5px rgba(0,0,0,.55))', pointerEvents: 'none' };
    if (c[0] === 'n') { s.top = '19px'; s.borderTopWidth = '4px'; } else { s.bottom = '19px'; s.borderBottomWidth = '4px'; }
    if (c[1] === 'w') { s.left = '19px'; s.borderLeftWidth = '4px'; } else { s.right = '19px'; s.borderRightWidth = '4px'; }
    return h('div', { style: s });
  };
  const handles = ['nw', 'ne', 'sw', 'se'].map(c => h('div', {
    dataset: { c }, 'aria-label': 'Resize crop',
    style: { position: 'absolute', width: '44px', height: '44px', marginLeft: '-22px', marginTop: '-22px', touchAction: 'none', zIndex: '2', cursor: c === 'nw' || c === 'se' ? 'nwse-resize' : 'nesw-resize' },
  }, bracket(c)));
  const stage = h('div', { style: { position: 'relative', margin: '0 auto', touchAction: 'pan-y', userSelect: 'none', webkitUserSelect: 'none', webkitTouchCallout: 'none' } }, cvs, clip, handles);
  const wrap = h('div', { style: { padding: '16px 14px', background: '#16131F', borderRadius: '14px' } }, stage);
  const info = h('span', { class: 'muted small', style: { fontWeight: '600' } });
  const reset = button('Reset', () => { if (S.src) { rect = ratioRect(S.src.w, S.src.h, ratio); render(); } }, { variant: 'ghost', small: true });
  const ratioSeg = chipSeg(Object.keys(RATIOS).map(r => [r, r === 'free' ? 'Free' : r]), 'free', v => {
    ratio = RATIOS[v];
    if (S.src && ratio) rect = ratioRect(S.src.w, S.src.h, ratio);
    render();
  }, 4);
  const editor = card({ title: 'Crop', sub: 'Drag the box to move it, drag a corner to resize.' },
    ratioSeg, wrap,
    h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px' } }, info, reset));
  editor.classList.add('hidden');

  async function layout() {
    if (!S.src || editor.classList.contains('hidden')) return;
    const availW = Math.max(120, wrap.clientWidth - 28);
    const maxH = Math.min(window.innerHeight * 0.58, 560);
    const s = Math.min(availW / S.src.w, maxH / S.src.h);
    const dw = Math.max(1, Math.floor(S.src.w * s)), dh = Math.max(1, Math.floor(S.src.h * s));
    k = dw / S.src.w;
    stage.style.width = dw + 'px'; stage.style.height = dh + 'px';
    const nd = Math.min(2, window.devicePixelRatio || 1);
    if (cvs.width !== Math.round(dw * nd) || nd !== dpr) {
      dpr = nd;
      const t = await drawHQ(S.src.canvas, Math.round(dw * nd), Math.round(dh * nd));
      cvs.width = t.width; cvs.height = t.height;
      ctxOf(cvs).drawImage(t, 0, 0);
      free(t);
    }
    render();
  }
  function render() {
    if (!S.src || !rect) return;
    const L = rect.x * k, T = rect.y * k, Wd = rect.w * k, Hd = rect.h * k;
    Object.assign(box.style, { left: L + 'px', top: T + 'px', width: Wd + 'px', height: Hd + 'px' });
    const pos = { nw: [L, T], ne: [L + Wd, T], sw: [L, T + Hd], se: [L + Wd, T + Hd] };
    for (const hd of handles) { const [x, y] = pos[hd.dataset.c]; hd.style.left = x + 'px'; hd.style.top = y + 'px'; }
    const ir = intRect(rect, S.src.w, S.src.h, ratio);
    info.textContent = `${ir.w} × ${ir.h} px`;
  }
  const start = (e, mode) => {
    if (drag || !S.src || !rect) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* old browsers */ }
    drag = { id: e.pointerId, mode, x0: e.clientX, y0: e.clientY, r0: { ...rect } };
  };
  box.addEventListener('pointerdown', e => start(e, 'move'));
  for (const hd of handles) hd.addEventListener('pointerdown', e => start(e, hd.dataset.c));
  stage.addEventListener('pointermove', e => {
    if (!drag || e.pointerId !== drag.id) return;
    e.preventDefault();
    const dx = (e.clientX - drag.x0) / k, dy = (e.clientY - drag.y0) / k, { w: W, h: H } = S.src, r0 = drag.r0;
    if (drag.mode === 'move') rect = moveRect(r0, dx, dy, W, H);
    else {
      const c = drag.mode;
      const cx = (c[1] === 'w' ? r0.x : r0.x + r0.w) + dx, cy = (c[0] === 'n' ? r0.y : r0.y + r0.h) + dy;
      rect = dragCorner(r0, c, cx, cy, W, H, ratio, Math.min(48 / k, W, H));
    }
    render();
  });
  const end = e => { if (drag && e.pointerId === drag.id) drag = null; };
  stage.addEventListener('pointerup', end);
  stage.addEventListener('pointercancel', end);
  for (const el of [box, ...handles]) el.addEventListener('lostpointercapture', end);
  let raf = 0;
  const onResize = () => {
    if (!root.isConnected) { removeEventListener('resize', onResize); return; }
    cancelAnimationFrame(raf); raf = requestAnimationFrame(() => { layout().catch(() => {}); });
  };
  addEventListener('resize', onResize);

  const go = button('Crop', () => run(go, async p => {
    p.set(null, 'Cropping…');
    const ir = intRect(rect, S.src.w, S.src.h, ratio);
    const c = newCanvas(ir.w, ir.h);
    ctxOf(c).drawImage(S.src.canvas, ir.x, ir.y, ir.w, ir.h, 0, 0, ir.w, ir.h);
    const enc = await encodeAs(c, keepType(S.file.type), 0.92);
    free(c);
    return resultCard({
      title: 'Cropped', blob: enc.blob, filename: outName(S.file, 'cropped', enc.ext), before: S.file.size,
      note: [`${ir.w} × ${ir.h} px at full resolution · ${typeName(enc.type)}`, capNote(S.src), enc.note].filter(Boolean).join('. '),
    });
  }), { full: true });

  root.append(
    photoCard(S, {
      preview: false,
      onLoad: async (_, src) => {
        rect = ratioRect(src.w, src.h, ratio);
        editor.classList.remove('hidden');
        dpr = 0;
        await layout();
      },
      onClear: () => { out.replaceChildren(); editor.classList.add('hidden'); rect = null; drag = null; },
    }),
    editor, go, out);
}

/* ───────────────────────────── imgrotate ───────────────────────────── */

async function rotateImage(root) {
  const S = photoState(), out = h('div'), run = runner(S, out);
  let M = ORIENT_ID, prev = null;
  const pc = previewEl(h('canvas'), '46vh');
  pc.style.transition = 'opacity .15s';
  const info = h('div', { class: 'muted small', style: { textAlign: 'center', fontWeight: '600' } });
  const draw = () => {
    if (!prev) return;
    const [pw, ph] = orientSize(M, prev.width, prev.height);
    pc.width = pw; pc.height = ph;
    const x = ctxOf(pc);
    x.setTransform(M[0], M[1], M[2], M[3], pw / 2, ph / 2);
    x.drawImage(prev, -prev.width / 2, -prev.height / 2);
    x.setTransform(1, 0, 0, 1, 0, 0);
    info.textContent = describeOrient(M);
  };
  const op = (key, label, icon, aria) => {
    const b = button(label, () => { M = orientMul(ORIENT_OPS[key], M); draw(); }, { variant: 'ghost', icon });
    b.style.padding = '12px 6px';
    if (aria) b.setAttribute('aria-label', aria);
    return b;
  };
  const grid = (cols, ...kids) => h('div', { style: { display: 'grid', gridTemplateColumns: `repeat(${cols}, 1fr)`, gap: '8px' } }, ...kids);
  const editor = card({ title: 'Rotate or flip' },
    h('div', { style: { background: 'var(--surface-2)', borderRadius: '14px', padding: '14px', minHeight: '120px', display: 'grid', placeItems: 'center' } }, pc),
    info,
    grid(3, op('left', 'Left', '↺', 'Rotate 90° left'), op('right', 'Right', '↻', 'Rotate 90° right'), op('half', '180°', '⟳', 'Rotate 180°')),
    grid(2, op('flipH', 'Flip ↔', '', 'Flip horizontal (mirror)'), op('flipV', 'Flip ↕', '', 'Flip vertical')),
    button('Reset', () => { M = ORIENT_ID; draw(); }, { variant: 'ghost', small: true }));
  editor.classList.add('hidden');

  const go = button('Save rotated photo', () => run(go, async p => {
    if (M.every((v, i) => v === ORIENT_ID[i])) return notice('Nothing has changed yet — tap a rotate or flip button first.', 'warn');
    p.set(null, 'Rotating…');
    const { canvas: src, w, h: H } = S.src;
    const [ow, oh] = orientSize(M, w, H);
    const c = newCanvas(ow, oh), x = ctxOf(c);
    x.setTransform(M[0], M[1], M[2], M[3], ow / 2, oh / 2);
    x.drawImage(src, -w / 2, -H / 2);
    x.setTransform(1, 0, 0, 1, 0, 0);
    const enc = await encodeAs(c, keepType(S.file.type), 0.92);
    free(c);
    return resultCard({
      title: describeOrient(M), blob: enc.blob, filename: outName(S.file, 'rotated', enc.ext), before: S.file.size,
      note: [`${ow} × ${oh} px · ${typeName(enc.type)}`, enc.note].filter(Boolean).join('. '),
    });
  }), { full: true });

  root.append(
    photoCard(S, {
      preview: false,
      onLoad: async () => { M = ORIENT_ID; free(prev); prev = await thumb(S.before, 900); editor.classList.remove('hidden'); draw(); },
      onClear: () => { out.replaceChildren(); editor.classList.add('hidden'); free(prev); prev = null; },
    }),
    editor, go, out);
}

/* ───────────────────────────── convert_img ───────────────────────────── */

async function convertImage(root) {
  const S = photoState(), out = h('div'), run = runner(S, out);
  let fmt = 'image/png';
  const quality = slider({ label: 'Quality', min: 10, max: 100, value: 90, fmt: v => v + '%', ends: ['Smaller file', 'Better quality'] });
  const qBox = h('div', { class: 'hidden' }, quality.el);
  const webpWarn = h('div', { class: 'hidden' }, notice('This browser (Safari) can’t create WebP files. You’ll get a JPEG instead — or a PNG if the image has transparency.', 'warn'));
  const HINT = { 'image/jpeg': 'JPG: smallest for photos. Transparent areas become white.', 'image/png': 'PNG: lossless and keeps transparency, but larger.', 'image/webp': 'WebP: small and keeps transparency.' };
  const hint = h('div', { class: 'faint small' });
  const sync = async () => {
    qBox.classList.toggle('hidden', fmt === 'image/png');
    hint.textContent = HINT[fmt];
    webpWarn.classList.toggle('hidden', !(fmt === 'image/webp' && !(await canEncodeWebP())));
  };
  const seg = segmented([['image/jpeg', 'JPG'], ['image/png', 'PNG'], ['image/webp', 'WebP']], fmt, v => { fmt = v; sync(); });

  const go = button('Convert', () => run(go, async p => {
    p.set(null, 'Converting…');
    const enc = await encodeAs(S.src.canvas, fmt, quality.value / 100);
    return resultCard({
      title: `Saved as ${typeName(enc.type)}`, blob: enc.blob, filename: outName(S.file, 'converted', enc.ext), before: S.file.size,
      note: [`${S.src.w} × ${S.src.h} px${enc.type !== 'image/png' ? ` · quality ${quality.value}%` : ''}`, enc.note].filter(Boolean).join('. '),
    });
  }), { full: true });

  root.append(
    photoCard(S, {
      onLoad: file => {
        const t = (file.type || '').toLowerCase();
        fmt = t === 'image/png' || t === 'image/webp' ? 'image/jpeg' : 'image/png';
        seg.setValue(fmt); sync();
      },
      onClear: () => out.replaceChildren(),
    }),
    card({ title: 'Convert to' }, seg, hint, qBox, webpWarn),
    go, out);
  sync();
}

/* ─────────────────────────────── enhance ─────────────────────────────── */

async function enhanceImage(root) {
  const S = photoState(), out = h('div'), run = runner(S, out);
  let up = '2', sharp = '1', levels = '1';
  const upSeg = segmented([['2', '2×'], ['1', 'Same']], up, v => { up = v; });
  const shSeg = segmented([['0', 'Off'], ['1', 'Mild'], ['2', 'Strong']], sharp, v => { sharp = v; });
  const lvSeg = segmented([['1', 'On'], ['0', 'Off']], levels, v => { levels = v; });

  const go = button('Enhance', () => run(go, async p => {
    if (up === '1' && sharp === '0' && levels === '0') return notice('Turn on at least one option above.', 'warn');
    const { canvas: src, w: W0, h: H0 } = S.src;
    const long = Math.max(W0, H0);
    // 2× stops at 3200 px on the long side; a photo already at (or near) that size keeps its own size
    let factor = up === '2' ? Math.min(2, WORK.enhanceMax / long) : 1;
    const skippedUp = up === '2' && factor < 1.05;
    if (factor < 1.05) factor = 1;
    const W1 = Math.max(1, Math.round(W0 * factor)), H1 = Math.max(1, Math.round(H0 * factor));
    const y = yieldWith(p, 0.45, 0.9);
    p.set(0.1, factor > 1.05 ? 'Enlarging…' : 'Preparing…');
    const c = await drawHQ(src, W1, H1, { bg: '#fff' });
    const img = getData(c);
    const done = [];
    if (factor > 1.05) done.push(`enlarged ${factor.toFixed(factor >= 1.995 ? 0 : 2)}×`);
    if (levels === '1') {
      p.set(0.35, 'Balancing colours…');
      applyLUT(img.data, levelsLUT(img.data));
      done.push('colours balanced');
    }
    if (sharp !== '0') {
      p.set(0.45, 'Sharpening…');
      await unsharp3(img.data, W1, H1, sharp === '2' ? 1.15 : 0.6, 2, y);
      done.push(sharp === '2' ? 'strongly sharpened' : 'gently sharpened');
    }
    p.set(0.92, 'Saving…');
    ctxOf(c, true).putImageData(img, 0, 0);
    const blob = await canvasToBlob(c, 'image/jpeg', 0.93);
    free(c);
    const rc = await resultCard({
      title: 'Enhanced', blob, filename: outName(S.file, 'enhanced', 'jpg'), before: S.file.size,
      note: [`${W0} × ${H0} → ${W1} × ${H1} px · ${done.join(', ') || 'saved'}`,
        skippedUp && 'Your photo is already large, so it wasn’t enlarged further', capNote(S.src)].filter(Boolean).join('. '),
    });
    return addBeforeAfter(rc, S.before, S.bag);
  }), { full: true });

  root.append(
    photoCard(S, { sub: 'A basic, honest enhance: enlarge, sharpen and balance colours. It can’t invent detail that isn’t in the photo.', onClear: () => out.replaceChildren() }),
    card({ title: 'Options' },
      optionRow('Upscale', 'Up to 3200 px on the long side', upSeg),
      optionRow('Sharpen', 'Crisper edges', shSeg),
      optionRow('Auto colour & contrast', 'Gently fixes dull or tinted photos', lvSeg),
      notice(h('span', {}, 'For AI face restoration and true 4K, use ', h('a', { href: '#/tool/restore' }, '‘AI restore old photo’'), ' in the Telegram bot.'), 'info')),
    go, out);
}

/* ────────────────────────────── stripmeta ────────────────────────────── */

async function stripMeta(root) {
  const S = photoState(), out = h('div'), run = runner(S, out);
  let meta = null;
  const report = h('div');

  const camera = m => {
    const make = m.make, model = m.model;
    if (!make && !model) return '';
    return model && make && model.toLowerCase().startsWith(make.toLowerCase()) ? model : [make, model].filter(Boolean).join(' ');
  };
  const others = m => [m.exif && 'EXIF', m.xmp && 'XMP', m.iptc && 'IPTC', m.comment && 'comment', m.text && `${m.text} text note${m.text > 1 ? 's' : ''}`].filter(Boolean);

  function showReport(file, m) {
    const cam = camera(m), tags = others(m);
    const any = m.exif || m.xmp || m.iptc || m.comment || m.text;
    const lead = m.gps
      ? notice(h('div', {}, h('b', {}, 'This photo contains its location. '), 'Anyone you send the original file to can see where it was taken.'), 'warn')
      : any ? notice('No location found, but the photo carries other hidden details.', 'info')
        : notice('No hidden details found. You can still save a clean copy to be sure.', 'ok');
    report.replaceChildren(card({ title: 'What’s hidden in this photo' }, lead, kvList([
      ['Location (GPS)', m.gps ? (m.lat != null ? fmtLatLon(m.lat, m.lon) : 'Yes') : 'None found', m.gps ? 'warn' : 'ok'],
      ['Camera', cam || 'None found', cam ? 'warn' : ''],
      ['Date taken', m.taken ? fmtExifDate(m.taken) : 'None found', m.taken ? 'warn' : ''],
      m.software && ['Software', m.software],
      ['Metadata blocks', tags.length ? tags.join(', ') : 'None'],
      ['File type', `${m.format} · ${fmtBytes(file.size)}`],
    ])));
  }

  const go = button('Remove all metadata', () => run(go, async p => {
    p.set(null, 'Re-saving without metadata…');
    const want = keepType(S.file.type);
    // Re-encoding via canvas writes pixels only: EXIF, GPS, XMP, IPTC and comments are all dropped.
    const enc = await encodeAs(S.src.canvas, want, 0.95);
    // Check what the new file still says. Safari's encoder adds its own tiny EXIF block (pixel
    // size, colour space) and an empty IPTC record; parseMeta doesn't count those.
    const check = parseMeta(new Uint8Array(await enc.blob.arrayBuffer()));
    const left = [check.gps && 'location', camera(check) && 'camera', check.taken && 'date', check.software && 'software',
      others(check).length && 'other tags'].filter(Boolean);
    const clean = !left.length;
    const m = meta || {};
    const cam = camera(m);
    const headline = !clean ? 'Some details remain' : m.gps ? 'Location removed ✓' : 'Metadata removed ✓';
    const row = (k, had, still) => [k, still ? 'Still in the file' : had ? 'Removed ✓' : 'None to remove ✓', still ? 'warn' : 'ok'];
    const nodes = [
      notice(h('div', {}, h('b', {}, headline), h('div', {}, clean ? 'We checked the new file: no location, camera or date details are left.' : `We checked the new file and these are still in it: ${left.join(', ')}.`)), clean ? 'ok' : 'warn'),
      card(kvList([
        row('Location', m.gps, check.gps),
        row('Camera details', cam, camera(check)),
        row('Date & other tags', m.taken || m.software || others(m).length, check.taken || check.software || others(check).length),
      ])),
      await resultCard({
        title: 'Clean copy ready', blob: enc.blob, filename: outName(S.file, 'clean', enc.ext), before: S.file.size,
        note: [`${S.src.w} × ${S.src.h} px · ${typeName(enc.type)}, re-saved at high quality`,
          capNote(S.src), enc.note].filter(Boolean).join('. '),
      }),
    ];
    return nodes;
  }), { full: true });

  root.append(
    photoCard(S, {
      sub: 'Photos can hide where and when they were taken, and on which phone.',
      onLoad: async file => {
        meta = parseMeta(new Uint8Array(await file.arrayBuffer()));
        showReport(file, meta);
      },
      onClear: () => { meta = null; report.replaceChildren(); out.replaceChildren(); },
    }),
    report, go, out);
}

/* ───────────────────────────── routing ───────────────────────────── */

const TOOLS = {
  removebg: removeBg,
  imgcompress: compressImage,
  resize: resizeImage,
  crop: cropImage,
  imgrotate: rotateImage,
  convert_img: convertImage,
  enhance: enhanceImage,
  blurbg: blurBg,
  stripmeta: stripMeta,
};
