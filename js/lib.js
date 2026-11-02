// Lazy loaders for vendored libraries. Tool modules call e.g.
//   const { PDFDocument } = await libs.pdfLib();
// Every path is relative to this file, so the app works from any sub-path
// (e.g. https://user.github.io/snappto/) and fully offline once cached.
const V = new URL('../vendor/', import.meta.url).href;

const once = fn => { let p; return () => (p ||= fn().catch(e => { p = null; throw e; })); };
const script = src => new Promise((res, rej) => {
  const s = document.createElement('script');
  s.src = src; s.async = true; s.onload = res; s.onerror = () => rej(new Error('Failed to load ' + src));
  document.head.append(s);
});

export const libs = {
  /** pdf-lib: create/modify PDFs (merge, split, rotate, watermark, images→PDF). */
  pdfLib: once(() => import(V + 'pdf-lib/pdf-lib.esm.min.js')),

  /** pdf.js: read/render PDFs (text extraction, page thumbnails, rasterise). */
  pdfjs: once(async () => {
    const m = await import(V + 'pdfjs/pdf.min.mjs');
    m.GlobalWorkerOptions.workerSrc = V + 'pdfjs/pdf.worker.min.mjs';
    return m;
  }),

  /** tesseract.js (OCR). Use libs.ocrWorker(langs) instead of this directly. */
  tesseract: once(async () => (await import(V + 'tesseract/tesseract.esm.min.js')).default),

  /** jsQR(data, width, height) → {data} | null */
  jsQR: once(() => script(V + 'jsqr/jsQR.js').then(() => window.jsQR)),

  /** qrcode-generator: qrcode(typeNumber 0=auto, 'L'|'M'|'Q'|'H') */
  qrcode: once(async () => (await import(V + 'qrcode/qrcode.mjs')).default),

  /** JsBarcode(canvasOrSvg, value, options) */
  JsBarcode: once(() => script(V + 'jsbarcode/JsBarcode.all.min.js').then(() => window.JsBarcode)),

  /** fflate: zip / unzip */
  fflate: once(() => import(V + 'fflate/browser.js')),

  /** SparkMD5.ArrayBuffer.hash(buf) */
  SparkMD5: once(() => script(V + 'spark-md5/spark-md5.min.js').then(() => window.SparkMD5)),

  /** MediaPipe Tasks Vision: { FilesetResolver, FaceDetector, ImageSegmenter, ... } */
  mediapipe: once(() => { muteTelemetry(); return import(V + 'mediapipe/vision_bundle.mjs'); }),
};

// Every MediaPipe task starts a usage logger (vision_bundle.mjs, class Ch) that POSTs
// device and timing stats to Google every 60 s, and no option turns it off. Refuse
// that one host so nothing leaves the phone; the logger gives up after one refusal.
const TELEMETRY = /^https:\/\/odml\.pa\.googleapis\.com\//i;
function muteTelemetry() {
  const real = globalThis.fetch;
  if (typeof real !== 'function' || real.muted) return;
  const guarded = function (input) {
    const url = typeof input === 'string' ? input : String((input && input.url) || input);
    if (TELEMETRY.test(url)) return Promise.reject(new TypeError('SnappTo sends no usage data'));
    return real.apply(this, arguments);
  };
  guarded.muted = true;
  globalThis.fetch = guarded;
}

/** Ready-to-use MediaPipe face detector (CPU delegate — most reliable on iOS). */
export const faceDetector = once(async () => {
  const { FilesetResolver, FaceDetector } = await libs.mediapipe();
  const fs = await FilesetResolver.forVisionTasks(V + 'mediapipe/wasm');
  return FaceDetector.createFromOptions(fs, {
    baseOptions: { modelAssetPath: V + 'mediapipe/models/blaze_face_short_range.tflite', delegate: 'CPU' },
    runningMode: 'IMAGE', minDetectionConfidence: 0.5,
  });
});

/** Ready-to-use person segmenter → confidence mask (1 = person). */
export const personSegmenter = once(async () => {
  const { FilesetResolver, ImageSegmenter } = await libs.mediapipe();
  const fs = await FilesetResolver.forVisionTasks(V + 'mediapipe/wasm');
  return ImageSegmenter.createFromOptions(fs, {
    baseOptions: { modelAssetPath: V + 'mediapipe/models/selfie_segmenter.tflite', delegate: 'CPU' },
    runningMode: 'IMAGE', outputConfidenceMasks: true, outputCategoryMask: false,
  });
});

// ── OCR ─────────────────────────────────────────────────────────────
// tesseract.js loads one of three builds of its engine, picked with these WebAssembly
// checks (relaxed SIMD, then SIMD). Doing the same here lets offline packs carry just
// that one. Each build embeds its .wasm, so the separate .wasm files are never fetched.
const wasmOk = bytes => { try { return WebAssembly.validate(new Uint8Array(bytes)); } catch { return false; } };
const OCR_CORE = typeof WebAssembly !== 'object' ? 'lstm'
  : wasmOk([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 15, 1, 13, 0, 65, 1, 253, 15, 65, 2, 253, 15, 253, 128, 2, 11]) ? 'relaxedsimd-lstm'
  : wasmOk([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]) ? 'simd-lstm' : 'lstm';
const OCR_ENGINE = ['tesseract/worker.min.js', 'tesseract/tesseract.esm.min.js', `tesseract/core/tesseract-core-${OCR_CORE}.wasm.js`];

/** Every file OCR needs for a language set ('eng', 'eng+hin'…), as paths for vendorUrl(). */
export const ocrFiles = (langs = 'eng') => [...OCR_ENGINE, ...langs.split('+').map(l => `tesseract/lang/${l}.traineddata.gz`)];

const OCR_STALL = 120e3;   // give up on a start that reports no progress for this long
let ocr = null;            // the one live worker: { langs, p, stopped?, cancel? }
// How a start rejects when it was stopped or another language set took over.
const stoppedOcr = () => Object.assign(new Error('Text recognition was stopped'), { name: 'AbortError' });

/**
 * Tesseract worker for 'eng', 'hin', 'tel' or combos like 'eng+hin'. Only one lives at a
 * time (each holds 100+ MB of WebAssembly memory that only terminate() gives back), so
 * asking for another language set shuts the old worker down once its current page is done
 * (a start still under way rejects with an AbortError). Calls that arrive while a worker
 * starts get that same worker; a failed start is forgotten.
 */
export function ocrWorker(langs = 'eng', onProgress) {
  if (ocr && ocr.langs === langs) return ocr.p;
  const prev = ocr, entry = { langs };
  entry.p = (async () => {
    if (prev) await retire(prev);
    return startOcr(langs, onProgress, entry);
  })();
  ocr = entry;
  entry.p.catch(() => { if (ocr === entry) ocr = null; });
  return entry.p;
}

/** Shut the OCR worker down (or stop it starting) to give its memory back. The next ocrWorker() starts afresh. */
export async function releaseOcr() {
  const cur = ocr;
  ocr = null;
  if (cur) await retire(cur);
}

async function retire(entry) {
  entry.stopped = true;
  if (entry.cancel) entry.cancel();
  const w = await entry.p.catch(() => null);
  if (!w) return;
  w.closed = true;
  let t;   // let the page being read finish, but don't wait forever on a stuck one
  await Promise.race([w.idle(), new Promise(r => { t = setTimeout(r, OCR_STALL); })]);
  clearTimeout(t);
  try { await w.terminate(); } catch { /* already gone */ }
}

async function startOcr(langs, onProgress, entry) {
  const T = await libs.tesseract();
  if (entry.stopped) throw stoppedOcr();
  let fail, timer = null, raw = null;
  const failed = new Promise((_, rej) => { fail = rej; });
  failed.catch(() => { /* only ever read through the race below */ });
  const wait = () => { clearTimeout(timer); timer = setTimeout(() => fail(new Error('Text recognition stalled while loading')), OCR_STALL); };
  wait();
  entry.cancel = () => fail(stoppedOcr());
  // Keep a handle on the Web Worker that createWorker spawns (synchronously), so a start
  // that fails half-way can be shut down instead of lingering with its engine loaded.
  const W = globalThis.Worker;
  if (typeof W === 'function') globalThis.Worker = function (...a) { return (raw = new W(...a)); };
  let starting;
  try {
    starting = T.createWorker(langs, 1, {
      workerPath: V + 'tesseract/worker.min.js',
      corePath: V + 'tesseract/core/',
      langPath: V + 'tesseract/lang/',
      gzip: true,
      workerBlobURL: false,
      logger: m => { if (timer) wait(); if (onProgress) onProgress(m); },
      // Without this, tesseract.js swallows a failed model download and never settles.
      errorHandler: e => fail(e instanceof Error ? e : new Error(String(e))),
    });
  } finally {
    if (typeof W === 'function') globalThis.Worker = W;
  }
  try {
    return tracked(await Promise.race([starting, failed]), entry);
  } catch (e) {
    if (raw) raw.terminate();
    throw e instanceof Error ? e : new Error(String(e));
  } finally {
    clearTimeout(timer);
    timer = null;
    entry.cancel = null;
  }
}

/**
 * Remember the pages a worker is reading, so it's only shut down between pages. A page that
 * fails can leave the engine broken (an out-of-memory abort does), so that worker is retired
 * and the next ocrWorker() starts a fresh one.
 */
function tracked(w, entry) {
  const recognize = w.recognize, jobs = new Set();
  w.recognize = (...a) => {
    if (w.closed) return Promise.reject(new Error('Text recognition was restarted'));
    const job = recognize(...a);
    jobs.add(job);
    job.then(() => jobs.delete(job), () => { jobs.delete(job); if (ocr === entry) releaseOcr(); });
    return job;
  };
  w.idle = () => Promise.allSettled([...jobs]);
  return w;
}

/** Files to pre-download so OCR / background removal work offline (Settings uses this). */
export const OFFLINE_PACKS = {
  ocr_eng: { label: 'Text recognition — English', files: ocrFiles('eng') },
  ocr_hin: { label: 'Text recognition — Hindi', files: ocrFiles('hin') },
  ocr_tel: { label: 'Text recognition — Telugu', files: ocrFiles('tel') },
  vision: { label: 'Face detection & background removal', files: ['mediapipe/vision_bundle.mjs', 'mediapipe/wasm/vision_wasm_internal.js', 'mediapipe/wasm/vision_wasm_internal.wasm', 'mediapipe/wasm/vision_wasm_nosimd_internal.js', 'mediapipe/wasm/vision_wasm_nosimd_internal.wasm', 'mediapipe/models/blaze_face_short_range.tflite', 'mediapipe/models/selfie_segmenter.tflite'] },
};
export const vendorUrl = p => V + p;
