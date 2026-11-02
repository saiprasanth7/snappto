// File tools: create / open ZIPs, checksums, and "what is this file really?".
// Everything runs on the phone. Pure logic (ZIP directory parsing, magic numbers,
// hash parsing) is exported and unit-tested in node.
import { h, card, button, busy, field, filePicker, notice, progress, resultCard, toast, fmtBytes, copyButton,
  download, share, canShareFiles, tick } from '../ui.js';
import { libs } from '../lib.js';

// ═════════════════════════════ pure helpers ═════════════════════════════
export const extOf = name => { const m = /\.([^./\\]+)$/.exec(String(name || '')); return m ? m[1].toLowerCase() : ''; };

/** Make names unique: photo.jpg, photo (2).jpg, photo (3).jpg… */
export function uniqueNames(names) {
  const seen = new Set();
  return names.map(n => {
    const clean = String(n || 'file').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_') || 'file';
    let out = clean, k = 2;
    const e = extOf(clean), base = e ? clean.slice(0, -(e.length + 1)) : clean;
    while (seen.has(out.toLowerCase())) out = `${base} (${k++})${e ? '.' + e : ''}`;
    seen.add(out.toLowerCase());
    return out;
  });
}

/** Already-compressed formats: deflating them wastes time for ~0% gain, so they're stored as-is. */
const PACKED = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif', 'avif', 'mp3', 'm4a', 'aac', 'ogg', 'opus', 'mp4', 'm4v', 'mov', '3gp',
  'mkv', 'webm', 'avi', 'zip', 'gz', 'tgz', '7z', 'rar', 'bz2', 'xz', 'apk', 'aab', 'ipa', 'jar', 'docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp', 'epub', 'woff', 'woff2']);
export const isPackedName = name => PACKED.has(extOf(name));

// ── ZIP central directory (works on a whole buffer or a File via readAt) ──
const CP437 = 'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ';
function decodeName(bytes, utf8Flag) {
  if (utf8Flag) return new TextDecoder().decode(bytes);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }        // most modern zips are UTF-8 even without the flag
  catch { let s = ''; for (const b of bytes) s += b < 128 ? String.fromCharCode(b) : CP437[b - 128]; return s; }
}
const u16 = (b, i) => b[i] | (b[i + 1] << 8);
const u32 = (b, i) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;
const u64 = (b, i) => u32(b, i) + u32(b, i + 4) * 2 ** 32;
export class ZipError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const ZIP_MSG = {
  notzip: 'This doesn’t look like a ZIP file.',
  truncated: 'This ZIP looks incomplete or damaged — the download may have been cut off. Try downloading it again.',
  corrupt: 'This ZIP is damaged and can’t be read.',
  locked: 'This file is password-protected.',
  method: 'This file uses a compression type that can’t be opened here.',
};
/**
 * List entries without unpacking anything.
 * readAt(offset, length) → Promise<Uint8Array>; size = total bytes.
 */
export async function readZipDirectory(readAt, size) {
  if (size < 22) throw new ZipError('notzip', ZIP_MSG.notzip);
  const tailLen = Math.min(size, 65557), tail = await readAt(size - tailLen, tailLen);
  let e = -1;
  for (let i = tail.length - 22; i >= 0; i--) if (tail[i] === 0x50 && u32(tail, i) === 0x06054b50) { e = i; break; }
  if (e < 0) {
    const head = await readAt(0, Math.min(4, size));
    throw new ZipError(head[0] === 0x50 && head[1] === 0x4b ? 'truncated' : 'notzip', head[0] === 0x50 && head[1] === 0x4b ? ZIP_MSG.truncated : ZIP_MSG.notzip);
  }
  const eAbs = size - tailLen + e;
  let count = u16(tail, e + 10), cdSize = u32(tail, e + 12), cdOff = u32(tail, e + 16);
  if ((count === 0xffff || cdSize === 0xffffffff || cdOff === 0xffffffff) && eAbs >= 20) {
    const loc = await readAt(eAbs - 20, 20);
    if (u32(loc, 0) === 0x07064b50) {
      const z = u64(loc, 8), rec = await readAt(z, 56);
      if (u32(rec, 0) === 0x06064b50) { count = u64(rec, 32); cdSize = u64(rec, 40); cdOff = u64(rec, 48); }
    }
  }
  if (cdOff + cdSize > size || cdSize > 256 * 2 ** 20) throw new ZipError('corrupt', ZIP_MSG.corrupt);
  const cd = await readAt(cdOff, cdSize);
  const entries = [];
  let p = 0;
  for (let k = 0; k < count; k++) {
    if (p + 46 > cd.length || u32(cd, p) !== 0x02014b50) throw new ZipError('corrupt', ZIP_MSG.corrupt);
    const flags = u16(cd, p + 8), method = u16(cd, p + 10), time = u16(cd, p + 12), date = u16(cd, p + 14);
    let csize = u32(cd, p + 20), usize = u32(cd, p + 24), off = u32(cd, p + 42);
    const nl = u16(cd, p + 28), xl = u16(cd, p + 30), cl = u16(cd, p + 32);
    const name = decodeName(cd.subarray(p + 46, p + 46 + nl), flags & 0x800);
    for (let x = p + 46 + nl, xe = x + xl; x + 4 <= xe;) {             // ZIP64 extra field
      const id = u16(cd, x), sz = u16(cd, x + 2);
      if (id === 1) { let q = x + 4; if (usize === 0xffffffff) { usize = u64(cd, q); q += 8; } if (csize === 0xffffffff) { csize = u64(cd, q); q += 8; } if (off === 0xffffffff) off = u64(cd, q); }
      x += 4 + sz;
    }
    entries.push({ index: k, name, size: usize, csize, method, offset: off, encrypted: !!(flags & 1) || method === 99,
      isDir: /[/\\]$/.test(name), mtime: date ? new Date(1980 + (date >> 9), ((date >> 5) & 15) - 1, date & 31, time >> 11, (time >> 5) & 63, (time & 31) * 2) : null });
    p += 46 + nl + xl + cl;
  }
  return entries;
}
export const listZip = u8 => readZipDirectory(async (o, l) => u8.subarray(o, o + l), u8.length);
export const isJunkEntry = n => /(^|\/)__MACOSX\//.test(n) || /(^|\/)(\.DS_Store|Thumbs\.db|desktop\.ini)$/i.test(n) || /(^|\/)\._/.test(n);

// ── hashes ──────────────────────────────────────────────────────────
const HEX_LEN = { 32: 'md5', 40: 'sha1', 64: 'sha256', 128: 'sha512' };
const B64_LEN = { 24: 'md5', 28: 'sha1', 44: 'sha256', 88: 'sha512' };
/** Accepts "abc…", "SHA256 (f) = abc…", "sha256:abc…", SRI "sha256-base64…". → {algo, hex} or null. */
export function parseExpectedHash(s) {
  s = String(s || '').trim();
  if (!s) return null;
  const sri = /^(sha256|sha384|sha512|sha1|md5)-([A-Za-z0-9+/]+={0,2})$/i.exec(s);
  const runs = s.match(/\b[0-9a-fA-F]{32,128}\b/g) || [];
  const hit = runs.find(r => HEX_LEN[r.length]);
  if (hit) return { algo: HEX_LEN[hit.length], hex: hit.toLowerCase() };
  const b64 = sri ? sri[2] : (/^[A-Za-z0-9+/]+={0,2}$/.test(s) ? s : null);
  if (b64 && B64_LEN[b64.length]) {
    try { const bin = atob(b64); return { algo: B64_LEN[b64.length], hex: Array.from(bin, c => c.charCodeAt(0).toString(16).padStart(2, '0')).join('') }; }
    catch { return null; }
  }
  return null;
}
export const toHex = buf => Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('');

// ── streaming SHA-1 / SHA-256 / SHA-512 ─────────────────────────────
// WebCrypto can only hash one whole buffer (and copies it), which crashes phone tabs on big files.
// These take the file piece by piece, so memory stays flat at any size.
/** First 64 bits of the fractional part of p^(1/n): the SHA-2 constants (FIPS 180-4 §4.2.3, §5.3.5), derived instead of pasted. */
function rootFrac(p, n) {
  const N = BigInt(n), X = BigInt(p) << (64n * N);
  let x = 1n << BigInt(Math.ceil((p.toString(2).length + 64 * n) / n));   // above the root; Newton steps down to floor(root)
  for (;;) { const y = ((N - 1n) * x + X / x ** (N - 1n)) / N; if (y >= x) break; x = y; }
  return x & 0xffffffffffffffffn;
}
let SHA2 = null;
function sha2Consts() {
  if (SHA2) return SHA2;
  const primes = []; for (let k = 2; primes.length < 80; k++) if (primes.every(p => k % p)) primes.push(k);
  const hi = v => Number(v >> 32n) | 0, lo = v => Number(v & 0xffffffffn) | 0;
  const K = primes.map(p => rootFrac(p, 3)), H = primes.slice(0, 8).map(p => rootFrac(p, 2));
  return (SHA2 = { K256: Int32Array.from(K.slice(0, 64), hi), H256: Int32Array.from(H, hi),
    K512: Int32Array.from(K.flatMap(v => [hi(v), lo(v)])), H512: Int32Array.from(H.flatMap(v => [hi(v), lo(v)])) });
}
const be32 = (b, o) => (b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3];
function sha1Block(H, b, o, W) {
  for (let t = 0; t < 16; t++, o += 4) W[t] = be32(b, o);
  for (let t = 16; t < 80; t++) { const x = W[t - 3] ^ W[t - 8] ^ W[t - 14] ^ W[t - 16]; W[t] = (x << 1) | (x >>> 31); }
  let a = H[0], bb = H[1], c = H[2], d = H[3], e = H[4];
  for (let t = 0; t < 80; t++) {
    const f = t < 20 ? (bb & c) | (~bb & d) : t < 40 ? bb ^ c ^ d : t < 60 ? (bb & c) | (bb & d) | (c & d) : bb ^ c ^ d;
    const k = t < 20 ? 0x5a827999 : t < 40 ? 0x6ed9eba1 : t < 60 ? 0x8f1bbcdc : 0xca62c1d6;
    const x = (((a << 5) | (a >>> 27)) + f + e + k + W[t]) | 0;
    e = d; d = c; c = (bb << 30) | (bb >>> 2); bb = a; a = x;
  }
  H[0] = (H[0] + a) | 0; H[1] = (H[1] + bb) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0; H[4] = (H[4] + e) | 0;
}
function sha256Block(H, b, o, W) {
  const K = SHA2.K256;
  for (let t = 0; t < 16; t++, o += 4) W[t] = be32(b, o);
  for (let t = 16; t < 64; t++) {
    const x = W[t - 15], y = W[t - 2];
    W[t] = ((((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3)) + (((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10)) + W[t - 7] + W[t - 16]) | 0;
  }
  let a = H[0], bb = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
  for (let t = 0; t < 64; t++) {
    const t1 = (h + (((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7))) + ((e & f) ^ (~e & g)) + K[t] + W[t]) | 0;
    const t2 = ((((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10))) + ((a & bb) ^ (a & c) ^ (bb & c))) | 0;
    h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = bb; bb = a; a = (t1 + t2) | 0;
  }
  H[0] = (H[0] + a) | 0; H[1] = (H[1] + bb) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
  H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
}
// SHA-512 words are 64-bit, held as (hi, lo) pairs of 32-bit ints; carries go through the lo sums.
function sha512Block(H, b, o, W) {
  const K = SHA2.K512;
  for (let t = 0; t < 32; t++, o += 4) W[t] = be32(b, o);
  for (let t = 32; t < 160; t += 2) {
    const xh = W[t - 30], xl = W[t - 29], yh = W[t - 4], yl = W[t - 3];
    const s0h = ((xh >>> 1) | (xl << 31)) ^ ((xh >>> 8) | (xl << 24)) ^ (xh >>> 7);
    const s0l = ((xl >>> 1) | (xh << 31)) ^ ((xl >>> 8) | (xh << 24)) ^ ((xl >>> 7) | (xh << 25));
    const s1h = ((yh >>> 19) | (yl << 13)) ^ ((yl >>> 29) | (yh << 3)) ^ (yh >>> 6);
    const s1l = ((yl >>> 19) | (yh << 13)) ^ ((yh >>> 29) | (yl << 3)) ^ ((yl >>> 6) | (yh << 26));
    const l = (s0l >>> 0) + (s1l >>> 0) + (W[t - 13] >>> 0) + (W[t - 31] >>> 0);
    W[t] = (s0h + s1h + W[t - 14] + W[t - 32] + ((l / 0x100000000) | 0)) | 0; W[t + 1] = l | 0;
  }
  let ah = H[0], al = H[1], bh = H[2], bl = H[3], ch = H[4], cl = H[5], dh = H[6], dl = H[7];
  let eh = H[8], el = H[9], fh = H[10], fl = H[11], gh = H[12], gl = H[13], hh = H[14], hl = H[15];
  for (let t = 0; t < 160; t += 2) {
    const S1h = ((eh >>> 14) | (el << 18)) ^ ((eh >>> 18) | (el << 14)) ^ ((el >>> 9) | (eh << 23));
    const S1l = ((el >>> 14) | (eh << 18)) ^ ((el >>> 18) | (eh << 14)) ^ ((eh >>> 9) | (el << 23));
    const chh = (eh & fh) ^ (~eh & gh), chl = (el & fl) ^ (~el & gl);
    const l1 = (hl >>> 0) + (S1l >>> 0) + (chl >>> 0) + (K[t + 1] >>> 0) + (W[t + 1] >>> 0);
    const t1h = (hh + S1h + chh + K[t] + W[t] + ((l1 / 0x100000000) | 0)) | 0, t1l = l1 | 0;
    const S0h = ((ah >>> 28) | (al << 4)) ^ ((al >>> 2) | (ah << 30)) ^ ((al >>> 7) | (ah << 25));
    const S0l = ((al >>> 28) | (ah << 4)) ^ ((ah >>> 2) | (al << 30)) ^ ((ah >>> 7) | (al << 25));
    const mjh = (ah & bh) ^ (ah & ch) ^ (bh & ch), mjl = (al & bl) ^ (al & cl) ^ (bl & cl);
    const l2 = (S0l >>> 0) + (mjl >>> 0);
    const t2h = (S0h + mjh + ((l2 / 0x100000000) | 0)) | 0, t2l = l2 | 0;
    hh = gh; hl = gl; gh = fh; gl = fl; fh = eh; fl = el;
    const l3 = (dl >>> 0) + (t1l >>> 0); eh = (dh + t1h + ((l3 / 0x100000000) | 0)) | 0; el = l3 | 0;
    dh = ch; dl = cl; ch = bh; cl = bl; bh = ah; bl = al;
    const l4 = (t1l >>> 0) + (t2l >>> 0); ah = (t1h + t2h + ((l4 / 0x100000000) | 0)) | 0; al = l4 | 0;
  }
  const v = [ah, al, bh, bl, ch, cl, dh, dl, eh, el, fh, fl, gh, gl, hh, hl];
  for (let i = 0; i < 16; i += 2) { const l = (H[i + 1] >>> 0) + (v[i + 1] >>> 0); H[i] = (H[i] + v[i] + ((l / 0x100000000) | 0)) | 0; H[i + 1] = l | 0; }
}
/** Incremental hasher: update(Uint8Array) as often as needed, then hex(). alg: 'SHA-1' | 'SHA-256' | 'SHA-512'. */
export function shaStream(alg) {
  sha2Consts();
  const [block, H, W, size] = {
    'SHA-1': [sha1Block, Int32Array.of(0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0), new Int32Array(80), 64],
    'SHA-256': [sha256Block, SHA2.H256.slice(), new Int32Array(64), 64],
    'SHA-512': [sha512Block, SHA2.H512.slice(), new Int32Array(160), 128] }[alg];
  const buf = new Uint8Array(size);
  let fill = 0, total = 0;
  const update = u8 => {
    let i = 0;
    total += u8.length;
    if (fill) { i = Math.min(size - fill, u8.length); buf.set(u8.subarray(0, i), fill); fill += i; if (fill < size) return; block(H, buf, 0, W); fill = 0; }
    for (; i + size <= u8.length; i += size) block(H, u8, i, W);
    if (i < u8.length) { buf.set(u8.subarray(i)); fill = u8.length - i; }
  };
  const hex = () => {
    const bits = total * 8, tail = new Uint8Array((fill + 1 + size / 8 > size ? 2 : 1) * size - fill);
    tail[0] = 0x80;
    for (let k = 1; k <= 6; k++) tail[tail.length - k] = Math.floor(bits / 2 ** (8 * (k - 1))) & 255;   // bit length, big-endian
    update(tail);
    return Array.from(H, x => (x >>> 0).toString(16).padStart(8, '0')).join('');
  };
  return { update, hex };
}

// ── file type detection ─────────────────────────────────────────────
const T = (label, mime, exts, kind, extra = {}) => ({ label, mime, exts, kind, ...extra });
const TEXTY = new Set(['txt', 'text', 'csv', 'tsv', 'md', 'markdown', 'log', 'json', 'xml', 'html', 'htm', 'js', 'mjs', 'css', 'py', 'java', 'c', 'h', 'cpp', 'ts', 'sh',
  'yml', 'yaml', 'ini', 'cfg', 'conf', 'srt', 'vtt', 'sql', 'php', 'rb', 'go', 'rs', 'kt', 'swift', 'tex', 'rtf', 'svg', 'vcf', 'ics', 'toml', 'env', 'properties', 'gpx', 'kml', 'bat', 'ps1', 'jsonl', 'ndjson', 'geojson', 'nfo', 'readme']);
/** Name the type inside a ZIP container from its entry names (+ the stored "mimetype" file). */
export function zipFlavour(names = [], head) {
  const has = n => names.includes(n), any = re => names.some(x => re.test(x));
  let mt = '';
  if (head && head.length > 38 && u32(head, 0) === 0x04034b50) {
    const nl = u16(head, 26), xl = u16(head, 28);
    if (new TextDecoder().decode(head.subarray(30, 30 + nl)) === 'mimetype') mt = new TextDecoder().decode(head.subarray(30 + nl + xl, 30 + nl + xl + 80)).replace(/[^\x20-\x7e].*$/s, '');
  }
  if (mt.startsWith('application/epub+zip') || has('META-INF/container.xml') && any(/\.opf$/)) return T('EPUB e-book', 'application/epub+zip', ['epub'], 'document');
  if (mt.startsWith('application/vnd.oasis.opendocument.text')) return T('OpenDocument text', 'application/vnd.oasis.opendocument.text', ['odt'], 'document');
  if (mt.startsWith('application/vnd.oasis.opendocument.spreadsheet')) return T('OpenDocument spreadsheet', 'application/vnd.oasis.opendocument.spreadsheet', ['ods'], 'document');
  if (mt.startsWith('application/vnd.oasis.opendocument.presentation')) return T('OpenDocument presentation', 'application/vnd.oasis.opendocument.presentation', ['odp'], 'document');
  if (any(/^word\/document\.xml$/)) return T('Word document', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', ['docx', 'docm', 'dotx'], 'document');
  if (any(/^xl\/workbook\.(xml|bin)$/)) return T('Excel spreadsheet', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ['xlsx', 'xlsm', 'xlsb'], 'document');
  if (any(/^ppt\/presentation\.xml$/)) return T('PowerPoint presentation', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', ['pptx', 'pptm', 'ppsx'], 'document');
  if (has('AndroidManifest.xml') && any(/^classes\d*\.dex$/)) return T('Android app (APK)', 'application/vnd.android.package-archive', ['apk'], 'program',
    { danger: true, note: 'Only install apps from sources you trust — fake APKs are a common way to steal bank details.' });
  if (any(/^base\/manifest\/AndroidManifest\.xml$/)) return T('Android app bundle (AAB)', 'application/octet-stream', ['aab'], 'program', { danger: true });
  if (any(/^Payload\/[^/]+\.app\//)) return T('iPhone app (IPA)', 'application/octet-stream', ['ipa'], 'program', { danger: true });
  if (has('META-INF/MANIFEST.MF') && any(/\.class$/)) return T('Java archive (JAR)', 'application/java-archive', ['jar'], 'program', { danger: true });
  // iWork (iPhone / Mac Pages, Numbers, Keynote) and AR models are plain ZIPs inside.
  if (any(/^Index\/(Template)?Slide[^/]*\.iwa$/)) return T('Keynote presentation', 'application/vnd.apple.keynote', ['key'], 'document');
  if (any(/^Index\/[^/]+\.iwa$/))
    return T('Pages or Numbers document', 'application/vnd.apple.pages', any(/^Index\/Tables\//) ? ['numbers', 'pages'] : ['pages', 'numbers'], 'document');
  // Older iWork files keep their parts in a nested Index.zip, so the app can't be told apart here.
  if (has('Index.zip') && has('Metadata/Properties.plist')) return T('Apple iWork document (Pages, Numbers or Keynote)', 'application/zip', ['pages', 'numbers', 'key'], 'document');
  if (names.length && /\.usd[ac]?$/i.test(names[0])) return T('3D / AR model (USDZ)', 'model/vnd.usdz+zip', ['usdz'], 'document');
  if (has('doc.kml')) return T('Google Earth file (KMZ)', 'application/vnd.google-earth.kmz', ['kmz'], 'document');
  if (any(/^visio\//)) return T('Visio drawing', 'application/vnd.ms-visio.drawing', ['vsdx'], 'document');
  return T('ZIP archive', 'application/zip', ['zip'], 'archive', names.length ? { note: `${names.filter(n => !/\/$/.test(n)).length} file(s) inside — open it with “Open ZIP”.` } : {});
}

/** Identify a file from its first bytes (64 KB is plenty). info: {size, zipNames}. */
export function detectType(b, info = {}) {
  const ascii = (i, s) => { if (i + s.length > b.length) return false; for (let k = 0; k < s.length; k++) if (b[i + k] !== s.charCodeAt(k)) return false; return true; };
  const at = (i, ...xs) => xs.every((x, k) => b[i + k] === x);
  const str = (i, n) => String.fromCharCode(...b.subarray(i, i + n));
  const find = (s, limit) => { const lim = Math.min(b.length - s.length, limit); for (let i = 0; i <= lim; i++) if (b[i] === s.charCodeAt(0) && ascii(i, s)) return i; return -1; };
  if (!b.length) return T('Empty file', 'application/octet-stream', [], 'empty', { note: 'This file has no content (0 bytes).' });

  if (at(0, 0xFF, 0xD8, 0xFF)) return T('JPEG image', 'image/jpeg', ['jpg', 'jpeg', 'jfif'], 'image');
  if (at(0, 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A)) return T('PNG image', 'image/png', ['png'], 'image');
  if (ascii(0, 'GIF87a') || ascii(0, 'GIF89a')) return T('GIF image', 'image/gif', ['gif'], 'image');
  if (ascii(0, 'RIFF') && b.length >= 12) {
    const f = str(8, 4);
    if (f === 'WEBP') return T('WebP image', 'image/webp', ['webp'], 'image');
    if (f === 'WAVE') return T('WAV audio', 'audio/wav', ['wav'], 'audio');
    if (f === 'AVI ') return T('AVI video', 'video/x-msvideo', ['avi'], 'video');
    return T('RIFF media file', 'application/octet-stream', ['riff'], 'media');
  }
  if (ascii(4, 'ftyp')) {
    const brand = str(8, 4), boxEnd = Math.min(b.length, (b[0] << 24 | b[1] << 16 | b[2] << 8 | b[3]) >>> 0 || 32);
    const compat = []; for (let i = 16; i + 4 <= boxEnd; i += 4) compat.push(str(i, 4));
    const all = [brand, ...compat];
    if (['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis'].includes(brand) || ((brand === 'mif1' || brand === 'msf1') && all.some(x => /^he[iv]/.test(x))))
      return T('HEIC photo (iPhone format)', 'image/heic', ['heic', 'heif'], 'image', { note: 'Some websites and older PCs can’t open HEIC. If an upload fails, convert it to JPG first.' });
    if (brand === 'avif' || brand === 'avis' || (brand === 'mif1' && all.includes('avif'))) return T('AVIF image', 'image/avif', ['avif'], 'image');
    if (brand === 'mif1' || brand === 'msf1') return T('HEIF image', 'image/heif', ['heif', 'heic'], 'image');
    if (brand === 'qt  ') return T('QuickTime video (MOV)', 'video/quicktime', ['mov', 'qt'], 'video');
    if (/^M4[ABP] $/.test(brand)) return T(brand === 'M4B ' ? 'Audiobook (M4B)' : 'M4A audio', 'audio/mp4', brand === 'M4B ' ? ['m4b', 'm4a'] : ['m4a', 'mp4'], 'audio');
    if (/^3g2/.test(brand)) return T('3GPP2 video', 'video/3gpp2', ['3g2', '3gp'], 'video');
    if (/^3g/.test(brand)) return T('3GP video', 'video/3gpp', ['3gp', '3gpp'], 'video');
    if (brand === 'crx ') return T('Canon RAW photo (CR3)', 'image/x-canon-cr3', ['cr3'], 'image');
    if (brand === 'M4V ' || brand === 'M4VH' || brand === 'M4VP') return T('MP4 video', 'video/x-m4v', ['m4v', 'mp4'], 'video');
    return T('MP4 video', 'video/mp4', ['mp4', 'm4v', 'mov'], 'video');
  }
  if (['moov', 'mdat', 'wide', 'free', 'skip', 'pnot'].includes(str(4, 4)) && b.length > 8) {
    // Only trust the atom name when its size fits the file: text like "For free…" has a size word of ~1 GB.
    // Without the file size, a size word that is all printable letters is taken as text.
    const sz = ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0;
    const texty = [0, 1, 2, 3].every(i => b[i] >= 0x20 && b[i] < 0x7f);
    if (sz === 0 || sz === 1 || (sz >= 8 && (info.size ? sz <= info.size : !texty))) return T('QuickTime video (MOV)', 'video/quicktime', ['mov', 'mp4'], 'video');
  }
  if (ascii(0, 'BM') && b.length > 26 && (b[6] | b[7] | b[8] | b[9]) === 0) return T('BMP image', 'image/bmp', ['bmp', 'dib'], 'image');
  if (at(0, 0x49, 0x49, 0x2A, 0x00) || at(0, 0x4D, 0x4D, 0x00, 0x2A) || at(0, 0x49, 0x49, 0x2B, 0x00) || at(0, 0x4D, 0x4D, 0x00, 0x2B)) {
    if (ascii(8, 'CR')) return T('Canon RAW photo (CR2)', 'image/x-canon-cr2', ['cr2'], 'image');
    return T('TIFF image', 'image/tiff', ['tif', 'tiff', 'dng', 'nef', 'arw'], 'image', { note: 'Camera RAW files (DNG, NEF, ARW) are also TIFF-based.' });
  }
  if (at(0, 0, 0, 1, 0) && b.length > 6 && u16(b, 4) > 0 && u16(b, 4) < 256 && (b[9] === 0 || b[9] === 255)) return T('Icon (ICO)', 'image/x-icon', ['ico'], 'image');
  if (at(0, 0, 0, 2, 0) && b.length > 6 && u16(b, 4) > 0 && u16(b, 4) < 256) return T('Cursor (CUR)', 'image/x-icon', ['cur'], 'image');
  if (ascii(0, '8BPS')) return T('Photoshop image (PSD)', 'image/vnd.adobe.photoshop', ['psd'], 'image');
  if (find('%PDF-', 1024) >= 0) return T('PDF document', 'application/pdf', ['pdf'], 'document');
  if (at(0, 0x50, 0x4B, 0x03, 0x04) || at(0, 0x50, 0x4B, 0x05, 0x06) || at(0, 0x50, 0x4B, 0x07, 0x08)) return zipFlavour(info.zipNames || [], b);
  if (at(0, 0x1F, 0x8B)) return T('GZIP archive', 'application/gzip', ['gz', 'tgz'], 'archive');
  if (at(0, 0x37, 0x7A, 0xBC, 0xAF, 0x27, 0x1C)) return T('7-Zip archive', 'application/x-7z-compressed', ['7z'], 'archive');
  if (ascii(0, 'Rar!') && at(4, 0x1A, 0x07)) return T(b[6] === 1 ? 'RAR archive (v5)' : 'RAR archive', 'application/vnd.rar', ['rar'], 'archive');
  if (ascii(0, 'BZh') && b[3] >= 0x31 && b[3] <= 0x39) return T('BZIP2 archive', 'application/x-bzip2', ['bz2'], 'archive');
  if (at(0, 0xFD, 0x37, 0x7A, 0x58, 0x5A, 0x00)) return T('XZ archive', 'application/x-xz', ['xz'], 'archive');
  if (ascii(257, 'ustar')) return T('TAR archive', 'application/x-tar', ['tar'], 'archive');
  if (ascii(0, 'ID3')) return T('MP3 audio', 'audio/mpeg', ['mp3'], 'audio');
  if (ascii(0, 'fLaC')) return T('FLAC audio', 'audio/flac', ['flac'], 'audio');
  if (ascii(0, 'OggS')) {
    if (find('OpusHead', 200) >= 0) return T('Opus audio (voice note)', 'audio/ogg', ['opus', 'ogg'], 'audio', { note: 'WhatsApp voice notes use this format.' });
    if (find('vorbis', 200) >= 0) return T('Ogg Vorbis audio', 'audio/ogg', ['ogg', 'oga'], 'audio');
    if (find('theora', 200) >= 0) return T('Ogg video', 'video/ogg', ['ogv', 'ogg'], 'video');
    return T('Ogg media', 'audio/ogg', ['ogg'], 'audio');
  }
  if (ascii(0, '#!AMR')) return T('AMR voice recording', 'audio/amr', ['amr'], 'audio');
  if (ascii(0, 'MThd')) return T('MIDI music', 'audio/midi', ['mid', 'midi'], 'audio');
  if (at(0, 0x1A, 0x45, 0xDF, 0xA3)) return find('webm', 64) >= 0 ? T('WebM video', 'video/webm', ['webm'], 'video') : T('Matroska video (MKV)', 'video/x-matroska', ['mkv', 'mka', 'mk3d'], 'video');
  if (at(0, 0x00, 0x00, 0x01, 0xBA) || at(0, 0x00, 0x00, 0x01, 0xB3)) return T('MPEG video', 'video/mpeg', ['mpg', 'mpeg', 'vob'], 'video');
  if (b[0] === 0x47 && b.length > 376 && b[188] === 0x47 && b[376] === 0x47) return T('MPEG transport stream', 'video/mp2t', ['ts', 'mts', 'm2ts'], 'video');
  if (b[0] === 0xFF && (b[1] & 0xE0) === 0xE0 && b.length > 3) {
    const layer = (b[1] >> 1) & 3;
    if (layer === 0 && (b[1] & 0xF6) === 0xF0) return T('AAC audio', 'audio/aac', ['aac'], 'audio');
    if (layer !== 0 && (b[2] >> 4) !== 15 && ((b[2] >> 2) & 3) !== 3) return T(layer === 1 ? 'MP3 audio' : 'MPEG audio', 'audio/mpeg', layer === 1 ? ['mp3'] : ['mp2', 'mp3'], 'audio');
  }
  if (at(0, 0x7F, 0x45, 0x4C, 0x46)) return T('Linux / Android program (ELF)', 'application/x-elf', ['so', 'elf', 'bin', 'o'], 'program', { danger: true });
  if (ascii(0, 'MZ')) return T('Windows program (EXE/DLL)', 'application/vnd.microsoft.portable-executable', ['exe', 'dll', 'msi', 'scr', 'sys'], 'program',
    { danger: true, note: 'Programs can harm your computer — only run them if you trust where they came from.' });
  if (at(0, 0xFE, 0xED, 0xFA, 0xCE) || at(0, 0xFE, 0xED, 0xFA, 0xCF) || at(0, 0xCE, 0xFA, 0xED, 0xFE) || at(0, 0xCF, 0xFA, 0xED, 0xFE))
    return T('Mac program (Mach-O)', 'application/x-mach-binary', ['', 'dylib', 'bundle'], 'program', { danger: true });
  if (at(0, 0xCA, 0xFE, 0xBA, 0xBE) && b.length >= 8) {        // shared by universal Mac programs (arch count) and Java classes (version ≥ 45)
    const v = ((b[4] << 24) | (b[5] << 16) | (b[6] << 8) | b[7]) >>> 0;
    return v > 0 && v < 30 ? T('Mac program (Mach-O)', 'application/x-mach-binary', ['', 'dylib', 'bundle'], 'program', { danger: true })
      : T('Java class file', 'application/java-vm', ['class'], 'program', { danger: true });
  }
  if (ascii(0, 'dex\n')) return T('Android code (DEX)', 'application/octet-stream', ['dex'], 'program', { danger: true });
  if (ascii(0, 'SQLite format 3\u0000')) return T('SQLite database', 'application/vnd.sqlite3', ['sqlite', 'db', 'sqlite3', 'db3'], 'data');
  if (at(0, 0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1)) return T('Older Microsoft Office file (.doc / .xls / .ppt)', 'application/x-ole-storage', ['doc', 'xls', 'ppt', 'msg', 'msi', 'pub', 'vsd'], 'document');
  if (ascii(0, '{\\rtf')) return T('Rich Text document (RTF)', 'application/rtf', ['rtf'], 'document');
  if (ascii(0, '%!PS')) return T('PostScript document', 'application/postscript', ['ps', 'eps'], 'document');
  if (ascii(0, 'wOFF')) return T('Web font (WOFF)', 'font/woff', ['woff'], 'font');
  if (ascii(0, 'wOF2')) return T('Web font (WOFF2)', 'font/woff2', ['woff2'], 'font');
  if (ascii(0, 'OTTO')) return T('OpenType font', 'font/otf', ['otf'], 'font');
  const numTables = (b[4] << 8) | b[5];                                   // big-endian, unlike the ZIP fields
  if ((at(0, 0x00, 0x01, 0x00, 0x00) || ascii(0, 'true')) && b.length > 12 && numTables > 0 && numTables < 64) return T('TrueType font', 'font/ttf', ['ttf'], 'font');
  if (ascii(0, 'ttcf') && (at(4, 0, 1, 0, 0) || at(4, 0, 2, 0, 0))) return T('TrueType font collection', 'font/collection', ['ttc'], 'font');
  if (ascii(0x8001, 'CD001')) return T('Disc image (ISO)', 'application/x-iso9660-image', ['iso'], 'archive');
  return detectText(b, info);
}

function detectText(b, info) {
  let start = 0, enc = 'UTF-8';
  if (at3(b, 0xEF, 0xBB, 0xBF)) start = 3;
  else if ((b[0] === 0xFF && b[1] === 0xFE) || (b[0] === 0xFE && b[1] === 0xFF)) return T('Text (UTF-16)', 'text/plain', ['txt'], 'text', { note: 'Uses UTF-16 encoding — some apps prefer UTF-8.' });
  let end = b.length;
  if (info.size && info.size > b.length) { while (end > start && end > b.length - 4 && (b[end - 1] & 0xC0) === 0x80) end--; if (end > start && b[end - 1] >= 0xC0) end--; }
  let s;
  try { s = new TextDecoder('utf-8', { fatal: true }).decode(b.subarray(start, end)); } catch {
    let ctl = 0; for (let i = 0; i < Math.min(b.length, 4096); i++) if (b[i] < 9 || (b[i] > 13 && b[i] < 32)) ctl++;
    if (ctl === 0) { enc = 'legacy'; s = String.fromCharCode(...b.subarray(0, Math.min(b.length, 8192))); }
    else return unknown(b);
  }
  let ctl = 0; for (let i = 0; i < Math.min(s.length, 8192); i++) { const c = s.charCodeAt(i); if ((c < 9 || (c > 13 && c < 32) || c === 127)) ctl++; }
  if (ctl > Math.max(2, Math.min(s.length, 8192) * 0.01)) return unknown(b);
  const t = s.trimStart(), lower = t.slice(0, 300).toLowerCase();
  const legacy = enc === 'legacy' ? { note: 'Not UTF-8 — it may use an older character set (accented letters could look wrong).' } : {};
  const whole = !info.size || info.size <= b.length;
  if (/^[{[]/.test(t)) {
    if (whole) { try { JSON.parse(s); return T('JSON data', 'application/json', ['json', 'geojson'], 'text'); } catch { /* not JSON */ } }
    else if (/^[{[]\s*["{[\]\d-]/.test(t)) return T('JSON data (probably)', 'application/json', ['json', 'jsonl'], 'text');
  }
  if (lower.startsWith('<?xml') || lower.startsWith('<svg')) {
    if (/<svg[\s>]/.test(s.slice(0, 2000).toLowerCase())) return T('SVG image', 'image/svg+xml', ['svg'], 'image');
    if (/<gpx[\s>]/.test(s.slice(0, 2000))) return T('GPS track (GPX)', 'application/gpx+xml', ['gpx'], 'text');
    if (/<kml[\s>]/.test(s.slice(0, 2000))) return T('Google Earth file (KML)', 'application/vnd.google-earth.kml+xml', ['kml'], 'text');
    return T('XML document', 'application/xml', ['xml'], 'text');
  }
  if (lower.startsWith('<!doctype html') || lower.startsWith('<html') || /^<(head|body|meta|div|p)[\s>]/.test(lower)) return T('Web page (HTML)', 'text/html', ['html', 'htm'], 'text');
  if (t.startsWith('BEGIN:VCARD')) return T('Contact card (vCard)', 'text/vcard', ['vcf'], 'text');
  if (t.startsWith('BEGIN:VCALENDAR')) return T('Calendar event (iCalendar)', 'text/calendar', ['ics'], 'text');
  if (t.startsWith('#!')) return T('Script', 'text/plain', ['sh', 'py', 'pl', 'rb'], 'text', { danger: true, note: 'A script is a small program — only run it if you trust it.' });
  if (/^WEBVTT/.test(t)) return T('Subtitles (WebVTT)', 'text/vtt', ['vtt'], 'text');
  if (/^\d+\r?\n\d\d:\d\d:\d\d,\d{3} --> /.test(t)) return T('Subtitles (SRT)', 'application/x-subrip', ['srt'], 'text');
  const lines = s.split(/\r?\n/).filter(l => l.trim()).slice(0, 20);
  if (lines.length >= 2) {
    for (const d of [',', '\t', ';']) {
      const counts = lines.map(l => l.split(d).length - 1);
      if (counts[0] >= 1 && counts.every(c => c === counts[0])) return T(d === '\t' ? 'Table (TSV)' : 'Table (CSV)', d === '\t' ? 'text/tab-separated-values' : 'text/csv', d === '\t' ? ['tsv', 'txt'] : ['csv', 'txt'], 'text', legacy);
    }
  }
  return T('Plain text', 'text/plain', ['txt'], 'text', legacy);
}
const at3 = (b, x, y, z) => b[0] === x && b[1] === y && b[2] === z;
const unknown = b => T('Unknown file type', 'application/octet-stream', [], 'unknown',
  { note: `It starts with the bytes ${Array.from(b.subarray(0, 8), x => x.toString(16).padStart(2, '0').toUpperCase()).join(' ')}. It may be an app-specific or encrypted file.` });

/** Compare a file's extension with what it really is. → {lvl, msg} or null. */
export function extensionCheck(fileName, det) {
  const ext = extOf(fileName);
  if (!det || !det.exts || !det.exts.length || det.kind === 'empty' || det.kind === 'unknown') return null;
  if (!ext) return det.exts[0] ? { lvl: 'info', msg: `This file has no extension. Naming it “.${det.exts[0]}” helps apps recognise it.` } : null;
  if (det.exts.includes(ext)) return null;
  if (det.kind === 'text' && TEXTY.has(ext) && !det.danger) return null;
  if (det.mime === 'video/mp4' && ['mp4', 'm4v', 'mov', 'm4a', '3gp'].includes(ext)) return null;
  if (det.mime === 'application/zip' && ['zip', 'cbz', 'zipx', 'xpi', 'crx', 'whl', 'nupkg', 'vsix', 'sketch', 'pbix', 'mcpack',
    'pages', 'numbers', 'key', 'usdz', '3mf', 'ora', 'kra'].includes(ext)) return null;
  if (det.danger || det.kind === 'program') return { lvl: 'err', msg: `Careful: this is really a ${det.label}, but it’s named “.${ext}”. Disguised programs are a common trick — don’t open or install it unless you trust where it came from.` };
  return { lvl: 'warn', msg: `It’s named “.${ext}” but it’s really a ${det.label}. Renaming it to “.${det.exts[0]}” may help it open.` };
}

/** Pixel size from image headers (no decoding). */
export function imageSize(b, mime) {
  try {
    const be16 = i => (b[i] << 8) | b[i + 1], be32 = i => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
    if (mime === 'image/png') return { w: be32(16), h: be32(20) };
    if (mime === 'image/gif') return { w: u16(b, 6), h: u16(b, 8) };
    if (mime === 'image/bmp') { const hh = (b[22] | (b[23] << 8) | (b[24] << 16) | (b[25] << 24)); return { w: u32(b, 18), h: Math.abs(hh) }; }
    if (mime === 'image/webp') {
      const c = String.fromCharCode(...b.subarray(12, 16));
      if (c === 'VP8X') return { w: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), h: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
      if (c === 'VP8 ') return { w: u16(b, 26) & 0x3fff, h: u16(b, 28) & 0x3fff };
      if (c === 'VP8L') return { w: 1 + (((b[22] & 0x3F) << 8) | b[21]), h: 1 + (((b[24] & 0xF) << 10) | (b[23] << 2) | ((b[22] & 0xC0) >> 6)) };
    }
    if (mime === 'image/jpeg') {
      let i = 2;
      while (i + 9 < b.length) {
        if (b[i] !== 0xFF) return null;
        const m = b[i + 1];
        if (m === 0xFF) { i++; continue; }
        if ((m >= 0xC0 && m <= 0xCF) && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) return { w: be16(i + 7), h: be16(i + 5) };
        if (m === 0xD8 || (m >= 0xD0 && m <= 0xD7) || m === 0x01) { i += 2; continue; }
        i += 2 + be16(i + 2);
      }
    }
  } catch { /* header too short */ }
  return null;
}

const MIME_BY_EXT = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', heic: 'image/heic', svg: 'image/svg+xml',
  pdf: 'application/pdf', txt: 'text/plain', csv: 'text/csv', json: 'application/json', html: 'text/html', htm: 'text/html', xml: 'application/xml',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', ogg: 'audio/ogg', opus: 'audio/ogg', mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
  zip: 'application/zip', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  doc: 'application/msword', xls: 'application/vnd.ms-excel', ppt: 'application/vnd.ms-powerpoint', epub: 'application/epub+zip', vcf: 'text/vcard', ics: 'text/calendar', md: 'text/markdown' };
export const mimeFromName = n => MIME_BY_EXT[extOf(n)] || 'application/octet-stream';

// ── packing & hashing (work on File/Blob objects; streamed in chunks) ──
// Output is handed to Blob parts every 16 MB, so the JS heap never holds a whole archive.
const FLUSH = 16 * 2 ** 20;
/**
 * Biggest ZIP we build, or deflated entry we unpack, in one go. The result is a Blob the browser keeps in memory
 * until it is saved, and a phone tab is killed long before a computer's (stored entries are file slices: no limit).
 */
export const zipMemLimit = () => (typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches ? 500 : 1536) * 2 ** 20;

/** Stream files into a ZIP (deflate level 6; already-compressed formats stored). → {blob, stored}. */
export async function zipFiles(files, fflate, onProgress = () => {}, yieldFn = tick) {
  const total = files.reduce((a, f) => a + f.size, 0);
  const names = uniqueNames(files.map(f => f.name));
  const parts = []; let chunks = [], held = 0, zipErr = null;
  const zip = new fflate.Zip((err, data) => {
    if (err) { zipErr = err; return; }
    chunks.push(data); held += data.length;
    if (held >= FLUSH) { parts.push(new Blob(chunks)); chunks = []; held = 0; }
  });
  let done = 0, stored = 0;
  for (let i = 0; i < files.length; i++) {
    const f = files[i], packed = isPackedName(names[i]);
    if (packed) stored++;
    const entry = packed ? new fflate.ZipPassThrough(names[i]) : new fflate.ZipDeflate(names[i], { level: 6 });
    const lm = +f.lastModified || 0, y = lm ? new Date(lm).getFullYear() : 0;
    entry.mtime = y > 1980 && y < 2099 ? lm : Date.now();                   // ZIP dates can't go before 1980
    zip.add(entry);
    if (!f.size) { entry.push(new Uint8Array(0), true); continue; }
    const CH = 4 * 2 ** 20;
    for (let off = 0; off < f.size; off += CH) {
      let buf;
      try { buf = new Uint8Array(await f.slice(off, off + CH).arrayBuffer()); }
      catch { throw new Error(`Couldn’t read “${f.name}”. If it’s in iCloud, download it to the phone first.`); }
      entry.push(buf, off + CH >= f.size);
      if (zipErr) throw zipErr;
      done += buf.length;
      onProgress(total ? done / total : null, i, files.length);
      await yieldFn();
    }
  }
  zip.end();
  if (zipErr) throw zipErr;
  return { blob: new Blob([...parts, ...chunks], { type: 'application/zip' }), stored, names };
}

/**
 * Unpack one entry straight from the ZIP File, reading only that entry's bytes:
 * stored entries are a zero-copy slice, deflated ones stream through fflate in 1 MB pieces.
 */
export async function extractEntry(file, entry, fflate, yieldFn = tick) {
  if (entry.encrypted) throw new ZipError('locked', ZIP_MSG.locked);
  if (entry.method !== 0 && entry.method !== 8) throw new ZipError('method', ZIP_MSG.method);
  const lh = new Uint8Array(await file.slice(entry.offset, entry.offset + 30).arrayBuffer());
  if (lh.length < 30 || u32(lh, 0) !== 0x04034b50) throw new ZipError('corrupt', ZIP_MSG.corrupt);
  const start = entry.offset + 30 + u16(lh, 26) + u16(lh, 28), end = start + entry.csize;   // the local header's own name/extra lengths
  if (end > file.size) throw new ZipError('truncated', ZIP_MSG.truncated);
  const base = entry.name.split('/').pop() || 'file', type = mimeFromName(base);
  if (entry.method === 0 || !entry.csize) return new File([file.slice(start, end)], base, { type });
  const parts = []; let chunks = [], held = 0;
  const inf = new fflate.Inflate(d => {
    chunks.push(d); held += d.length;
    if (held >= FLUSH) { parts.push(new Blob(chunks)); chunks = []; held = 0; }
  });
  const CH = 2 ** 20;
  for (let off = start; off < end; off += CH) {
    const piece = new Uint8Array(await file.slice(off, Math.min(end, off + CH)).arrayBuffer());
    try { inf.push(piece, off + CH >= end); } catch (e) { throw e instanceof RangeError ? e : new ZipError('corrupt', ZIP_MSG.corrupt); }
    await yieldFn();
  }
  return new File([...parts, ...chunks], base, { type });
}

/** MD5 + SHA-1/256/512 in one streamed pass (1 MB at a time), so any size works in flat memory. */
export async function hashFile(f, { SparkMD5, onProgress = () => {}, cancelled = () => false, yieldFn = tick }) {
  const md5 = new SparkMD5.ArrayBuffer();
  const sha = [['sha1', shaStream('SHA-1')], ['sha256', shaStream('SHA-256')], ['sha512', shaStream('SHA-512')]];
  const CH = 2 ** 20;
  for (let off = 0; off < f.size; off += CH) {
    const buf = await f.slice(off, off + CH).arrayBuffer();
    if (cancelled()) return null;
    md5.append(buf);
    const u8 = new Uint8Array(buf);
    for (const [, s] of sha) s.update(u8);
    onProgress(Math.min(1, (off + buf.byteLength) / f.size));
    await yieldFn();
  }
  const r = { md5: md5.end() };
  for (const [key, s] of sha) r[key] = s.hex();
  return cancelled() ? null : r;
}

// ═════════════════════════════ UI helpers ═════════════════════════════
const muted = t => h('p', { class: 'muted small', style: { margin: 0 } }, t);
const fileReader = file => async (o, l) => new Uint8Array(await file.slice(o, o + l).arrayBuffer());
const ICON = { image: '🖼', video: '🎬', audio: '🎵', document: '📄', archive: '🗜', program: '⚙️', text: '📝', font: '🔤', data: '🗃', media: '🎞', unknown: '❔', empty: '∅' };
const iconByName = n => { const e = extOf(n); return /^(jpe?g|png|gif|webp|heic|svg|bmp)$/.test(e) ? '🖼' : /^(mp4|mov|webm|mkv|avi|3gp)$/.test(e) ? '🎬'
  : /^(mp3|m4a|wav|ogg|opus|aac|flac)$/.test(e) ? '🎵' : e === 'pdf' ? '📄' : /^(zip|rar|7z|gz)$/.test(e) ? '🗜' : /^(txt|md|csv|json|xml|html?)$/.test(e) ? '📝' : '📎'; };

// ═════════════════════════════ mount ═════════════════════════════
export async function mount(root, toolId) {
  const fn = { zip: mountZip, unzip: mountUnzip, filehash: mountHash, filetype: mountType }[toolId];
  try {
    if (!fn) { root.append(notice('This tool isn’t available yet.', 'warn')); return; }
    await fn(root);
  } catch (e) {
    console.error(e);
    root.append(notice('Something went wrong setting up this tool. Please reload the page.', 'err'));
  }
}

// ── Create ZIP ──────────────────────────────────────────────────────
function mountZip(root) {
  let files = [];
  const name = field({ label: 'ZIP name', value: 'archive', placeholder: 'archive' });
  name.input.setAttribute('autocapitalize', 'none');
  const out = h('div');
  const info = h('div', { class: 'small muted' });
  const picker = filePicker({ multiple: true, label: 'Choose files', hint: 'Pick as many as you like — add more any time', icon: '🗂', onFiles: f => {
    files = f; out.replaceChildren();
    const tot = files.reduce((a, x) => a + x.size, 0);
    info.textContent = files.length ? `${files.length} file${files.length === 1 ? '' : 's'} · ${fmtBytes(tot)}` : '';
  } });
  const go = button('Create ZIP', () => busy(go, async () => {
    out.replaceChildren();
    if (!files.length) { out.append(notice('Choose at least one file first.', 'warn')); return; }
    const total = files.reduce((a, f) => a + f.size, 0), max = zipMemLimit();
    if (total > max) { out.append(notice(`That’s ${fmtBytes(total)} of files. This browser can zip up to ${fmtBytes(max)} at a time, so try fewer files or make two ZIPs.`, 'warn')); return; }
    const p = progress('Packing…'); out.append(p.el);
    try {
      const fflate = await libs.fflate();
      const { blob, stored } = await zipFiles(files, fflate, (fr, i, n) => p.set(fr, `Packing ${i + 1} of ${n}…`));
      p.done();
      const base = (name.value.trim() || 'archive').replace(/\.zip$/i, '').replace(/[\\/:*?"<>|]+/g, '_');
      out.append(await resultCard({ title: 'ZIP ready', blob, filename: `${base}.zip`, before: total, after: blob.size,
        note: `${files.length} file${files.length === 1 ? '' : 's'}${stored ? ` · ${stored} photo/video/compressed file${stored === 1 ? ' was' : 's were'} stored as-is (they’re already compressed)` : ''}` }));
    } catch (e) {
      console.error(e);
      p.fail(/memory|allocation|RangeError/i.test(String(e && (e.name + e.message))) ? 'The phone ran out of memory making this ZIP. Try fewer or smaller files.'
        : e.message && !/^\d+$/.test(e.message) ? e.message : 'Couldn’t create the ZIP. Try fewer or smaller files.');
    }
  }), { full: true });
  root.append(card({ title: 'Files to pack' }, picker, info), card({}, name.el), go, out);
}

// ── Open ZIP ────────────────────────────────────────────────────────
function mountUnzip(root) {
  const out = h('div');
  const accept = '.zip,.cbz,.epub,.apk,.jar,.docx,.xlsx,.pptx,.odt,.ods,.odp,application/zip,application/x-zip-compressed';
  const picker = filePicker({ accept, label: 'Choose a ZIP file', hint: 'Also opens .docx, .epub, .apk and other ZIP-based files', icon: '🗜',
    onFiles: f => { if (f[0]) open(f[0]); else out.replaceChildren(); } });
  root.append(card({}, picker), out);

  async function open(file) {
    out.replaceChildren();
    const p = progress('Reading the ZIP…'); out.append(p.el);
    let entries;
    try {
      entries = await readZipDirectory(fileReader(file), file.size);    // only the directory is read; entries are read when saved
    } catch (e) {
      p.fail(e instanceof ZipError ? e.message : 'Couldn’t read that file. If it’s in iCloud, download it to the phone first.');
      return;
    }
    p.done();
    const fflate = await libs.fflate();
    const all = entries.filter(e => !e.isDir);
    const junk = all.filter(e => isJunkEntry(e.name));
    const items = all.filter(e => !isJunkEntry(e.name)).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    const folders = new Set(items.map(e => e.name.includes('/') ? e.name.slice(0, e.name.lastIndexOf('/')) : '').filter(Boolean));
    const total = items.reduce((a, e) => a + e.size, 0);
    const locked = items.filter(e => e.encrypted).length;

    const extract = async entry => {
      const max = zipMemLimit();
      if (entry.method === 8 && entry.size > max) throw new Error(`This file is ${fmtBytes(entry.size)} unpacked. This browser can unpack up to ${fmtBytes(max)} at a time.`);
      try { return await extractEntry(file, entry, fflate); }
      catch (e) {
        if (e instanceof ZipError) throw e;
        throw new Error(/memory|allocation|RangeError/i.test(String(e && (e.name + e.message))) ? 'The phone ran out of memory unpacking this file.'
          : 'Couldn’t read that file. If it’s in iCloud, download it to the phone first.');
      }
    };
    const act = async (entry, how, btn) => {
      try {
        btn.disabled = true;
        await tick();
        const f = await extract(entry);
        if (how === 'share') await share(f, f.name); else download(f, f.name);
      } catch (e) { toast(e.message || 'Couldn’t unpack that file', 'err'); }
      finally { btn.disabled = false; }
    };
    const rowFor = entry => {
      const base = entry.name.split('/').pop();
      const right = entry.encrypted ? h('span', { class: 'small', style: { color: 'var(--warn)', fontWeight: '600', flex: 'none' } }, '🔒 Locked')
        : (entry.method !== 0 && entry.method !== 8) ? h('span', { class: 'small faint', style: { flex: 'none' } }, 'Can’t open')
          : (() => {
            const sv = button('Save', null, { variant: 'ghost', small: true }); sv.onclick = () => act(entry, 'save', sv);
            const sh = canShareFiles() ? button('Share', null, { variant: 'secondary', small: true }) : null;
            if (sh) sh.onclick = () => act(entry, 'share', sh);
            return h('span', { style: { display: 'flex', gap: '6px', flex: 'none' } }, sv, sh);
          })();
      return h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', padding: '9px 0', borderBottom: '1px solid var(--line)', minHeight: '52px' } },
        h('span', { style: { fontSize: '20px', flex: 'none' } }, iconByName(base)),
        h('div', { style: { flex: '1', minWidth: '0' } }, h('div', { style: { fontSize: '14.5px', fontWeight: '560', wordBreak: 'break-all', lineHeight: '1.3' } }, base),
          h('div', { class: 'faint', style: { fontSize: '12.5px' } }, fmtBytes(entry.size))),
        right);
    };
    const list = h('div');
    const LIMIT = 250;
    const drawList = (limit) => {
      list.replaceChildren();
      let lastDir = null, n = 0;
      for (const e of items) {
        if (n++ >= limit) { list.append(button(`Show all ${items.length} files`, () => drawList(Infinity), { variant: 'ghost', full: true })); break; }
        const dir = e.name.includes('/') ? e.name.slice(0, e.name.lastIndexOf('/')) : '';
        if (dir !== lastDir) { lastDir = dir; if (dir || folders.size) list.append(h('div', { class: 'small', style: { fontWeight: '650', color: 'var(--muted)', padding: '12px 0 2px', wordBreak: 'break-all' } }, dir ? `📁 ${dir}` : '📁 (top level)')); }
        list.append(rowFor(e));
      }
    };
    drawList(LIMIT);
    const shareAll = canShareFiles() && items.length > 1 && items.length <= 100 && total <= 300 * 2 ** 20 && !locked
      ? button(`Share all ${items.length} files`, () => busy(shareAll, async () => {
        try {
          const fs = [];
          for (const e of items) fs.push(await extract(e));
          if (navigator.canShare && navigator.canShare({ files: fs })) await navigator.share({ files: fs });
          else toast('This phone can’t share that many files at once — save them one by one', 'err');
        } catch (e) { if (e && e.name !== 'AbortError') toast('Couldn’t share all files — try one at a time', 'err'); }
      }), { variant: 'secondary', full: true }) : null;
    out.append(card({ title: file.name, sub: `${items.length} file${items.length === 1 ? '' : 's'}${folders.size ? ` in ${folders.size} folder${folders.size === 1 ? '' : 's'}` : ''} · ${fmtBytes(total)} unpacked · ${fmtBytes(file.size)} zipped` },
      locked ? notice(locked === items.length ? 'This ZIP is password-protected. SnappTo can’t open locked ZIPs — unlock it on a computer first.'
        : `${locked} file${locked === 1 ? ' is' : 's are'} password-protected and can’t be opened here.`, 'warn') : null,
      !items.length ? h('div', { class: 'empty' }, h('div', { class: 'e' }, '📭'), 'This ZIP is empty.') : list,
      junk.length ? muted(`${junk.length} hidden system file${junk.length === 1 ? '' : 's'} (like __MACOSX) not shown.`) : null,
      shareAll));
  }
}

// ── Checksum ────────────────────────────────────────────────────────
function mountHash(root) {
  let file = null, result = null;
  const exp = field({ label: 'Expected checksum (optional)', placeholder: 'Paste the MD5 / SHA-256 from the website', hint: 'We’ll tell you if the file matches.' });
  exp.input.setAttribute('autocapitalize', 'none');
  Object.assign(exp.input.style, { fontFamily: 'var(--mono)', fontSize: '14px' });
  const verdict = h('div');
  const out = h('div');
  const picker = filePicker({ label: 'Choose a file', hint: 'Any type, any size', icon: '🔐', onFiles: f => { file = f[0] || null; result = null; if (file) run(); else { out.replaceChildren(); judge(); } } });
  root.append(card({}, picker), card({}, exp.el, verdict), out);
  exp.input.addEventListener('input', () => { judge(); paint(); });

  const ALGOS = [['md5', 'MD5'], ['sha1', 'SHA-1'], ['sha256', 'SHA-256'], ['sha512', 'SHA-512']];
  function judge() {
    verdict.replaceChildren();
    const raw = exp.value.trim();
    if (!raw) return;
    const e = parseExpectedHash(raw);
    if (!e) { verdict.append(notice('That doesn’t look like an MD5, SHA-1, SHA-256 or SHA-512 checksum.', 'warn')); return; }
    const name = ALGOS.find(a => a[0] === e.algo)[1];
    if (!result) { verdict.append(muted(`Looks like a ${name} checksum. ${file ? 'Calculating…' : 'Now choose the file.'}`)); return; }
    verdict.append(result[e.algo] === e.hex
      ? notice(h('span', {}, h('b', {}, `✅ Match — `), `the ${name} is identical. The file is complete and unchanged.`), 'ok')
      : notice(h('span', {}, h('b', {}, `❌ No match — `), `the ${name} is different. The file may be damaged, incomplete, or a different version. Download it again.`), 'err'));
  }
  function paint() {
    if (!result) return;
    const e = parseExpectedHash(exp.value);
    out.replaceChildren(card({ title: 'Checksums', sub: `${file.name} · ${fmtBytes(file.size)}` },
      ...ALGOS.map(([k, label]) => {
        const v = result[k];
        const hit = e && e.algo === k && v;
        const ok = hit && v === e.hex;
        return h('div', { style: { padding: '10px 12px', borderRadius: '12px', background: hit ? (ok ? 'var(--ok-soft)' : 'var(--err-soft)') : 'var(--surface-2)' } },
          h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px', marginBottom: '4px' } },
            h('b', { class: 'small' }, label + (hit ? (ok ? '  ✅' : '  ❌') : '')), v ? copyButton(v) : null),
          h('div', { class: 'mono', style: { wordBreak: 'break-all', fontSize: '13px', color: v ? 'var(--text)' : 'var(--faint)' } }, v || '—'));
      })));
  }
  async function run() {
    out.replaceChildren(); verdict.replaceChildren();
    const f = file;
    const p = progress('Reading the file…'); out.append(p.el);
    try {
      const SparkMD5 = await libs.SparkMD5();
      // Big files take a while on a phone, so stop when another file is picked or the user leaves.
      const r = await hashFile(f, { SparkMD5, onProgress: fr => p.set(fr, 'Calculating checksums…'), cancelled: () => file !== f || !root.isConnected });
      if (!r || file !== f) return;                                   // a new file was picked meanwhile
      p.done();
      result = r; paint(); judge();
    } catch (e) {
      console.error(e);
      p.fail(/memory|allocation|RangeError/i.test(String(e && (e.name + e.message))) ? 'The phone ran out of memory for a file this big.' : 'Couldn’t read that file. If it’s in iCloud, download it to the phone first.');
    }
  }
}

// ── What is this file? ──────────────────────────────────────────────
function mountType(root) {
  const out = h('div');
  const picker = filePicker({ label: 'Choose a file', hint: 'We read only its first bytes — nothing is uploaded', icon: '🔍', onFiles: f => { if (f[0]) run(f[0]); else out.replaceChildren(); } });
  root.append(card({}, picker), out);
  async function run(file) {
    out.replaceChildren(h('div', { class: 'empty' }, h('div', { class: 'e' }, '🔍'), 'Checking…'));
    try {
      const head = new Uint8Array(await file.slice(0, 65536).arrayBuffer());
      let zipNames;
      if (head[0] === 0x50 && head[1] === 0x4B) {
        try { zipNames = (await readZipDirectory(fileReader(file), file.size)).map(e => e.name); } catch { zipNames = []; }
      }
      const det = detectType(head, { size: file.size, zipNames });
      const dims = det.kind === 'image' ? imageSize(head, det.mime) : null;
      const chk = extensionCheck(file.name, det);
      const claimed = file.type || '—';
      const kv = (k, v, mono) => h('div', { style: { display: 'flex', gap: '12px', padding: '9px 0', borderBottom: '1px solid var(--line)' } },
        h('span', { class: 'muted small', style: { flex: '0 0 110px' } }, k), h('span', { style: { flex: '1', minWidth: '0', wordBreak: 'break-all', fontFamily: mono ? 'var(--mono)' : '', fontSize: mono ? '13.5px' : '15px' } }, v));
      out.replaceChildren(
        h('section', { class: 'result' }, h('div', { class: 'rb stack' },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '12px' } }, h('span', { style: { fontSize: '34px' } }, ICON[det.kind] || '📎'),
            h('div', {}, h('div', { class: 'big-answer', style: { fontSize: '24px', margin: 0 } }, det.label),
              h('div', { class: 'muted small' }, det.exts.filter(Boolean).length ? `Usual extension: .${det.exts.filter(Boolean)[0]}` : 'No standard extension'))),
          chk ? notice(chk.msg, chk.lvl === 'err' ? 'err' : chk.lvl === 'warn' ? 'warn' : 'info')
            : det.exts.length ? notice('The file’s name matches what’s inside.', 'ok') : null,
          det.danger && !chk ? notice(det.note || 'This is a program or script — only open it if you trust where it came from.', 'warn') : null,
          h('div', {},
            kv('File name', file.name), kv('Type (MIME)', det.mime, true), kv('Extensions', det.exts.filter(Boolean).map(e => '.' + e).join('  ') || '—', true),
            kv('Size', `${fmtBytes(file.size)}${file.size >= 1024 ? ` (${file.size.toLocaleString('en-IN')} bytes)` : ''}`),
            dims && dims.w && dims.h ? kv('Dimensions', `${dims.w.toLocaleString('en-IN')} × ${dims.h.toLocaleString('en-IN')} px`) : null,
            file.lastModified ? kv('Modified', new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' }).format(file.lastModified)) : null,
            claimed !== det.mime && claimed !== '—' ? kv('Phone says', claimed, true) : null),
          det.note && !(det.danger && !chk) ? muted(det.note) : null)));
    } catch (e) {
      console.error(e);
      out.replaceChildren(notice('Couldn’t read that file. If it’s in iCloud, download it to the phone first.', 'err'));
    }
  }
}
