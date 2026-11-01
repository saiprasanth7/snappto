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
  mediapipe: once(() => import(V + 'mediapipe/vision_bundle.mjs')),
};

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

const ocrWorkers = new Map();
/** Tesseract worker for 'eng', 'hin', 'tel' or combos like 'eng+hin'. Cached per language set. */
export async function ocrWorker(langs = 'eng', onProgress) {
  if (ocrWorkers.has(langs)) return ocrWorkers.get(langs);
  const T = await libs.tesseract();
  const w = await T.createWorker(langs, 1, {
    workerPath: V + 'tesseract/worker.min.js',
    corePath: V + 'tesseract/core/',
    langPath: V + 'tesseract/lang/',
    gzip: true,
    workerBlobURL: false,
    logger: m => onProgress && onProgress(m),
  });
  ocrWorkers.set(langs, w);
  return w;
}

/** Files to pre-download so OCR / background removal work offline (Settings uses this). */
export const OFFLINE_PACKS = {
  ocr_eng: { label: 'Text recognition — English', files: ['tesseract/worker.min.js', 'tesseract/tesseract.esm.min.js', 'tesseract/core/tesseract-core-simd-lstm.wasm.js', 'tesseract/core/tesseract-core-simd-lstm.wasm', 'tesseract/core/tesseract-core-relaxedsimd-lstm.wasm.js', 'tesseract/core/tesseract-core-relaxedsimd-lstm.wasm', 'tesseract/core/tesseract-core-lstm.wasm.js', 'tesseract/core/tesseract-core-lstm.wasm', 'tesseract/lang/eng.traineddata.gz'] },
  ocr_hin: { label: 'Text recognition — Hindi', files: ['tesseract/lang/hin.traineddata.gz'] },
  ocr_tel: { label: 'Text recognition — Telugu', files: ['tesseract/lang/tel.traineddata.gz'] },
  vision: { label: 'Face detection & background removal', files: ['mediapipe/vision_bundle.mjs', 'mediapipe/wasm/vision_wasm_internal.js', 'mediapipe/wasm/vision_wasm_internal.wasm', 'mediapipe/wasm/vision_wasm_nosimd_internal.js', 'mediapipe/wasm/vision_wasm_nosimd_internal.wasm', 'mediapipe/models/blaze_face_short_range.tflite', 'mediapipe/models/selfie_segmenter.tflite'] },
};
export const vendorUrl = p => V + p;
