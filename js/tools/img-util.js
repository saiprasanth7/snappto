// Shared pixel + canvas helpers for image.js and signature.js.
//
// Everything in the PURE section works on plain typed arrays (no DOM), so it
// can be unit-tested in node. Nothing in this file runs at import time.
//
// Why hand-written blur/sharpen: CanvasRenderingContext2D.filter is missing or
// unreliable in iPhone Safari, so every pixel effect is done on ImageData here.
import { h, segmented, canvasToBlob, loadImage, tick } from '../ui.js';

/* ════════════════════════════ PURE ════════════════════════════ */

/** iOS Safari refuses canvases above 16,777,216 px; stay safely under. */
export const MAX_AREA = 16_000_000;

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const now = () => (globalThis.performance && performance.now ? performance.now() : Date.now());
const NOY = async () => {};

/** Returns an async fn to call inside long loops: yields to the browser every ~budget ms. */
export function yielder(budget = 28, onYield) {
  let last = now();
  return async () => {
    const t = now();
    if (t - last > budget) { if (onYield) onYield(); await tick(); last = now(); }
  };
}

/** Parse "12", "12.5", "12,5" → number (NaN if empty). */
export function num(v) { return parseFloat(String(v ?? '').trim().replace(',', '.')); }

/** Scale (w,h) down so the long side ≤ maxSide (never up). */
export function fitWithin(w, h, maxSide) {
  const s = maxSide && Math.max(w, h) > maxSide ? maxSide / Math.max(w, h) : 1;
  return { w: Math.max(1, Math.round(w * s)), h: Math.max(1, Math.round(h * s)), scale: s };
}

/** Scale (w,h) down so w·h ≤ maxArea. */
export function capArea(w, h, maxArea = MAX_AREA) {
  const s = w * h > maxArea ? Math.sqrt(maxArea / (w * h)) : 1;
  return { w: Math.max(1, Math.floor(w * s)), h: Math.max(1, Math.floor(h * s)), scale: s };
}

/** Largest (w,h) with the aspect of (sw,sh) that fits inside (bw,bh), centred. */
export function fitContain(sw, sh, bw, bh) {
  const s = Math.min(bw / sw, bh / sh);
  const w = clamp(Math.round(sw * s), 1, bw), h = clamp(Math.round(sh * s), 1, bh);
  return { w, h, x: Math.floor((bw - w) / 2), y: Math.floor((bh - h) / 2), scale: s };
}

/**
 * Intermediate sizes for a high-quality resize. Shrinking: halve each axis while it
 * is > 2× its target (browsers alias badly on big one-step shrinks). Enlarging by
 * > 1.3×: one geometric midpoint. Always ends with [dw, dh].
 */
export function scaleSteps(sw, sh, dw, dh) {
  const steps = [];
  let w = sw, h = sh;
  while (w > dw * 2 || h > dh * 2) {
    if (w > dw * 2) w = Math.ceil(w / 2);
    if (h > dh * 2) h = Math.ceil(h / 2);
    steps.push([w, h]);
  }
  if (dw > w * 1.3 || dh > h * 1.3) {
    const mw = dw > w * 1.3 ? Math.round(Math.sqrt(w * dw)) : dw;
    const mh = dh > h * 1.3 ? Math.round(Math.sqrt(h * dh)) : dh;
    steps.push([mw, mh]);
  }
  steps.push([dw, dh]);
  return steps;
}

/** Next downscale factor when a JPEG at the quality floor is still too big (≈15 % steps, bigger when far off). */
export function nextScale(scale, size, target) {
  return scale * clamp(Math.sqrt(target / size) * 0.95, 0.5, 0.85);
}

/* ── blur ── */

/** Box radii whose 3 successive passes approximate a Gaussian of `sigma` (Kutskir). */
export function boxesForGauss(sigma, n = 3) {
  const wIdeal = Math.sqrt((12 * sigma * sigma) / n + 1);
  let wl = Math.floor(wIdeal); if (wl % 2 === 0) wl--;
  const wu = wl + 2;
  const m = Math.round((12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4));
  const r = [];
  for (let i = 0; i < n; i++) r.push(((i < m ? wl : wu) - 1) / 2);
  return r;
}

async function boxH(src, dst, w, h, r, y_) {
  const inv = 1 / (2 * r + 1), wm = w - 1;
  for (let y = 0; y < h; y++) {
    const o = y * w;
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += src[o + (k < 0 ? 0 : k > wm ? wm : k)];
    for (let x = 0; x < w; x++) {
      dst[o + x] = acc * inv;
      const a = x + r + 1, s = x - r;
      acc += src[o + (a > wm ? wm : a)] - src[o + (s < 0 ? 0 : s)];
    }
    if ((y & 31) === 31) await y_();
  }
}
async function boxV(src, dst, w, h, r, y_) {
  const inv = 1 / (2 * r + 1), hm = h - 1;
  const acc = new Float64Array(w);
  for (let k = -r; k <= r; k++) {
    const o = (k < 0 ? 0 : k > hm ? hm : k) * w;
    for (let x = 0; x < w; x++) acc[x] += src[o + x];
  }
  for (let y = 0; y < h; y++) {
    const o = y * w;
    const ao = (y + r + 1 > hm ? hm : y + r + 1) * w, so = (y - r < 0 ? 0 : y - r) * w;
    for (let x = 0; x < w; x++) { dst[o + x] = acc[x] * inv; acc[x] += src[ao + x] - src[so + x]; }
    if ((y & 31) === 31) await y_();
  }
}

/** In-place Gaussian-like blur of a float plane (3 box passes, edges extended). O(n) for any sigma. */
export async function blurPlane(p, w, h, sigma, y_ = NOY, tmp) {
  if (!(sigma > 0.3)) return p;
  tmp = tmp && tmp.length >= p.length ? tmp : new Float32Array(p.length);
  for (const r of boxesForGauss(sigma, 3)) {
    if (r < 1) continue;
    await boxH(p, tmp, w, h, r, y_);
    await boxV(tmp, p, w, h, r, y_);
  }
  return p;
}

/** Mean over the (2r+1)² window clipped to the image (exact counts at borders). */
export async function boxMean(src, w, h, r, out = new Float32Array(w * h), y_ = NOY) {
  const tmp = new Float32Array(w * h);
  const pre = new Float64Array(w + 1);
  for (let y = 0; y < h; y++) {
    const o = y * w;
    for (let x = 0; x < w; x++) pre[x + 1] = pre[x] + src[o + x];
    for (let x = 0; x < w; x++) {
      const lo = x - r < 0 ? 0 : x - r, hi = x + r > w - 1 ? w - 1 : x + r;
      tmp[o + x] = (pre[hi + 1] - pre[lo]) / (hi - lo + 1);
    }
    if ((y & 63) === 63) await y_();
  }
  const acc = new Float64Array(w);
  let top = 0, bot = -1;
  for (let y = 0; y < h; y++) {
    const lo = y - r < 0 ? 0 : y - r, hi = y + r > h - 1 ? h - 1 : y + r;
    while (bot < hi) { bot++; const o = bot * w; for (let x = 0; x < w; x++) acc[x] += tmp[o + x]; }
    while (top < lo) { const o = top * w; for (let x = 0; x < w; x++) acc[x] -= tmp[o + x]; top++; }
    const inv = 1 / (hi - lo + 1), o = y * w;
    for (let x = 0; x < w; x++) out[o + x] = acc[x] * inv;
    if ((y & 63) === 63) await y_();
  }
  return out;
}

/** Luma plane in 0..1 from RGBA bytes. */
export function lumaPlane(rgba, n) {
  const out = new Float32Array(n);
  for (let i = 0, o = 0; i < n; i++, o += 4) out[i] = (0.299 * rgba[o] + 0.587 * rgba[o + 1] + 0.114 * rgba[o + 2]) / 255;
  return out;
}

/**
 * Guided filter (He et al.) coefficients: q = A·I + B follows the edges of guide I
 * while staying close to p. Returns window-averaged A, B at the guide's size.
 */
export async function guidedAB(I, p, w, h, r, eps, y_ = NOY) {
  const n = w * h;
  const mI = await boxMean(I, w, h, r, undefined, y_);
  const mP = await boxMean(p, w, h, r, undefined, y_);
  const t = new Float32Array(n);
  for (let i = 0; i < n; i++) t[i] = I[i] * I[i];
  const mII = await boxMean(t, w, h, r, undefined, y_);
  for (let i = 0; i < n; i++) t[i] = I[i] * p[i];
  const mIP = await boxMean(t, w, h, r, undefined, y_);
  const a = new Float32Array(n), b = t;            // reuse t for b
  for (let i = 0; i < n; i++) {
    const varI = mII[i] - mI[i] * mI[i], cov = mIP[i] - mI[i] * mP[i];
    a[i] = cov / (varI + eps);
    b[i] = mP[i] - a[i] * mI[i];
  }
  return { A: await boxMean(a, w, h, r, mII, y_), B: await boxMean(b, w, h, r, mIP, y_) };
}

/** Bilinear lookup tables mapping `dst` pixels onto a `src`-sized grid (pixel centres aligned). */
export function bilinearAxis(src, dst) {
  const i0 = new Int32Array(dst), i1 = new Int32Array(dst), f = new Float32Array(dst);
  const s = src / dst;
  for (let x = 0; x < dst; x++) {
    let g = (x + 0.5) * s - 0.5;
    if (g < 0) g = 0; if (g > src - 1) g = src - 1;
    const a = Math.floor(g);
    i0[x] = a; i1[x] = Math.min(a + 1, src - 1); f[x] = g - a;
  }
  return { i0, i1, f };
}

/** Bilinear resample of a float plane. */
export function resamplePlane(src, sw, sh, dw, dh) {
  const out = new Float32Array(dw * dh), X = bilinearAxis(sw, dw), Y = bilinearAxis(sh, dh);
  for (let y = 0; y < dh; y++) {
    const r0 = Y.i0[y] * sw, r1 = Y.i1[y] * sw, fy = Y.f[y];
    for (let x = 0; x < dw; x++) {
      const a = X.i0[x], b = X.i1[x], fx = X.f[x];
      const top = src[r0 + a] + (src[r0 + b] - src[r0 + a]) * fx;
      const bot = src[r1 + a] + (src[r1 + b] - src[r1 + a]) * fx;
      out[y * dw + x] = top + (bot - top) * fy;
    }
  }
  return out;
}

/**
 * Edge-aware upsampling of a low-res matte: q = bilinear(A)·I_full + bilinear(B),
 * with I_full the luma of the full-size RGBA. Clamped to 0..1.
 */
export async function guidedUpsample(A, B, gw, gh, rgba, W, H, y_ = NOY) {
  const q = new Float32Array(W * H), X = bilinearAxis(gw, W), Y = bilinearAxis(gh, H);
  for (let y = 0; y < H; y++) {
    const r0 = Y.i0[y] * gw, r1 = Y.i1[y] * gw, fy = Y.f[y], o = y * W;
    for (let x = 0; x < W; x++) {
      const a = X.i0[x], b = X.i1[x], fx = X.f[x];
      const at = A[r0 + a] + (A[r0 + b] - A[r0 + a]) * fx, ab = A[r1 + a] + (A[r1 + b] - A[r1 + a]) * fx;
      const bt = B[r0 + a] + (B[r0 + b] - B[r0 + a]) * fx, bb = B[r1 + a] + (B[r1 + b] - B[r1 + a]) * fx;
      const p = (o + x) * 4;
      const I = (0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2]) / 255;
      const v = (at + (ab - at) * fy) * I + (bt + (bb - bt) * fy);
      q[o + x] = v < 0 ? 0 : v > 1 ? 1 : v;
    }
    if ((y & 31) === 31) await y_();
  }
  return q;
}

/** In-place smoothstep ramp: ≤lo → 0, ≥hi → 1. */
export function rampPlane(p, lo, hi) {
  const inv = 1 / Math.max(1e-6, hi - lo);
  for (let i = 0; i < p.length; i++) {
    let t = (p[i] - lo) * inv; t = t < 0 ? 0 : t > 1 ? 1 : t;
    p[i] = t * t * (3 - 2 * t);
  }
  return p;
}

/**
 * Background colour estimate that ignores the person (normalized convolution):
 * blur(C·w)/blur(w) with w = (1−alpha)³, done on a d×-reduced grid for speed.
 * Returns float planes R,G,B (0..255) at (bw,bh) plus d. Sample with bilinearAxis.
 */
export async function maskedBlurField(rgba, W, H, alpha, sigma, y_ = NOY) {
  const d = Math.max(1, Math.floor(sigma / 5));
  const bw = Math.ceil(W / d), bh = Math.ceil(H / d), n = bw * bh;
  const R = new Float32Array(n), G = new Float32Array(n), B = new Float32Array(n), Wt = new Float32Array(n), C = new Float32Array(n);
  for (let y = 0; y < H; y++) {
    const row = Math.floor(y / d) * bw;
    for (let x = 0; x < W; x++) {
      const i = y * W + x, p = i * 4, k = row + Math.floor(x / d);
      const m = 1 - alpha[i], wt = m * m * m + 1e-3;
      R[k] += rgba[p] * wt; G[k] += rgba[p + 1] * wt; B[k] += rgba[p + 2] * wt; Wt[k] += wt; C[k]++;
    }
    if ((y & 63) === 63) await y_();
  }
  for (let k = 0; k < n; k++) { const c = C[k] || 1; R[k] /= c; G[k] /= c; B[k] /= c; Wt[k] /= c; }
  const s = sigma / d, tmp = new Float32Array(n);
  for (const P of [R, G, B, Wt]) await blurPlane(P, bw, bh, s, y_, tmp);
  for (let k = 0; k < n; k++) { const wt = Wt[k] > 1e-6 ? Wt[k] : 1e-6; R[k] /= wt; G[k] /= wt; B[k] /= wt; }
  return { R, G, B, bw, bh, d };
}

/* ── sharpen & levels ── */

/**
 * 3×3 unsharp mask, in place: p + amount·(p − blur3x3(p)), skipping |diff| ≤ threshold
 * (keeps noise down). RGB only; alpha untouched. Keeps just two original rows aside, so a
 * 16 MP photo needs no second full-size buffer. Returns px.
 */
export async function unsharp3(px, w, h, amount = 0.6, threshold = 2, y_ = NOY) {
  const W4 = w * 4;
  let above = px.slice(0, W4), cur = px.slice(0, W4);   // original rows y−1 and y
  for (let y = 0; y < h; y++) {
    const y0 = y * W4, below = y < h - 1 ? px.subarray(y0 + W4, y0 + 2 * W4) : cur;   // row y+1 is still original
    for (let x = 0; x < w; x++) {
      const xm = (x > 0 ? x - 1 : 0) * 4, x0 = x * 4, xp = (x < w - 1 ? x + 1 : x) * 4;
      for (let c = 0; c < 3; c++) {
        const p = cur[x0 + c];
        const b = (above[xm + c] + 2 * above[x0 + c] + above[xp + c] +
          2 * cur[xm + c] + 4 * p + 2 * cur[xp + c] +
          below[xm + c] + 2 * below[x0 + c] + below[xp + c]) / 16;
        const d = p - b;
        px[y0 + x0 + c] = d > threshold || d < -threshold ? p + amount * d : p;
      }
    }
    if (y < h - 1) { const t = above; above = cur; cur = t; cur.set(below); }
    if ((y & 15) === 15) await y_();
  }
  return px;
}

function percentile(hist, total, p) {
  const target = p * total; let cum = 0;
  for (let v = 0; v < 256; v++) { cum += hist[v]; if (cum > target) return v; }
  return 255;
}

/**
 * Gentle per-channel auto-levels: stretch the 0.5 % / 99.5 % percentiles towards
 * 0 / 255, but never clip harder than lo ≤ 80 / hi ≥ 175, and blend with the
 * original by `strength`. Returns [lutR, lutG, lutB] (256 entries each).
 */
export function levelsLUT(rgba, { lowPct = 0.005, highPct = 0.995, strength = 0.6 } = {}) {
  const n = rgba.length >> 2, stride = Math.max(1, Math.floor(n / 1_000_000));
  const hist = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
  let count = 0;
  for (let i = 0; i < n; i += stride) {
    const o = i << 2; if (rgba[o + 3] < 128) continue;
    hist[0][rgba[o]]++; hist[1][rgba[o + 1]]++; hist[2][rgba[o + 2]]++; count++;
  }
  return hist.map(hc => {
    const lut = new Uint8ClampedArray(256);
    let lo = count ? percentile(hc, count, lowPct) : 0, hi = count ? percentile(hc, count, highPct) : 255;
    lo = Math.min(lo, 80); hi = Math.max(hi, 175);
    for (let v = 0; v < 256; v++) {
      const s = clamp(((v - lo) * 255) / (hi - lo), 0, 255);
      lut[v] = v + strength * (s - v);
    }
    return lut;
  });
}

export function applyLUT(rgba, luts) {
  const [r, g, b] = luts;
  for (let o = 0; o < rgba.length; o += 4) { rgba[o] = r[rgba[o]]; rgba[o + 1] = g[rgba[o + 1]]; rgba[o + 2] = b[rgba[o + 2]]; }
  return rgba;
}

/* ── signature helpers ── */

/**
 * Paper brightness per pixel (handles shadows and uneven light): the `pct`
 * percentile of each block on a coarse grid (ink is a small minority, so this
 * is the paper), lightly smoothed, then bilinearly interpolated. gray: 0..255.
 */
export function paperMap(gray, w, h, { cells = 28, pct = 0.9 } = {}) {
  const bs = Math.max(8, Math.round(Math.max(w, h) / cells));
  const gw = Math.ceil(w / bs), gh = Math.ceil(h / bs);
  const grid = new Float32Array(gw * gh), hist = new Uint32Array(256);
  for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) {
    hist.fill(0);
    const x0 = gx * bs, x1 = Math.min(w, x0 + bs), y0 = gy * bs, y1 = Math.min(h, y0 + bs);
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const v = gray[y * w + x]; hist[v > 255 ? 255 : v < 0 ? 0 : v | 0]++; }
    grid[gy * gw + gx] = percentile(hist, (x1 - x0) * (y1 - y0), pct) + 0.5;
  }
  // light [1 2 1] smoothing so block seams never show
  const sm = new Float32Array(gw * gh);
  for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) {
    let s = 0, wsum = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const yy = gy + dy, xx = gx + dx;
      if (yy < 0 || yy >= gh || xx < 0 || xx >= gw) continue;
      const k = (dx ? 1 : 2) * (dy ? 1 : 2); s += grid[yy * gw + xx] * k; wsum += k;
    }
    sm[gy * gw + gx] = s / wsum;
  }
  // upsample: block centres sit at (g+0.5)·bs
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    let fy = (y + 0.5) / bs - 0.5; fy = clamp(fy, 0, gh - 1);
    const y0 = Math.floor(fy), y1 = Math.min(y0 + 1, gh - 1), ty = fy - y0;
    for (let x = 0; x < w; x++) {
      let fx = (x + 0.5) / bs - 0.5; fx = clamp(fx, 0, gw - 1);
      const x0 = Math.floor(fx), x1 = Math.min(x0 + 1, gw - 1), tx = fx - x0;
      const a = sm[y0 * gw + x0] + (sm[y0 * gw + x1] - sm[y0 * gw + x0]) * tx;
      const b = sm[y1 * gw + x0] + (sm[y1 * gw + x1] - sm[y1 * gw + x0]) * tx;
      out[y * w + x] = a + (b - a) * ty;
    }
  }
  return out;
}

/**
 * Otsu threshold for values in [0,1] (256 bins). Returns the split value.
 * When classes are separated by an empty gap every split inside it ties; we take
 * the middle of that plateau instead of hugging the lower class.
 */
export function otsu(values, bins = 256) {
  const hist = new Float64Array(bins);
  for (let i = 0; i < values.length; i++) { const v = values[i]; hist[clamp(Math.floor(v * bins), 0, bins - 1)]++; }
  const total = values.length;
  let sumAll = 0; for (let i = 0; i < bins; i++) sumAll += i * hist[i];
  const between = new Float64Array(bins);
  let wB = 0, sumB = 0, best = -1, bestT = 0;
  for (let t = 0; t < bins; t++) {
    wB += hist[t]; sumB += t * hist[t];
    const wF = total - wB;
    if (!wB || !wF) continue;
    const mB = sumB / wB, mF = (sumAll - sumB) / wF;
    between[t] = wB * wF * (mB - mF) * (mB - mF);
    if (between[t] > best) { best = between[t]; bestT = t; }
  }
  let a = bestT, b = bestT;
  while (b + 1 < bins && between[b + 1] >= best * (1 - 1e-9)) b++;
  while (a - 1 >= 0 && between[a - 1] >= best * (1 - 1e-9)) a--;
  return ((a + b) / 2 + 1) / bins;
}

/**
 * 8-connected components of a 0/1 mask. Returns {labels:Int32Array, comps:[{area,x0,y0,x1,y1,border}]}
 * (label k ↦ comps[k-1]).
 */
export function components(mask, w, h) {
  const labels = new Int32Array(w * h), comps = [];
  const stack = new Int32Array(w * h);
  let next = 0;
  for (let s = 0; s < w * h; s++) {
    if (!mask[s] || labels[s]) continue;
    const id = ++next; let sp = 0; stack[sp++] = s; labels[s] = id;
    const c = { area: 0, x0: w, y0: h, x1: -1, y1: -1, border: false };
    while (sp) {
      const i = stack[--sp], x = i % w, y = (i - x) / w;
      c.area++;
      if (x < c.x0) c.x0 = x; if (x > c.x1) c.x1 = x; if (y < c.y0) c.y0 = y; if (y > c.y1) c.y1 = y;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) c.border = true;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy; if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx; if (xx < 0 || xx >= w) continue;
          const j = yy * w + xx;
          if (mask[j] && !labels[j]) { labels[j] = id; stack[sp++] = j; }
        }
      }
    }
    comps.push(c);
  }
  return { labels, comps };
}

/** Binary dilation (square, radius r) of a 0/1 Uint8 mask. */
export function dilate(mask, w, h, r) {
  const tmp = new Uint8Array(w * h), out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const o = y * w;
    let prev = -1e9;
    for (let x = 0; x < w; x++) { if (mask[o + x]) prev = x; if (x - prev <= r) tmp[o + x] = 1; }
    let next = 1e9;
    for (let x = w - 1; x >= 0; x--) { if (mask[o + x]) next = x; if (next - x <= r) tmp[o + x] = 1; }
  }
  for (let x = 0; x < w; x++) {
    let prev = -1e9;
    for (let y = 0; y < h; y++) { const i = y * w + x; if (tmp[i]) prev = y; if (y - prev <= r) out[i] = 1; }
    let next = 1e9;
    for (let y = h - 1; y >= 0; y--) { const i = y * w + x; if (tmp[i]) next = y; if (next - y <= r) out[i] = 1; }
  }
  return out;
}

/* ── crop geometry (source-pixel floats) ── */

/** Largest rect of aspect `ratio` (w/h) centred in W×H; ratio 0 → the whole image. */
export function ratioRect(W, H, ratio) {
  if (!ratio) return { x: 0, y: 0, w: W, h: H };
  let w = W, h = W / ratio;
  if (h > H) { h = H; w = H * ratio; }
  return { x: (W - w) / 2, y: (H - h) / 2, w, h };
}

export function moveRect(r, dx, dy, W, H) {
  return { x: clamp(r.x + dx, 0, W - r.w), y: clamp(r.y + dy, 0, H - r.h), w: r.w, h: r.h };
}

/** Drag corner c ('nw'|'ne'|'sw'|'se') of r0 to (px,py); the opposite corner stays put. */
export function dragCorner(r0, c, px, py, W, H, ratio = 0, min = 20) {
  const north = c[0] === 'n', west = c[1] === 'w';
  const ax = west ? r0.x + r0.w : r0.x, ay = north ? r0.y + r0.h : r0.y;
  const maxW = west ? ax : W - ax, maxH = north ? ay : H - ay;
  let w = west ? ax - px : px - ax, h = north ? ay - py : py - ay;
  if (ratio) {
    const cap = Math.min(maxW, maxH * ratio);
    w = Math.max(w, h * ratio);
    w = clamp(w, Math.min(Math.max(min, min * ratio), cap), cap);
    h = w / ratio;
  } else {
    w = clamp(w, Math.min(min, maxW), maxW);
    h = clamp(h, Math.min(min, maxH), maxH);
  }
  return { x: west ? ax - w : ax, y: north ? ay - h : ay, w, h };
}

/** Whole-pixel crop inside W×H; a fixed ratio is kept exact after rounding. */
export function intRect(r, W, H, ratio = 0) {
  const x = clamp(Math.round(r.x), 0, W - 1), y = clamp(Math.round(r.y), 0, H - 1);
  let w = clamp(Math.round(r.w), 1, W - x), h = clamp(Math.round(r.h), 1, H - y);
  if (ratio) {
    h = Math.round(w / ratio);
    if (h > H - y) { h = H - y; w = Math.round(h * ratio); }
    w = Math.max(1, Math.min(w, W - x)); h = Math.max(1, h);
  }
  return { x, y, w, h };
}

/* ── rotate / flip as a 2×2 integer matrix [a,b,c,d] (canvas transform order) ── */

export const ORIENT_ID = [1, 0, 0, 1];
export const ORIENT_OPS = {
  right: [0, 1, -1, 0],   // 90° clockwise (screen y points down)
  left: [0, -1, 1, 0],
  half: [-1, 0, 0, -1],
  flipH: [-1, 0, 0, 1],   // mirror left↔right
  flipV: [1, 0, 0, -1],   // mirror top↔bottom
};
/** P·M — apply M first, then P (as the user sees it on screen). */
export function orientMul(P, M) {
  return [P[0] * M[0] + P[2] * M[1], P[1] * M[0] + P[3] * M[1], P[0] * M[2] + P[2] * M[3], P[1] * M[2] + P[3] * M[3]];
}
export const orientSize = (M, w, h) => (M[0] === 0 ? [h, w] : [w, h]);
const same = (A, B) => A.every((v, i) => v === B[i]);
/** Plain-English summary, e.g. "Rotated 90° right · mirrored". */
export function describeOrient(M) {
  const mirrored = M[0] * M[3] - M[1] * M[2] < 0;
  const R = mirrored ? orientMul(M, ORIENT_OPS.flipH) : M;
  const rot = same(R, ORIENT_OPS.right) ? 'Rotated 90° right' : same(R, ORIENT_OPS.left) ? 'Rotated 90° left'
    : same(R, ORIENT_OPS.half) ? 'Rotated 180°' : '';
  if (!rot && !mirrored) return 'No changes yet';
  return [rot, mirrored && (rot ? 'mirrored' : 'Mirrored')].filter(Boolean).join(' · ');
}

/* ── photo metadata (EXIF / GPS / XMP / IPTC) ── */

const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };
/**
 * EXIF tags that only describe the pixels (size, resolution, colour space, orientation).
 * Safari's own JPEG/PNG encoder always writes a small EXIF block with a few of these.
 */
const PLAIN_TAGS = new Set([0x0100, 0x0101, 0x0102, 0x0103, 0x0106, 0x0112, 0x0115, 0x011a, 0x011b, 0x0128, 0x0213,
  0x8769, 0x9000, 0x9101, 0xa000, 0xa001, 0xa002, 0xa003]);
const ascii = (u8, o, n) => { let s = ''; for (let i = 0; i < n && o + i < u8.length; i++) s += String.fromCharCode(u8[o + i]); return s; };
function indexOfBytes(u8, str, from = 0, to = u8.length) {
  const f = str.charCodeAt(0), L = str.length;
  outer: for (let i = from; i <= to - L; i++) {
    if (u8[i] !== f) continue;
    for (let k = 1; k < L; k++) if (u8[i + k] !== str.charCodeAt(k)) continue outer;
    return i;
  }
  return -1;
}

function parseTiff(u8, t0, end, r) {
  end = Math.min(end, u8.length);
  if (t0 + 8 > end) return;
  const le = u8[t0] === 0x49 && u8[t0 + 1] === 0x49, be = u8[t0] === 0x4d && u8[t0 + 1] === 0x4d;
  if (!le && !be) return;
  const u16 = o => (le ? u8[o] | (u8[o + 1] << 8) : (u8[o] << 8) | u8[o + 1]);
  const u32 = o => (le ? (u8[o] | (u8[o + 1] << 8) | (u8[o + 2] << 16) | (u8[o + 3] << 24)) : ((u8[o] << 24) | (u8[o + 1] << 16) | (u8[o + 2] << 8) | u8[o + 3])) >>> 0;
  if (u16(t0 + 2) !== 42) return;
  const ifd = off => {
    const o = t0 + off;
    if (!off || o + 2 > end) return null;
    const cnt = u16(o);
    if (cnt > 512) return null;
    const map = new Map();
    for (let i = 0; i < cnt; i++) {
      const e = o + 2 + i * 12; if (e + 12 > end) break;
      const type = u16(e + 2), count = u32(e + 4), size = (TYPE_SIZE[type] || 1) * count;
      map.set(u16(e), { type, count, at: size <= 4 ? e + 8 : t0 + u32(e + 8) });
    }
    map.next = o + 2 + cnt * 12 + 4 <= end ? u32(o + 2 + cnt * 12) : 0;   // next IFD (IFD1 = thumbnail)
    return map;
  };
  const str = ent => {
    if (!ent || ent.type !== 2) return '';
    let s = '';
    for (let i = 0; i < Math.min(ent.count, 200) && ent.at + i < end; i++) { const c = u8[ent.at + i]; if (!c) break; s += String.fromCharCode(c); }
    return s.trim();
  };
  const rat = (ent, i) => { const o = ent.at + i * 8; if (o + 8 > end) return NaN; const d = u32(o + 4); return d ? u32(o) / d : NaN; };
  const ptr = ent => (ent && ent.at + 4 <= end ? u32(ent.at) : 0);

  const ifd0 = ifd(u32(t0 + 4));
  if (!ifd0) { r.exif = true; return; }
  r.make = r.make || str(ifd0.get(0x010f));
  r.model = r.model || str(ifd0.get(0x0110));
  r.software = r.software || str(ifd0.get(0x0131));
  let taken = str(ifd0.get(0x0132));
  const ex = ifd(ptr(ifd0.get(0x8769)));
  if (ex) taken = str(ex.get(0x9003)) || taken;
  r.taken = r.taken || taken;
  // Count the block only when it says more than the pixel basics, or carries a thumbnail.
  const plain = m => [...m.keys()].every(t => PLAIN_TAGS.has(t));
  if (!plain(ifd0) || ifd0.next || (ifd0.has(0x8769) && !(ex && plain(ex)))) r.exif = true;
  const g = ifd(ptr(ifd0.get(0x8825)));
  if (g) {
    const la = g.get(2), lo = g.get(4);
    if (la && lo && la.type === 5 && lo.type === 5 && la.count >= 3 && lo.count >= 3) {
      let lat = rat(la, 0) + rat(la, 1) / 60 + rat(la, 2) / 3600;
      let lon = rat(lo, 0) + rat(lo, 1) / 60 + rat(lo, 2) / 3600;
      if (str(g.get(1)).toUpperCase() === 'S') lat = -lat;
      if (str(g.get(3)).toUpperCase() === 'W') lon = -lon;
      if (Number.isFinite(lat) && Number.isFinite(lon) && (lat || lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
        r.gps = true; r.lat = lat; r.lon = lon;
      }
    }
  }
}

function xmpGps(u8, s, e, r) {
  r.xmp = true;
  if (indexOfBytes(u8, 'GPSLatitude', s, e) >= 0 || indexOfBytes(u8, 'GPSLongitude', s, e) >= 0) r.gps = true;
}

/**
 * Does a JPEG APP13 (Photoshop) segment hold anything? Safari's encoder writes one with
 * an empty IPTC record (8BIM 0x0404, length 0) plus its digest (0x0425); that is not data.
 */
function app13HasData(u8, s, e) {
  if (ascii(u8, s, 14) !== 'Photoshop 3.0\0') return true;
  let p = s + 14;
  while (p + 12 <= e) {
    if (ascii(u8, p, 4) !== '8BIM') return true;
    const id = (u8[p + 4] << 8) | u8[p + 5], q = p + 6 + ((u8[p + 6] + 2) & ~1);   // skip the even-padded Pascal name
    if (q + 4 > e) return true;
    const len = ((u8[q] << 24) | (u8[q + 1] << 16) | (u8[q + 2] << 8) | u8[q + 3]) >>> 0;
    if (id !== 0x0425 && !(id === 0x0404 && len === 0)) return true;
    p = q + 4 + len + (len & 1);
  }
  return false;
}

/** What kind of file the bytes really are. */
export function sniffImage(u8) {
  if (u8[0] === 0xff && u8[1] === 0xd8 && u8[2] === 0xff) return 'JPEG';
  if (u8[0] === 0x89 && ascii(u8, 1, 3) === 'PNG') return 'PNG';
  if (ascii(u8, 0, 4) === 'RIFF' && ascii(u8, 8, 4) === 'WEBP') return 'WebP';
  if (ascii(u8, 4, 4) === 'ftyp' && /hei|hev|mif1|msf1|avif/.test(ascii(u8, 8, 4))) return ascii(u8, 8, 4) === 'avif' ? 'AVIF' : 'HEIC';
  if (ascii(u8, 0, 4) === 'GIF8') return 'GIF';
  return 'Image';
}

/**
 * Scan image bytes for privacy-relevant metadata. Never throws.
 * exif / iptc are only set when those blocks hold more than an encoder's own basics
 * (pixel size, colour space, an empty IPTC record), so a clean re-save reads as clean.
 * → {format, exif, gps, lat, lon, make, model, software, taken, xmp, iptc, comment, text}
 */
export function parseMeta(u8) {
  const r = { format: sniffImage(u8), exif: false, gps: false, lat: null, lon: null, make: '', model: '', software: '', taken: '', xmp: false, iptc: false, comment: false, text: 0 };
  const n = u8.length;
  try {
    if (r.format === 'JPEG') {
      let p = 2;
      while (p + 4 <= n) {
        if (u8[p] !== 0xff) { p++; continue; }
        const m = u8[p + 1];
        if (m === 0xff) { p++; continue; }
        if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { p += 2; continue; }
        if (m === 0xd9 || m === 0xda) break;
        const len = (u8[p + 2] << 8) | u8[p + 3];
        if (len < 2) break;
        const s = p + 4, e = Math.min(n, p + 2 + len);
        if (m === 0xe1) {
          if (ascii(u8, s, 6) === 'Exif\0\0') parseTiff(u8, s + 6, e, r);
          else if (ascii(u8, s, 28) === 'http://ns.adobe.com/xap/1.0/') xmpGps(u8, s, e, r);
        } else if (m === 0xed) { if (app13HasData(u8, s, e)) r.iptc = true; }
        else if (m === 0xfe) r.comment = true;
        p += 2 + len;
      }
    } else if (r.format === 'PNG') {
      let p = 8;
      while (p + 8 <= n) {
        const len = ((u8[p] << 24) | (u8[p + 1] << 16) | (u8[p + 2] << 8) | u8[p + 3]) >>> 0, type = ascii(u8, p + 4, 4);
        const s = p + 8, e = Math.min(n, s + len);
        if (type === 'eXIf') parseTiff(u8, s, e, r);
        else if (type === 'tEXt' || type === 'zTXt' || type === 'iTXt') {
          r.text++;
          if (ascii(u8, s, 17) === 'XML:com.adobe.xmp') xmpGps(u8, s, e, r);
        } else if (type === 'IEND') break;
        p = s + len + 4;
      }
    } else if (r.format === 'WebP') {
      let p = 12;
      while (p + 8 <= n) {
        const type = ascii(u8, p, 4), len = (u8[p + 4] | (u8[p + 5] << 8) | (u8[p + 6] << 16) | (u8[p + 7] << 24)) >>> 0;
        const s = p + 8, e = Math.min(n, s + len);
        if (type === 'EXIF') parseTiff(u8, ascii(u8, s, 6) === 'Exif\0\0' ? s + 6 : s, e, r);
        else if (type === 'XMP ') xmpGps(u8, s, e, r);
        p = s + len + (len & 1);
      }
    } else {
      // HEIC / AVIF / other: the EXIF block is stored as "Exif\0\0" + TIFF somewhere in the file.
      const lim = Math.min(n, 4 << 20);
      let at = indexOfBytes(u8, 'Exif\0\0', 0, lim);
      if (at >= 0) parseTiff(u8, at + 6, n, r);
      at = indexOfBytes(u8, 'http://ns.adobe.com/xap/1.0/', 0, lim);
      if (at >= 0) xmpGps(u8, at, Math.min(n, at + 65536), r);
    }
  } catch { /* partial info is fine */ }
  return r;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "2024:05:01 10:22:33" → "1 May 2024, 10:22" (or the input if unparseable). */
export function fmtExifDate(s) {
  const m = /^(\d{4})[:-](\d{2})[:-](\d{2})(?:[ T](\d{2}):(\d{2}))?/.exec(s || '');
  if (!m || +m[2] < 1 || +m[2] > 12) return s || '';
  return `${+m[3]} ${MONTHS[+m[2] - 1]} ${m[1]}${m[4] ? `, ${m[4]}:${m[5]}` : ''}`;
}
export function fmtLatLon(lat, lon) {
  return `${Math.abs(lat).toFixed(4)}° ${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lon).toFixed(4)}° ${lon >= 0 ? 'E' : 'W'}`;
}

/** Output type that keeps the input's format (GIF/BMP → PNG, HEIC & others → JPEG). */
export function keepType(mime) {
  const t = (mime || '').toLowerCase();
  if (t === 'image/png' || t === 'image/gif' || t === 'image/bmp') return 'image/png';
  if (t === 'image/webp') return 'image/webp';
  return 'image/jpeg';
}
export const extFor = t => ({ 'image/png': 'png', 'image/webp': 'webp', 'image/jpeg': 'jpg' }[t] || 'jpg');
export const typeName = t => ({ 'image/png': 'PNG', 'image/webp': 'WebP', 'image/jpeg': 'JPEG' }[t] || (t || '').replace('image/', '').toUpperCase());

/** Human error text; memory failures get advice. */
export function errMsg(e) {
  const m = (e && e.message) || String(e || '');
  if (e instanceof RangeError || /memory|allocation|too large|exceeds/i.test(m)) return 'This photo is too big for your phone’s browser to process. Try a smaller photo (or a screenshot of it).';
  return m || 'Something went wrong — please try again.';
}

/* ════════════════════════════ DOM ════════════════════════════ */

export function newCanvas(w, h) {
  if (w * h > MAX_AREA * 1.05) throw new Error('This image is too large for your browser — try a smaller one.');
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h));
  return c;
}
/** 2D context; `read` = we'll call getImageData on it (CPU-backed is faster for that). */
export function ctxOf(c, read = false) {
  const x = c.getContext('2d', read ? { willReadFrequently: true } : undefined);
  if (!x) throw new Error('This image is too large for your browser — try a smaller one.');
  x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'high';
  return x;
}
/** Release a canvas's pixel memory now (Safari otherwise holds it until GC). */
export function free(...cs) { for (const c of cs) if (c && c.width !== undefined) { c.width = 0; c.height = 0; } }

export function getData(c) { return ctxOf(c, true).getImageData(0, 0, c.width, c.height); }

/** High-quality resize of an image/canvas to dw×dh (multi-step). `bg` fills behind transparency. */
export async function drawHQ(src, dw, dh, { bg } = {}) {
  dw = Math.max(1, Math.round(dw)); dh = Math.max(1, Math.round(dh));
  const sw = src.naturalWidth || src.width, sh = src.naturalHeight || src.height;
  let cur = src, made = null;
  const steps = scaleSteps(sw, sh, dw, dh);
  for (let i = 0; i < steps.length; i++) {
    const [w, h] = steps[i], last = i === steps.length - 1;
    const c = newCanvas(w, h), x = ctxOf(c);
    if (last && bg) { x.fillStyle = bg; x.fillRect(0, 0, w, h); }
    x.drawImage(cur, 0, 0, w, h);
    if (made) free(made);
    made = cur = c;
    if (!last) await tick();
  }
  return cur;
}

/**
 * Decode a photo (EXIF orientation applied) into one canvas no bigger than the
 * browser can handle. → {canvas, w, h, origW, origH, scaled}
 */
export async function loadSource(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const ow = img.naturalWidth, oh = img.naturalHeight;
    if (!ow || !oh) throw new Error('Couldn’t read that image — try a JPG or PNG.');
    const cap = capArea(ow, oh);
    const canvas = await drawHQ(img, cap.w, cap.h);
    img.removeAttribute('src');
    return { canvas, w: cap.w, h: cap.h, origW: ow, origH: oh, scaled: cap.scale < 1 };
  } finally { URL.revokeObjectURL(url); }
}

/** Copy a canvas onto a solid background (for JPEG output of images with transparency). */
export function flatten(c, bg = '#fff') {
  const o = newCanvas(c.width, c.height), x = ctxOf(o);
  x.fillStyle = bg; x.fillRect(0, 0, o.width, o.height); x.drawImage(c, 0, 0);
  return o;
}

/** True if any part of the canvas is (noticeably) transparent — checked on a small copy. */
export function hasAlpha(c) {
  const f = fitWithin(c.width, c.height, 256), s = newCanvas(f.w, f.h), x = ctxOf(s, true);
  x.drawImage(c, 0, 0, f.w, f.h);
  const d = x.getImageData(0, 0, f.w, f.h).data;
  free(s);
  for (let i = 3; i < d.length; i += 4) if (d[i] < 250) return true;
  return false;
}

let _webp;
/** Can this browser *encode* WebP? (Safari silently returns PNG.) */
export async function canEncodeWebP() {
  if (_webp === undefined) {
    try { const c = newCanvas(2, 2); ctxOf(c).fillRect(0, 0, 1, 1); _webp = (await canvasToBlob(c, 'image/webp', 0.8)).type === 'image/webp'; }
    catch { _webp = false; }
  }
  return _webp;
}

/**
 * Encode, keeping the requested format when the browser can. If WebP isn't
 * available, falls back to JPEG for opaque images or PNG for transparent ones.
 * → {blob, type, ext, note}
 */
export async function encodeAs(canvas, want, quality = 0.92) {
  let src = canvas, flat = null;
  if (want === 'image/jpeg' && hasAlpha(canvas)) src = flat = flatten(canvas);
  let blob = await canvasToBlob(src, want, quality), note = '';
  if (flat) note = 'Transparent areas were filled with white (JPEG has no transparency).';
  if (blob.type !== want) {
    if (want === 'image/webp') {
      const alpha = hasAlpha(canvas);
      const alt = alpha ? 'image/png' : 'image/jpeg';
      if (blob.type !== alt) blob = await canvasToBlob(canvas, alt, quality);
      note = `This browser can’t create WebP files (Safari doesn’t), so it was saved as ${typeName(blob.type)} instead.`;
    } else note = `Saved as ${typeName(blob.type)} — this browser couldn’t create ${typeName(want)}.`;
  }
  if (flat) free(flat);
  const type = blob.type || want;
  return { blob, type, ext: extFor(type), note };
}

/** Small preview copy of a canvas. */
export async function thumb(c, maxSide = 720) {
  const f = fitWithin(c.width, c.height, maxSide);
  return drawHQ(c, f.w, f.h);
}

/** Object URLs we create, revoked together when the user picks a new file. */
export class UrlBag {
  constructor() { this.urls = new Set(); }
  add(blob) { const u = URL.createObjectURL(blob); this.urls.add(u); return u; }
  clear() { for (const u of this.urls) URL.revokeObjectURL(u); this.urls.clear(); }
}

/* ── small UI pieces built from the kit ── */

const labelStyle = { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '10px', fontSize: '13px', fontWeight: '600', color: 'var(--muted)' };

/** Range slider styled to sit with .field controls. Mirrors field(): {el, input, value}. */
export function slider({ label, min = 0, max = 100, step = 1, value = 50, fmt = v => String(v), ends, onInput, onChange } = {}) {
  const val = h('span', { style: { color: 'var(--text)', fontWeight: '650', fontVariantNumeric: 'tabular-nums' } }, fmt(+value));
  const input = h('input', { type: 'range', min, max, step, 'aria-label': label, style: { width: '100%', height: '30px', margin: '2px 0 0', accentColor: 'var(--brand)', background: 'transparent', touchAction: 'pan-y' } });
  input.value = value;
  input.addEventListener('input', () => { val.textContent = fmt(+input.value); onInput && onInput(+input.value); });
  input.addEventListener('change', () => onChange && onChange(+input.value));
  const el = h('div', {},
    h('div', { style: labelStyle }, h('span', {}, label), val),
    input,
    ends && h('div', { class: 'faint', style: { display: 'flex', justifyContent: 'space-between', fontSize: '12px', marginTop: '-2px' } }, h('span', {}, ends[0]), h('span', {}, ends[1])));
  return { el, input, get value() { return +input.value; }, set value(v) { input.value = v; val.textContent = fmt(+v); } };
}

/** A segmented control that wraps into rows (`perRow` per row) — used as chips. */
export function chipSeg(options, value, onChange, perRow = 3) {
  const s = segmented(options, value, onChange);
  s.style.flexWrap = 'wrap';
  for (const b of s.children) b.style.flex = `1 0 calc(${(100 / perRow).toFixed(3)}% - 4px)`;
  return s;
}

/** Title (+ small sub) on the left, a compact control on the right. */
export function optionRow(title, sub, control) {
  control.style.flex = 'none';
  return h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' } },
    h('div', { style: { minWidth: '0' } }, h('div', { style: { fontWeight: '600', fontSize: '15px' } }, title), sub && h('div', { class: 'faint small' }, sub)),
    control);
}

/** Labelled caption above a control (same look as .field labels, without the input styling). */
export function labelled(text, control) {
  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } }, h('div', { style: labelStyle }, text), control);
}

/** Two-column key/value list. pairs: [[key, value, tone?]] where tone 'warn'|'ok'. */
export function kvList(pairs) {
  return h('div', {}, pairs.filter(Boolean).map(([k, v, tone], i) => h('div', {
    style: { display: 'flex', justifyContent: 'space-between', gap: '14px', padding: '10px 0', borderTop: i ? '.5px solid var(--line)' : '0', fontSize: '14.5px' },
  },
  h('span', { class: 'muted' }, k),
  h('span', { style: { fontWeight: '600', textAlign: 'right', minWidth: '0', overflowWrap: 'anywhere', color: tone === 'warn' ? 'var(--warn)' : tone === 'ok' ? 'var(--ok)' : 'var(--text)' } }, v))));
}

/** Show a canvas as a calm, rounded preview. */
export function previewEl(c, maxH = '200px') {
  Object.assign(c.style, { maxWidth: '100%', maxHeight: maxH, width: 'auto', height: 'auto', margin: '0 auto', borderRadius: '12px', boxShadow: '0 2px 10px rgba(0,0,0,.10)' });
  return c;
}

/**
 * Adds a Before/After switch to a resultCard whose preview is the "after" image.
 * The before image should have the same aspect ratio. Returns the card.
 */
export async function addBeforeAfter(rc, beforeCanvas, bag) {
  const img = rc.querySelector('.rp img'), rb = rc.querySelector('.rb');
  if (!img || !rb || !beforeCanvas) return rc;
  const afterSrc = img.src;
  const beforeSrc = bag.add(await canvasToBlob(beforeCanvas, 'image/jpeg', 0.88));
  const pre = new Image(); pre.src = beforeSrc;
  const seg = segmented([['after', 'After'], ['before', 'Before']], 'after', v => { img.src = v === 'before' ? beforeSrc : afterSrc; });
  seg.style.marginBottom = '12px';
  rb.prepend(seg);
  return rc;
}

/**
 * Stacked Before / After preview to put at the top of a resultCard made with
 * preview:'none' (for results whose shape differs from the input, e.g. signatures).
 */
export function compareStrip(beforeCanvas, afterBlob, { checker = false, outline = false } = {}) {
  const after = h('img', { alt: 'After', style: { maxHeight: '220px', maxWidth: '100%', width: 'auto', boxShadow: 'none', borderRadius: '6px', outline: outline ? '1px solid var(--line-2)' : '' } });
  const url = URL.createObjectURL(afterBlob);
  after.onload = after.onerror = () => URL.revokeObjectURL(url);
  after.src = url;
  previewEl(beforeCanvas, '170px');
  const cap = t => h('div', { class: 'faint small', style: { textAlign: 'center', fontWeight: '600' } }, t);
  return h('div', { class: 'rp', style: { display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: '8px', maxHeight: 'none' } },
    cap('Before'), beforeCanvas,
    cap('After'),
    h('div', { class: checker ? 'checker' : '', style: { alignSelf: 'center', padding: checker ? '8px' : '0', borderRadius: '10px', maxWidth: '100%', display: 'flex', justifyContent: 'center' } }, after));
}
