# Tool module contract (snappto-web)

SnappTo is an offline-first web app (PWA). The shell (`js/app.js`) routes to
`#/tool/<id>`, dynamically imports `js/tools/<module>` from the catalog, and calls:

```js
export async function mount(root, toolId, tool) { ... }
```
- `root`: an empty `<div>` to build the tool UI into. Never touch anything outside it.
- `toolId`: one of the ids assigned to your module in `js/catalog.js` (a module serves several ids — branch on it).
- `tool`: the catalog entry `{id,label,desc,where,module,cat}`. The page already shows the large title + desc, so don't repeat them.

## Hard rules
1. **Offline & private.** Everything runs in the browser. Never upload user files or call any network URL,
   except: vendored libraries via `js/lib.js`, and the currency module's public FX API (with a cached fallback).
2. **Imports only** from `../ui.js`, `../lib.js`, `../store.js`, your own sibling files in `js/tools/`. No CDNs.
   Load heavy libs lazily *inside* handlers (`await libs.pdfLib()`), never at module top level.
3. **Use the UI kit** (`js/ui.js`) for every control so all tools look identical:
   `h, card, button, busy, field, row, segmented, filePicker, notice, progress, resultCard,
    download, share, toast, fmtBytes, outputBox, copyButton, answer, stats, stem, loadImage,
    toCanvas, canvasToBlob, jpegUnder, tick`. Read `js/ui.js` — the JSDoc is the spec.
   CSS classes available are in `css/app.css` (`.card .stack .row .field .btn .seg .drop .notice
   .prog .result .out .stat .big-answer .cam .shutter .camhint .muted .faint .small .mono`). Prefer helpers over raw classes. Do NOT add CSS files; if you truly need a style, use inline `style:{}` sparingly.
4. **Standard layout:** an input card (filePicker or fields) → options (segmented / fields) →
   one primary action button (wrap work in `busy(btn, async () => …)`) → results appended below via
   `resultCard({title, blob, filename, before, after, note})`. Calculators update live as you type
   (no button needed). Offer a way to start over (picking a new file is enough).
5. **Errors never escape.** Catch everything and show `notice(msg, 'err')` in place. Messages are human:
   say what went wrong and what to do ("This PDF is password-protected — unlock it first").
6. **Big files:** show `progress()` for anything > ~0.5 s; `await tick()` inside long loops so the UI repaints.
   Downscale huge images before heavy pixel work. Revoke object URLs you create.
7. **Filenames:** `${stem(file.name)}_<what>.<ext>` e.g. `invoice_compressed.pdf`.
8. **Mobile first:** numeric inputs use `inputmode:'decimal'`, text areas are comfortable, tap targets ≥ 44 px.
   Test mentally at 375 px wide. iPhone Safari is the primary target.
9. **Copy tone:** short, friendly, plain English. No jargon. Sentence case labels.
10. **Verify:** `node --check js/tools/<file>.js` must pass. Put pure logic (math, parsing, text ops,
   geometry) in exported functions and test them with a quick `node --input-type=module -e "…"`.
   Don't use the browser preview — the lead tests the integrated app in a browser.

## Library entry points (`js/lib.js`)
```js
import { libs, faceDetector, personSegmenter, ocrWorker } from '../lib.js';
const { PDFDocument, degrees, rgb, StandardFonts } = await libs.pdfLib();   // pdf-lib 1.17
const pdfjs = await libs.pdfjs();          // PDF.js 6.x (worker already configured)
const worker = await ocrWorker('eng', m => …);   // tesseract.js 7; 'hin', 'tel', 'eng+hin'
const { data } = await worker.recognize(canvasOrBlob);  // data.text
const jsQR = await libs.jsQR();            // jsQR(Uint8ClampedArray, w, h) → {data} | null
const qrcode = await libs.qrcode();        // qrcode-generator: qrcode(0,'M'); q.addData(s); q.make();
const JsBarcode = await libs.JsBarcode();  // JsBarcode(canvas, value, {format})
const fflate = await libs.fflate();        // zipSync / unzipSync
const SparkMD5 = await libs.SparkMD5();    // SparkMD5.ArrayBuffer.hash(buf)
const fd = await faceDetector();           // MediaPipe; fd.detect(imageOrCanvas).detections[i].boundingBox {originX,originY,width,height}, .keypoints
const seg = await personSegmenter();       // seg.segment(img).confidenceMasks[0].getAsFloat32Array() (w×h of input), then .close()
```
