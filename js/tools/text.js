// Text tools: counting, casing, cleanup, sorting, find & replace, extraction, diff,
// JSON, text → PDF, passwords, random picks, checklists and text-to-speech.
// Everything is on-device. Pure logic is exported and unit-tested in node.
import { h, card, button, busy, field, segmented, notice, progress, resultCard, toast, outputBox, copyButton, answer, stats, canvasToBlob } from '../ui.js';
import { libs } from '../lib.js';
import * as store from '../store.js';

// ═════════════════════════════ pure helpers ═════════════════════════════
const WORDCH = /[\p{L}\p{N}]/u;
let _gseg = null;
try { _gseg = new Intl.Segmenter(undefined, { granularity: 'grapheme' }); } catch { /* old browser */ }
/** User-perceived characters (emoji, Indic conjuncts count once where the platform agrees). */
export function graphemeList(s) { return _gseg ? Array.from(_gseg.segment(s || ''), x => x.segment) : Array.from(s || ''); }
export const graphemeCount = s => { if (!s) return 0; if (!_gseg) return Array.from(s).length; let n = 0; for (const _ of _gseg.segment(s)) n++; return n; };

export function textStats(s) {
  s = String(s || '').replace(/\r\n?/g, '\n');
  const words = s.split(/\s+/).filter(w => WORDCH.test(w)).length;
  const sentences = s.split(/[.!?।॥]+(?=\s|$)|\n+/).filter(x => WORDCH.test(x)).length;
  const paragraphs = s.split(/\n\s*\n/).filter(x => WORDCH.test(x)).length;
  return {
    words, sentences, paragraphs,
    characters: graphemeCount(s),
    charactersNoSpaces: graphemeCount(s.replace(/\s+/g, '')),
    lines: s ? s.split('\n').length : 0,
    readingSec: Math.round(words / 230 * 60),     // silent reading ~230 wpm
    speakingSec: Math.round(words / 140 * 60),    // speaking aloud ~140 wpm
  };
}
export function fmtDuration(sec) {
  if (!sec) return '0 sec';
  if (sec < 60) return `${sec} sec`;
  const m = Math.round(sec / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

// ── case ────────────────────────────────────────────────────────────
const WORD_RE = /[\p{L}\p{N}\p{M}][\p{L}\p{N}\p{M}'’]*/gu;
const SMALL = new Set('a an and as at but by for from in into nor of on or per the to vs via with'.split(' '));
const ABBR = /(?:^|[\s(])(?:e\.g|i\.e|etc|vs|mr|mrs|ms|dr|prof|st|no|approx|fig|vol|rs|sr|jr)\.$|(?:^|[\s(.])\p{L}\.$/iu;
const isAcronym = w => w.length > 1 && w === w.toUpperCase() && w !== w.toLowerCase();
const hasLower = s => /\p{Ll}/u.test(s);
const cap1 = w => { const g = graphemeList(w); return g.length ? g[0].toUpperCase() + g.slice(1).join('') : w; };
/** Words of a line for snake/kebab: splits camelCase and any punctuation. */
export function wordsOf(line) {
  return line.replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, '$1 $2').split(/[^\p{L}\p{N}\p{M}]+/u).filter(Boolean);
}
export function changeCase(s, mode) {
  s = String(s || '');
  const mixed = hasLower(s);           // keep acronyms (UPI, GST) only when the text isn't ALL CAPS
  const lowerKeep = w => (mixed && isAcronym(w) ? w : w.toLowerCase());
  switch (mode) {
    case 'upper': return s.toUpperCase();
    case 'lower': return s.toLowerCase();
    case 'title': return s.replace(WORD_RE, (w, off) => {
      const lw = lowerKeep(w);
      let p = off - 1;                                  // look back past spaces, quotes and brackets (no prefix copy: stays linear)
      while (p >= 0 && ' \t"\'“‘(['.includes(s[p])) p--;
      const first = p < 0 || /[.!?:;\n—–-]/.test(s[p]);
      return !first && SMALL.has(lw) ? lw : (lw === w && mixed && isAcronym(w) ? w : cap1(lw));
    });
    case 'sentence': {
      let t = s.replace(WORD_RE, lowerKeep);
      t = t.replace(/(^|[.!?।]\s+|\n[ \t]*)([\s"'“‘(\[•*-]*)(\p{Ll})/gu, (m, a, b, c, off, full) => {
        if (a[0] === '.' && ABBR.test(full.slice(Math.max(0, off - 12), off + 1))) return m;   // "e.g. this", "Dr. rao"
        return a + b + c.toUpperCase();
      });
      return t.replace(/(^|[\s"“(])i(?=[\s'’,!?;:)"”]|\.(?!\w)|$)/g, '$1I');
    }
    case 'alternate': { let k = 0; return Array.from(s, ch => (ch.toLowerCase() !== ch.toUpperCase() ? (k++ % 2 ? ch.toUpperCase() : ch.toLowerCase()) : ch)).join(''); }
    case 'snake': return s.split('\n').map(l => wordsOf(l).join('_').toLowerCase()).join('\n');
    case 'kebab': return s.split('\n').map(l => wordsOf(l).join('-').toLowerCase()).join('\n');
    default: return s;
  }
}

// ── cleanup ─────────────────────────────────────────────────────────
const BULLET = /^\s*(?:[-*•●▪◦‣·–—>]|\(?\d{1,3}[.)\]:]|\(\d{1,3}\)|\[\d{1,3}\])\s+/;
export function cleanupText(s, o = {}) {
  let lines = String(s || '').replace(/\r\n?/g, '\n').split('\n');
  const before = lines.length;
  if (o.joinBroken) {
    const out = []; let cur = null;
    for (const l of lines) {
      if (!l.trim()) { if (cur != null) { out.push(cur); cur = null; } out.push(l); continue; }
      if (cur == null) { cur = l; continue; }
      if (BULLET.test(l)) { out.push(cur); cur = l; continue; }
      if (/\p{L}-$/u.test(cur.trimEnd()) && /^\s*\p{Ll}/u.test(l)) cur = cur.trimEnd().slice(0, -1) + l.trimStart();
      else cur = cur.trimEnd() + ' ' + l.trimStart();
    }
    if (cur != null) out.push(cur);
    lines = out;
  }
  if (o.bullets) lines = lines.map(l => l.replace(BULLET, ''));
  if (o.collapse) lines = lines.map(l => l.replace(/[ \t  -   　]+/g, ' '));
  if (o.trim) lines = lines.map(l => l.trim());
  if (o.dupes) { const seen = new Set(); lines = lines.filter(l => { const k = l.trim(); if (!k) return true; if (seen.has(k)) return false; seen.add(k); return true; }); }
  if (o.blank) lines = lines.filter(l => l.trim());
  return { text: lines.join('\n'), removed: Math.max(0, before - lines.length) };
}

// ── random (crypto, unbiased) ───────────────────────────────────────
const cryptoU32 = () => crypto.getRandomValues(new Uint32Array(1))[0];
/** Uniform integer in [0, n), n ≤ 2^53, by rejection sampling — no modulo bias. */
export function randBelow(n, rng = cryptoU32) {
  if (!(n >= 1)) return 0;
  if (n <= 2 ** 32) {
    const lim = 2 ** 32 - (2 ** 32 % n);
    let x; do { x = rng(); } while (x >= lim);
    return x % n;
  }
  const lim = 2 ** 53 - (2 ** 53 % n);
  let x; do { x = (rng() & 0x1fffff) * 2 ** 32 + rng(); } while (x >= lim);
  return x % n;
}
export function shuffle(arr, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = randBelow(i + 1, rng); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
/** k distinct integers from [min, max] (k small relative to range → set; else partial shuffle). */
export function sampleRange(min, max, k, rng) {
  const span = max - min + 1;
  if (k > span) return null;
  if (span <= 10000 || k > span / 4) {
    const a = Array.from({ length: span }, (_, i) => min + i);
    for (let i = 0; i < k; i++) { const j = i + randBelow(span - i, rng); [a[i], a[j]] = [a[j], a[i]]; }
    return a.slice(0, k);
  }
  const s = new Set(); while (s.size < k) s.add(min + randBelow(span, rng));
  return [...s];
}

// ── sort ────────────────────────────────────────────────────────────
function firstNumber(l) {
  const m = /(?:^|[^\w.])([-−]?)(\d[\d,]*(?:\.\d+)?|\.\d+)/.exec(l);
  if (!m) return NaN;
  return parseFloat((m[1] ? '-' : '') + m[2].replace(/,/g, ''));
}
export function sortLines(s, mode = 'az', { unique = false, ignoreCase = true } = {}, rng) {
  let lines = String(s || '').replace(/\r\n?/g, '\n').split('\n').filter(l => l.trim());
  if (unique) { const seen = new Set(); lines = lines.filter(l => { const k = ignoreCase ? l.trim().toLowerCase() : l.trim(); if (seen.has(k)) return false; seen.add(k); return true; }); }
  const coll = new Intl.Collator(undefined, { numeric: true, sensitivity: ignoreCase ? 'accent' : 'variant' });
  switch (mode) {
    case 'az': return lines.sort(coll.compare);
    case 'za': return lines.sort((a, b) => coll.compare(b, a));
    case 'num': return lines.sort((a, b) => { const x = firstNumber(a), y = firstNumber(b);
      if (Number.isNaN(x) || Number.isNaN(y)) return Number.isNaN(x) - Number.isNaN(y) || coll.compare(a, b);
      return x - y || coll.compare(a, b); });
    case 'len': return lines.sort((a, b) => graphemeCount(a) - graphemeCount(b) || coll.compare(a, b));
    case 'rev': return lines.reverse();
    case 'shuffle': return shuffle(lines, rng);
    default: return lines;
  }
}

// ── find & replace ──────────────────────────────────────────────────
const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export function buildRegex(find, { caseSensitive = false, wholeWord = false, regex = false } = {}) {
  if (!find) return { re: null };
  const src = regex ? find : escRe(find);
  const flags = 'g' + (caseSensitive ? '' : 'i');
  if (wholeWord) {
    // Unicode-aware word edges (works for Hindi/Telugu); built at runtime so old Safari can't choke on parse.
    try { return { re: new RegExp(`(?<![\\p{L}\\p{N}\\p{M}_])(?:${src})(?![\\p{L}\\p{N}\\p{M}_])`, flags + 'u') }; } catch { /* fall back */ }
    try { return { re: new RegExp(`\\b(?:${src})\\b`, flags) }; } catch (e) { return { error: cleanReErr(e) }; }
  }
  // 'u' keeps emoji whole and makes \p{L} work; patterns only valid without it (like \-) fall back.
  try { return { re: new RegExp(src, flags + 'u') }; } catch { /* fall back */ }
  try { return { re: new RegExp(src, flags) }; } catch (e) { return { error: cleanReErr(e) }; }
}
const cleanReErr = e => String(e && e.message || e).replace(/^Invalid regular expression:\s*/i, '').replace(/^\/.*\/[a-z]*:\s*/, '');
/** Expand $1, $&, $<name>, $$… the way String.replace does, so one pass can both count and replace. */
function expandRep(rep, caps, pos, str, groups) {
  if (!rep.includes('$')) return rep;
  let out = '';
  for (let i = 0; i < rep.length; i++) {
    const c = rep[i], n = rep[i + 1];
    if (c !== '$' || n === undefined) out += c;
    else if (n === '$') { out += '$'; i++; }
    else if (n === '&') { out += caps[0]; i++; }
    else if (n === '`') { out += str.slice(0, pos); i++; }
    else if (n === "'") { out += str.slice(pos + caps[0].length); i++; }
    else if (n >= '0' && n <= '9') {
      let d = /^\d\d?/.exec(rep.slice(i + 1))[0];
      if (d.length === 2 && +d >= caps.length) d = d[0];               // "$12" with one group is $1 then "2"
      const k = +d;
      out += k >= 1 && k < caps.length ? caps[k] ?? '' : '$' + d;
      i += d.length;
    } else if (n === '<') {
      const gt = rep.indexOf('>', i + 2);
      if (gt < 0 || !groups) { out += '$<'; i++; } else { out += groups[rep.slice(i + 2, gt)] ?? ''; i = gt; }
    } else out += c;
  }
  return out;
}
export function findReplace(s, find, rep, opts = {}) {
  s = String(s || '');
  const { re, error } = buildRegex(find, opts);
  if (error) return { out: s, count: 0, error };
  if (!re) return { out: s, count: 0 };
  const r = opts.regex ? String(rep ?? '').replace(/\\n/g, '\n').replace(/\\t/g, '\t') : String(rep ?? '');
  let count = 0;
  const out = s.replace(re, (...a) => {
    count++;
    if (!opts.regex) return r;
    const groups = typeof a[a.length - 1] === 'object' ? a.pop() : undefined;
    const str = a.pop(), pos = a.pop();
    return expandRep(r, a, pos, str, groups);
  });
  return { out, count };
}

// ── extract emails / phones / links ─────────────────────────────────
// Bounded parts (RFC limits) keep this linear: an unbounded run before "@" made long tokens quadratic.
const EMAIL_RE = /[\p{L}\p{N}._%+-]{1,64}@(?:[\p{L}\p{N}-]{1,63}\.){1,8}\p{L}{2,24}/gu;
const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"'`]+/giu;
const PHONE_RE = /(?:\+|\b00|\()?\d[\d \t().-]{6,40}\d/g;
function trimUrl(u) {
  for (;;) {
    const c = u.slice(-1);
    if (/[.,;:!?'"’”*]/.test(c)) { u = u.slice(0, -1); continue; }
    const pairs = { ')': '(', ']': '[', '}': '{' };
    if (pairs[c] && u.split(pairs[c]).length < u.split(c).length) { u = u.slice(0, -1); continue; }
    return u;
  }
}
const fmtIN = d => `+91 ${d.slice(0, 5)} ${d.slice(5)}`;
/** Classify a phone-like string. Returns {key, display} or null when it isn't a plausible phone number. */
export function normalizePhone(raw) {
  const r = raw.trim().replace(/^\(?(?=\+)/, '');
  if (/^\d{4}[-./]\d{1,2}[-./]\d{1,2}$|^\d{1,2}[-./]\d{1,2}[-./]\d{2,4}$/.test(r)) return null;   // a date
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(r)) return null;                                             // an IP address
  let d = r.replace(/\D/g, '');
  const intl = r.startsWith('+') || r.startsWith('00');
  if (r.startsWith('00')) d = d.slice(2);
  if (intl) {
    if (d.length < 8 || d.length > 15) return null;
    if (/^91[6-9]\d{9}$/.test(d)) return { key: '+' + d, display: fmtIN(d.slice(2)) };
    return { key: '+' + d, display: (r.startsWith('00') ? '+' + r.slice(2) : r).replace(/\s+/g, ' ') };
  }
  if (/^[6-9]\d{9}$/.test(d)) return { key: '+91' + d, display: fmtIN(d) };
  if (/^0[6-9]\d{9}$/.test(d)) return { key: '+91' + d.slice(1), display: fmtIN(d.slice(1)) };
  if (/^91[6-9]\d{9}$/.test(d)) return { key: '+' + d, display: fmtIN(d.slice(2)) };
  if (/^0[1-9]\d{8,9}$/.test(d)) return { key: '+91' + d.slice(1), display: r.replace(/\s+/g, ' ') };    // landline with STD code
  if (/^1800\d{6,7}$/.test(d)) return { key: d, display: r.replace(/\s+/g, ' ') };                         // toll-free
  return null;
}
/** A run of digits may hold several numbers ("98765 43210, 91234 56789"): take the longest valid spans. */
function phonesIn(run) {
  const whole = normalizePhone(run);
  if (whole) return [whole];
  const toks = run.trim().split(/\s+/), res = [];
  for (let i = 0; i < toks.length; i++) {
    for (let j = toks.length; j > i; j--) {
      const p = normalizePhone(toks.slice(i, j).join(' '));
      if (p) { res.push(p); i = j - 1; break; }
    }
  }
  return res;
}
export function extractInfo(s) {
  s = String(s || '');
  const uniq = (arr, key = x => x) => { const seen = new Set(), out = []; for (const x of arr) { const k = key(x); if (!seen.has(k)) { seen.add(k); out.push(x); } } return out; };
  const urls = uniq((s.match(URL_RE) || []).map(trimUrl).filter(u => u.length > 4));
  const at = s.includes('@');
  const emails = at ? uniq(s.match(EMAIL_RE) || [], e => e.toLowerCase()) : [];
  const rest = at ? s.replace(URL_RE, ' ').replace(EMAIL_RE, ' ') : s.replace(URL_RE, ' ');
  const phones = uniq((rest.match(PHONE_RE) || []).flatMap(phonesIn), p => p.key).map(p => p.display);
  return { emails, phones, urls };
}

// ── diff (LCS) ──────────────────────────────────────────────────────
const DIFF_LIMIT = 5e6;
/** Longest-common-subsequence diff of two key arrays → [{t:'='|'-'|'+', i, j}] or null if too big. */
export function diffSeq(a, b) {
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let ea = a.length, eb = b.length;
  while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) { ea--; eb--; }
  const n = ea - s, m = eb - s;
  if (n * m > DIFF_LIMIT) return null;
  const W = m + 1, dp = (Math.min(n, m) < 65535 ? new Uint16Array((n + 1) * W) : new Uint32Array((n + 1) * W));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
    dp[i * W + j] = a[s + i] === b[s + j] ? dp[(i + 1) * W + j + 1] + 1 : Math.max(dp[(i + 1) * W + j], dp[i * W + j + 1]);
  const ops = [];
  for (let k = 0; k < s; k++) ops.push({ t: '=', i: k, j: k });
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[s + i] === b[s + j]) { ops.push({ t: '=', i: s + i, j: s + j }); i++; j++; }
    else if (dp[(i + 1) * W + j] >= dp[i * W + j + 1]) { ops.push({ t: '-', i: s + i }); i++; }
    else { ops.push({ t: '+', j: s + j }); j++; }
  }
  while (i < n) ops.push({ t: '-', i: s + i++ });
  while (j < m) ops.push({ t: '+', j: s + j++ });
  for (let k = 0; k < a.length - ea; k++) ops.push({ t: '=', i: ea + k, j: eb + k });
  return ops;
}
export function lineDiff(ta, tb, { ignoreCase = false, ignoreSpace = false } = {}) {
  const A = String(ta || '').replace(/\r\n?/g, '\n').split('\n'), B = String(tb || '').replace(/\r\n?/g, '\n').split('\n');
  const key = l => { if (ignoreSpace) l = l.trim().replace(/\s+/g, ' '); if (ignoreCase) l = l.toLowerCase(); return l; };
  const ops = diffSeq(A.map(key), B.map(key));
  if (!ops) return { tooBig: true };
  let added = 0, removed = 0, same = 0;
  for (const o of ops) o.t === '+' ? added++ : o.t === '-' ? removed++ : same++;
  return { ops, a: A, b: B, added, removed, same };
}
/** Word-level diff of two lines → [{t, s}] runs. */
export function wordDiff(x, y) {
  const tok = s => s.match(/\s+|[\p{L}\p{N}\p{M}_]+|[^\s\p{L}\p{N}\p{M}_]/gu) || [];
  const A = tok(x), B = tok(y);
  const ops = diffSeq(A, B);
  if (!ops) return null;
  const out = [];
  for (const o of ops) {
    const t = o.t, s = t === '+' ? B[o.j] : A[o.i];
    const last = out[out.length - 1];
    if (last && last.t === t) last.s += s; else out.push({ t, s });
  }
  return out;
}

// ── JSON (own parser: exact error positions on every browser, numbers kept verbatim) ──
export function jsonParse(s) {
  let i = 0;
  const fail = (msg, at = i) => { throw { jsonPos: at, msg }; };
  const ws = () => { for (;;) { const c = s.charCodeAt(i); if (c === 32 || c === 9 || c === 10 || c === 13 || (c === 0xFEFF && i === 0)) i++; else return; } };
  const str = () => {
    const st = i++;
    while (i < s.length) {
      const c = s.charCodeAt(i);
      if (c === 34) { i++; return s.slice(st, i); }
      if (c === 92) {
        const n = s[i + 1];
        if (n && '"\\/bfnrt'.includes(n)) { i += 2; continue; }
        if (n === 'u' && /^[0-9a-fA-F]{4}$/.test(s.slice(i + 2, i + 6))) { i += 6; continue; }
        fail('Invalid escape in a string (use \\\\ for a backslash)');
      }
      if (c < 32) fail(c === 10 || c === 13 ? 'This string isn’t closed before the line ends — add the closing "' : 'Tabs and control characters must be escaped inside strings (\\t)');
      i++;
    }
    fail('A string is never closed — add the closing "', st);
  };
  const num = () => {
    const m = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(s.slice(i, i + 1000));
    if (!m) fail('Invalid number');
    const nx = s[i + m[0].length];
    if (nx && /[0-9.eE]/.test(nx)) fail('Invalid number (no leading zeros; digits are needed after “.” and “e”)');
    i += m[0].length; return m[0];
  };
  const value = depth => {
    if (depth > 2000) fail('Nested too deeply');
    ws();
    if (i >= s.length) fail('The JSON ends too early — a value is missing');
    const c = s[i];
    if (c === '{') return obj(depth);
    if (c === '[') return arr(depth);
    if (c === '"') return { t: 'lit', raw: str() };
    if (c === '-' || (c >= '0' && c <= '9')) return { t: 'lit', raw: num() };
    for (const w of ['true', 'false', 'null']) if (s.startsWith(w, i)) { i += w.length; return { t: 'lit', raw: w }; }
    if (c === "'") fail('Use double quotes " for strings — single quotes aren’t allowed in JSON');
    if (c === '/') fail('Comments aren’t allowed in JSON');
    const word = /^[A-Za-z_$][\w$]*/.exec(s.slice(i, i + 40));
    if (word) fail(/^(undefined|NaN|Infinity|True|False|None|TRUE|FALSE|NULL|Null)$/.test(word[0])
      ? `“${word[0]}” isn’t valid JSON — use true, false or null` : 'Text values need double quotes, e.g. "hello"');
    if (c === ',') fail('Unexpected comma — a value is missing');
    fail(`Unexpected “${c}”`);
  };
  const obj = depth => {
    i++; const entries = []; ws();
    if (s[i] === '}') { i++; return { t: 'obj', entries }; }
    for (;;) {
      ws();
      if (s[i] === '}') fail('Remove the comma before } (trailing commas aren’t allowed)');
      if (i >= s.length) fail('The JSON ends before this object is closed — add }');
      if (s[i] !== '"') fail(s[i] === "'" ? 'Keys need double quotes " — not single quotes' : 'Keys must be in double quotes, e.g. "name"');
      const k = str(); ws();
      if (s[i] !== ':') fail('Missing “:” after the key');
      i++;
      entries.push([k, value(depth + 1)]); ws();
      if (s[i] === ',') { i++; continue; }
      if (s[i] === '}') { i++; return { t: 'obj', entries }; }
      if (i >= s.length) fail('The JSON ends before this object is closed — add }');
      fail('Missing comma between items (or a } to close the object)');
    }
  };
  const arr = depth => {
    i++; const items = []; ws();
    if (s[i] === ']') { i++; return { t: 'arr', items }; }
    for (;;) {
      ws();
      if (s[i] === ']') fail('Remove the comma before ] (trailing commas aren’t allowed)');
      items.push(value(depth + 1)); ws();
      if (s[i] === ',') { i++; continue; }
      if (s[i] === ']') { i++; return { t: 'arr', items }; }
      if (i >= s.length) fail('The JSON ends before this list is closed — add ]');
      fail('Missing comma between items (or a ] to close the list)');
    }
  };
  try {
    const node = value(0); ws();
    if (i < s.length) fail(s[i] === ',' ? 'Unexpected comma after the end of the JSON' : 'Extra text after the end of the JSON');
    return { ok: true, node };
  } catch (e) {
    if (!e || e.jsonPos == null) return { ok: false, pos: i, line: 1, col: 1, msg: e instanceof RangeError ? 'Nested too deeply' : String(e && e.message || e) };
    const before = s.slice(0, e.jsonPos);
    const line = (before.match(/\n/g) || []).length + 1;
    const col = e.jsonPos - (before.lastIndexOf('\n') + 1) + 1;
    return { ok: false, pos: e.jsonPos, line, col, msg: e.msg };
  }
}
export function jsonStringify(node, indent = 2, sortKeys = false) {
  const pad = typeof indent === 'number' ? ' '.repeat(indent) : indent;
  const out = [];
  const keyOf = k => { try { return JSON.parse(k); } catch { return k; } };
  const walk = (n, lvl) => {
    if (n.t === 'lit') { out.push(n.raw); return; }
    const items = n.t === 'obj' ? (sortKeys ? n.entries.slice().sort((a, b) => (keyOf(a[0]) < keyOf(b[0]) ? -1 : keyOf(a[0]) > keyOf(b[0]) ? 1 : 0)) : n.entries) : n.items;
    const [o, c] = n.t === 'obj' ? ['{', '}'] : ['[', ']'];
    if (!items.length) { out.push(o + c); return; }
    out.push(o);
    items.forEach((it, k) => {
      if (k) out.push(',');
      if (pad) out.push('\n' + pad.repeat(lvl + 1));
      if (n.t === 'obj') { out.push(it[0], pad ? ': ' : ':'); walk(it[1], lvl + 1); } else walk(it, lvl + 1);
    });
    if (pad) out.push('\n' + pad.repeat(lvl));
    out.push(c);
  };
  walk(node, 0);
  return out.join('');
}
export function formatJson(s, indent = 2, sortKeys = false) {
  if (!String(s || '').trim()) return { ok: false, empty: true };
  const r = jsonParse(String(s));
  if (!r.ok) return r;
  return { ok: true, out: jsonStringify(r.node, indent, sortKeys), node: r.node };
}

// ── text → lines for PDF pages ──────────────────────────────────────
/** Greedy word wrap with a measuring function; long words break between characters. */
export function wrapText(text, maxW, measure) {
  const out = [];
  for (const para of String(text || '').replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n')) {
    if (!para.trim()) { out.push(''); continue; }
    let line = '';
    for (const tok of para.match(/\s+|\S+/g)) {
      const cand = line + tok;
      if (measure(cand.trimEnd()) <= maxW) { line = cand; continue; }
      if (!tok.trim()) { if (line.trim()) out.push(line.trimEnd()); line = ''; continue; }
      if (line.trim()) { out.push(line.trimEnd()); line = ''; }
      if (measure(tok) <= maxW) { line = tok; continue; }
      for (const g of graphemeList(tok)) {
        if (line && measure(line + g) > maxW) { out.push(line); line = g; } else line += g;
      }
    }
    if (line.trim()) out.push(line.trimEnd());
  }
  return out;
}
/** Keep at most n lines; when some are cut, the last one ends in "…" so the cut shows. */
export function fitLines(lines, n, maxW, measure) {
  if (lines.length <= n) return lines;
  const out = lines.slice(0, n), g = graphemeList(out[n - 1].trimEnd());
  while (g.length && measure(g.join('') + '…') > maxW) g.pop();
  out[n - 1] = g.join('').trimEnd() + '…';
  return out;
}

// ── passwords ───────────────────────────────────────────────────────
export const SETS = { upper: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', lower: 'abcdefghijklmnopqrstuvwxyz', digits: '0123456789', symbols: '!@#$%^&*-_=+?.,:;~()[]{}' };
const LOOKALIKE = /[Il1O0o|]/g;
export function charPools(o) {
  return ['upper', 'lower', 'digits', 'symbols'].filter(k => o[k]).map(k => (o.noLookalike ? SETS[k].replace(LOOKALIKE, '') : SETS[k]));
}
/** Uniform over all passwords of that length that contain at least one char from every chosen set. */
export function genPassword(o, rng) {
  const pools = charPools(o), all = pools.join('');
  if (!all) return '';
  const len = Math.max(1, Math.min(256, o.length | 0));
  for (let tries = 0; tries < 10000; tries++) {
    let p = '';
    for (let k = 0; k < len; k++) p += all[randBelow(all.length, rng)];
    if (len < pools.length || pools.every(pl => Array.from(p).some(c => pl.includes(c)))) return p;
  }
  return '';
}
export const passwordBits = o => { const n = charPools(o).join('').length; return n ? o.length * Math.log2(n) : 0; };

export const WORDS = Array.from(new Set(`able acorn actor adapt agent alarm album alert alley amber angle ankle apple apron arena arrow aspen atlas attic audio autumn
badge bagel baker bamboo banana banjo barn basil basin basket beach beacon bean bear beaver bell bench berry bicycle bison blanket blaze blend bloom
blossom board boat bonus boots bottle bowl brain brave bread breeze brick bridge brook brush bucket buddy buffalo bugle bunny butter button cabin
cactus cake camel camera camp canal candle candy canoe canvas canyon carbon cargo carpet carrot castle cedar celery chair chalk charm cheese cherry
chess chief chili circle citrus clay cliff climb clock cloud clover coach coast cobra cocoa coffee comet compass cookie copper coral cotton couch
cougar cousin coyote crane crayon credit cricket crisp crown crystal cube cupcake curry cycle daisy dance delta denim desert diary diesel dinner
dolphin donkey dragon drawer dream drift drum eagle earth easel echo elbow ember emerald engine falcon fancy feather fence ferry fiber field finch
flame flash flute focus forest fossil frame fresh frost fruit galaxy garden garlic gecko giant ginger glacier globe glove goat golden gorilla grape
gravel guitar hammer harbor hazel helmet heron hiking hockey honey hoop horizon hotel humble iceberg igloo indigo island ivory jacket jaguar jasmine
jelly jewel jigsaw journal jungle kayak kettle kiwi koala ladder lagoon lamp lantern laptop lemon lilac lime linen lizard llama lobster locket lotus
lunar lychee magnet mango maple marble meadow melon mentor meteor mint mirror monkey moose mosaic mountain muffin museum mustard napkin nectar needle
noodle novel oasis ocean olive onion orange orbit orchid otter oyster paddle palace panda paper parrot pasta peach peanut pebble pencil pepper piano
pickle pigeon pillow pilot pine pirate pizza planet plaza plum pocket polar pony poppy potato prism pumpkin puzzle quartz quill rabbit radar radio
radish rain raven recipe reef ribbon river robin rocket rose ruby saddle safari salad salmon sandal saturn scarf school scout season seed shadow
shell shrimp silver singer sketch sloth smile snail snow socks solar spice spider spoon spring squash stable star statue stone storm sugar summer
sunset swan sweater table tablet taco tango teapot temple tennis thunder tiger timber toast tomato topaz torch tower tractor train tulip tunnel
turtle umbrella unicorn valley vanilla velvet violin volcano wafer wagon walnut walrus water whale wheat whistle willow window winter wizard wolf
yogurt zebra zipper`.split(/\s+/).filter(Boolean)));
export function genPassphrase({ words = 6, sep = '-', cap = true, num = true } = {}, rng) {
  const w = Array.from({ length: words }, () => WORDS[randBelow(WORDS.length, rng)]).map(x => (cap ? x[0].toUpperCase() + x.slice(1) : x));
  if (num) { const k = randBelow(w.length, rng); w[k] += String(randBelow(10, rng)); }
  return w.join(sep);
}
export const passphraseBits = ({ words = 6, num = true } = {}) => words * Math.log2(WORDS.length) + (num ? Math.log2(10 * words) : 0);
export function strengthOf(bits) {
  if (bits < 40) return { label: 'Weak', color: 'var(--err)', level: 1 };
  if (bits < 60) return { label: 'Fair', color: 'var(--warn)', level: 2 };
  if (bits < 80) return { label: 'Strong', color: 'var(--ok)', level: 3 };
  return { label: 'Very strong', color: 'var(--ok)', level: 4 };
}
/** Rough time to brute-force at 10 billion guesses/second (half the space on average). */
export function crackTime(bits) {
  const sec = Math.pow(2, bits - 1) / 1e10;
  const p = (n, u) => { const r = Math.max(1, Math.round(n)); return `${r.toLocaleString('en-IN')} ${u}${r === 1 ? '' : 's'}`; };
  if (sec < 1) return 'under a second';
  if (sec < 60) return p(sec, 'second');
  if (sec < 3600) return p(sec / 60, 'minute');
  if (sec < 86400) return p(sec / 3600, 'hour');
  const yrs = sec / 31557600;
  if (yrs < 1) return p(sec / 86400, 'day');
  if (yrs < 1000) return p(yrs, 'year');
  if (yrs < 1e6) return `${Math.round(yrs / 1e3)} thousand years`;
  if (yrs < 1e9) return `${Math.round(yrs / 1e6)} million years`;
  if (yrs < 1e12) return `${Math.round(yrs / 1e9)} billion years`;
  return 'trillions of years';
}

// ── speech ──────────────────────────────────────────────────────────
/** Split text into sentence-sized chunks (≤ max chars) so long texts play reliably. */
export function chunkSpeech(text, max = 200) {
  // A mark ends a sentence only before a space or the end, so 7.5%, 1,299.50, 10.30 and www.x.in stay whole.
  const pieces = (String(text || '').match(/(?:[^.!?।॥\n]|[.!?।॥](?!\s|$))+[.!?।॥]*|[.!?।॥]+/g) || []).map(x => x.replace(/\s+/g, ' ').trim()).filter(x => WORDCH.test(x));
  const out = [];
  const pushLong = p => {
    if (p.length <= max) { out.push(p); return; }
    let cur = '';
    const add = w => { if (cur && (cur + ' ' + w).length > max) { out.push(cur); cur = w; } else cur = cur ? cur + ' ' + w : w; };
    for (const clause of p.match(/(?:[^,;:]|[,;:](?!\s|$))+[,;:]*/g) || [p]) {        // prefer breaking after commas (not inside 1,299 or 10:30)
      const c = clause.trim(); if (!c) continue;
      if (c.length > max) c.split(/\s+/).forEach(add);
      else if (cur && (cur + ' ' + c).length > max) { out.push(cur); cur = c; } else add(c);
    }
    if (cur) out.push(cur);
  };
  for (const p of pieces) pushLong(p);
  const merged = [];
  for (const p of out) { const last = merged[merged.length - 1]; if (last && (last + ' ' + p).length <= max) merged[merged.length - 1] = last + ' ' + p; else merged.push(p); }
  return merged;
}

// ═════════════════════════════ UI helpers ═════════════════════════════
const muted = t => h('p', { class: 'muted small', style: { margin: 0 } }, t);
const ta = (label, placeholder, rows = 8, value = '') => field({ label, type: 'textarea', rows, placeholder, value });
function toggle(label, checked, onChange) {
  const input = h('input', { type: 'checkbox', style: { width: '22px', height: '22px', accentColor: 'var(--brand)', margin: 0, flex: 'none' } });
  input.checked = !!checked;
  input.addEventListener('change', () => onChange && onChange(input.checked));
  const el = h('label', { style: { display: 'flex', alignItems: 'center', gap: '10px', minHeight: '44px', cursor: 'pointer', fontSize: '15px' } }, input, h('span', {}, label));
  return { el, input, get checked() { return input.checked; }, set checked(v) { input.checked = v; } };
}
/** A segmented control split over rows of ≤ perRow options, acting as one control. */
function segRows(options, value, onChange, perRow = 4) {
  const rows = [];
  const pick = v => { value = v; for (const r of rows) r.setValue(v); onChange(v); };
  for (let k = 0; k < options.length; k += perRow) rows.push(segmented(options.slice(k, k + perRow), value, pick));
  return { el: h('div', { class: 'stack', style: { gap: '6px' } }, rows), get value() { return value; } };
}
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
/** Range slider that survives the app's input styling (appearance:none would hide it on iOS). */
function slider(label, { min, max, step = 1, value }, onInput, fmt = v => v) {
  const out = h('b', {}, fmt(value));
  const input = h('input', { type: 'range', min, max, step, 'aria-label': label,
    style: { appearance: 'auto', WebkitAppearance: 'auto', width: '100%', padding: '0', border: '0', background: 'none', boxShadow: 'none', accentColor: 'var(--brand)', height: '32px', margin: '0' } });
  input.value = String(value);
  input.addEventListener('input', () => { out.textContent = fmt(+input.value); onInput(+input.value); });
  const el = h('div', { class: 'stack', style: { gap: '4px' } },
    h('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: '13px', fontWeight: '600', color: 'var(--muted)' } }, h('span', {}, label), out), input);
  return { el, input, get value() { return +input.value; }, set value(v) { input.value = String(v); out.textContent = fmt(+v); } };
}
const onLeave = (root, fn) => {
  const ac = new AbortController();
  const done = () => { ac.abort(); fn(); };
  addEventListener('hashchange', done, { signal: ac.signal });
  addEventListener('pagehide', done, { signal: ac.signal });
  return done;
};
const ADD = 'rgba(17,144,90,.16)', DEL = 'rgba(207,52,52,.16)', ADD2 = 'rgba(17,144,90,.38)', DEL2 = 'rgba(207,52,52,.38)';

// ═════════════════════════════ mount ═════════════════════════════
export async function mount(root, toolId) {
  const fn = { wordcount: mountWordcount, changecase: mountCase, cleanup: mountCleanup, sortlines: mountSort, findreplace: mountFind,
    extractinfo: mountExtract, compare: mountCompare, jsonformat: mountJson, text2pdf: mountPdf, password: mountPassword,
    randnum: mountRandom, checklist: mountChecklist, tts: r => mountTts(r, 'en'), tts_lang: r => mountTts(r, 'hi') }[toolId];
  try {
    if (!fn) { root.append(notice('This tool isn’t available yet.', 'warn')); return; }
    await fn(root);
  } catch (e) {
    console.error(e);
    root.append(notice('Something went wrong setting up this tool. Please reload the page.', 'err'));
  }
}

// ── Word count ──────────────────────────────────────────────────────
function mountWordcount(root) {
  const T = ta('Your text', 'Type or paste text here…', 9);
  const out = h('div');
  const clear = button('Clear', () => { T.value = ''; upd(); T.input.focus(); }, { variant: 'ghost', small: true });
  root.append(card({}, T.el, clear), card({ title: 'Counts' }, out));
  const upd = () => {
    const s = textStats(T.value);
    out.replaceChildren(stats([['Words', s.words.toLocaleString('en-IN')], ['Characters', s.characters.toLocaleString('en-IN')],
      ['Without spaces', s.charactersNoSpaces.toLocaleString('en-IN')], ['Sentences', s.sentences.toLocaleString('en-IN')],
      ['Paragraphs', s.paragraphs.toLocaleString('en-IN')], ['Lines', s.lines.toLocaleString('en-IN')],
      ['Reading time', fmtDuration(s.readingSec)], ['Speaking time', fmtDuration(s.speakingSec)]]));
  };
  T.input.addEventListener('input', upd); upd();
}

// ── Change case ─────────────────────────────────────────────────────
function mountCase(root) {
  const T = ta('Your text', 'Type or paste text here…', 7);
  let mode = store.get('text:case', 'title');
  const seg = segRows([['upper', 'UPPER'], ['lower', 'lower'], ['title', 'Title'], ['sentence', 'Sentence'],
    ['alternate', 'aLtErNaTe'], ['snake', 'snake_case'], ['kebab', 'kebab-case']], mode, v => { mode = v; store.set('text:case', v); upd(); });
  const out = outputBox('');
  root.append(card({}, T.el), card({ title: 'Change to' }, seg.el), card({ title: 'Result' }, out));
  const upd = () => out.set(changeCase(T.value, mode) || '');
  T.input.addEventListener('input', debounce(upd, 80)); upd();
}

// ── Clean up ────────────────────────────────────────────────────────
function mountCleanup(root) {
  const T = ta('Your text', 'Paste messy text here…', 8);
  const saved = store.get('text:cleanup', null) || { trim: true, collapse: true, blank: false, dupes: false, bullets: false, joinBroken: false };
  const opts = { ...saved };
  const tg = (k, label) => toggle(label, opts[k], v => { opts[k] = v; store.set('text:cleanup', opts); upd(); }).el;
  const out = outputBox('');
  const info = h('div', { class: 'small muted' });
  root.append(card({}, T.el),
    card({ title: 'Fix' }, tg('trim', 'Trim spaces at line ends'), tg('collapse', 'Collapse repeated spaces'), tg('blank', 'Remove blank lines'),
      tg('dupes', 'Remove duplicate lines'), tg('bullets', 'Remove line numbers & bullets'), tg('joinBroken', 'Join broken lines (text copied from PDFs)')),
    card({ title: 'Result' }, out, info));
  const upd = () => {
    const r = cleanupText(T.value, opts);
    out.set(r.text);
    info.textContent = T.value ? `${r.removed ? `${r.removed} line${r.removed === 1 ? '' : 's'} removed · ` : ''}${textStats(r.text).characters.toLocaleString('en-IN')} characters` : '';
  };
  T.input.addEventListener('input', upd); upd();
}

// ── Sort lines ──────────────────────────────────────────────────────
function mountSort(root) {
  const T = ta('Lines to sort', 'One item per line…', 8);
  let mode = 'az';
  const opts = { unique: false, ignoreCase: true };
  const seg = segRows([['az', 'A → Z'], ['za', 'Z → A'], ['num', '0 → 9'], ['len', 'Length'], ['rev', 'Reverse'], ['shuffle', 'Shuffle']], mode, v => { mode = v; again.classList.toggle('hidden', v !== 'shuffle'); upd(); }, 3);
  const again = button('↻ Shuffle again', () => upd(), { variant: 'secondary', small: true });
  again.classList.add('hidden');
  const out = outputBox('');
  const info = h('div', { class: 'small muted' });
  root.append(card({}, T.el),
    card({ title: 'Sort' }, seg.el, again, toggle('Remove duplicates', false, v => { opts.unique = v; upd(); }).el,
      toggle('Ignore capital letters', true, v => { opts.ignoreCase = v; upd(); }).el),
    card({ title: 'Result' }, out, info));
  const upd = () => {
    const r = sortLines(T.value, mode, opts);
    out.set(r.join('\n'));
    info.textContent = T.value.trim() ? `${r.length} line${r.length === 1 ? '' : 's'} · blank lines are skipped${mode === 'num' ? ' · lines without a number go last' : ''}` : '';
  };
  T.input.addEventListener('input', debounce(upd, 80)); upd();
}

// ── Find & replace ──────────────────────────────────────────────────
// A typed pattern like (\w+\s?)+$ can backtrack for minutes, and a running regex can't be interrupted.
// So Pattern mode runs in a worker (built from the same functions as above) that is thrown away when it takes too long.
const RE_TIMEOUT = 1500;
let reWorkerUrl = null;
function regexWorker() {
  reWorkerUrl ||= URL.createObjectURL(new Blob([`const escRe = ${escRe};\nconst cleanReErr = ${cleanReErr};\n${buildRegex}\n${expandRep}\n${findReplace}\n`
    + 'onmessage = e => { const t0 = Date.now(), r = findReplace(...e.data.args); postMessage({ id: e.data.id, ms: Date.now() - t0, ...r }); };'], { type: 'text/javascript' }));
  return new Worker(reWorkerUrl);
}
function mountFind(root) {
  const T = ta('Your text', 'Paste text here…', 8);
  const F = field({ label: 'Find', placeholder: 'Word or phrase' });
  const R = field({ label: 'Replace with', placeholder: 'Leave empty to delete matches' });
  const o = { caseSensitive: false, wholeWord: false, regex: false };
  const tg = (k, l) => toggle(l, false, v => { o[k] = v; upd(); }).el;
  const count = h('div', { style: { marginBottom: '14px' } });
  const out = outputBox('');
  root.append(card({}, T.el), card({ title: 'Find & replace' }, F.el, R.el, tg('caseSensitive', 'Match capital letters exactly'), tg('wholeWord', 'Whole words only'),
    tg('regex', 'Pattern (regular expression)')), count, card({ title: 'Result' }, out));
  const show = r => {
    out.set(r.out);
    count.replaceChildren(r.error ? notice(`That pattern isn’t valid: ${r.error}`, 'err')
      : !F.value ? muted('Type what to find.')
        : r.count ? notice(`${r.count.toLocaleString('en-IN')} match${r.count === 1 ? '' : 'es'} replaced`, 'ok')
          // Safari quietly reports "no match" when a pattern backtracks too much, so a slow miss may not be a real miss.
          : notice(r.ms > 300 ? 'No matches found. This pattern is slow on this text, so some matches may have been missed. Try a more specific pattern.' : 'No matches found', 'info'));
  };
  let worker = null, job = 0, running = false, timers = [];
  const stop = () => { timers.forEach(clearTimeout); timers = []; if (worker && running) { worker.terminate(); worker = null; } running = false; };
  const upd = () => {
    const id = ++job;
    stop();
    if (!o.regex || !F.value || typeof Worker === 'undefined') return show(findReplace(T.value, F.value, R.value, o));
    try { worker ||= regexWorker(); } catch { return show(findReplace(T.value, F.value, R.value, o)); }
    worker.onmessage = e => { if (e.data.id !== job) return; running = false; stop(); show(e.data); };
    worker.onerror = e => { e.preventDefault(); if (id !== job) return; stop(); count.replaceChildren(notice('Couldn’t run this pattern here. Please reload the page and try again.', 'err')); };
    running = true;
    worker.postMessage({ id, args: [T.value, F.value, R.value, { ...o }] });
    timers.push(setTimeout(() => { if (id === job) count.replaceChildren(muted('Searching…')); }, 300),
      setTimeout(() => { if (id !== job) return; stop(); count.replaceChildren(notice('This pattern takes too long on this text, so it was stopped. Try a more specific pattern.', 'warn')); }, RE_TIMEOUT));
  };
  const quick = debounce(upd, 60), slow = debounce(upd, 250);        // patterns wait for a pause in typing
  for (const f of [T, F, R]) f.input.addEventListener('input', () => (o.regex ? slow : quick)());
  onLeave(root, () => { job++; stop(); if (worker) worker.terminate(); worker = null; });
  upd();
}

// ── Extract emails / phones / links ─────────────────────────────────
function mountExtract(root) {
  const T = ta('Your text', 'Paste a message, page or document…', 9);
  const out = h('div');
  root.append(card({}, T.el), out);
  const group = (title, items, icon) => card({ title: `${icon} ${title} · ${items.length}` },
    items.length ? h('div', { class: 'stack', style: { gap: '0' } },
      items.map(x => h('div', { class: 'mono', style: { padding: '9px 2px', borderBottom: '1px solid var(--line)', wordBreak: 'break-all', fontSize: '14px' } }, x)))
      : muted('None found.'),
    items.length ? copyButton(items.join('\n'), `Copy all ${items.length}`) : null);
  const upd = () => {
    if (!T.value.trim()) { out.replaceChildren(muted('Paste text above — emails, phone numbers and links are pulled out automatically.')); return; }
    const r = extractInfo(T.value);
    out.replaceChildren(group('Emails', r.emails, '✉️'), group('Phone numbers', r.phones, '📞'), group('Links', r.urls, '🔗'));
  };
  T.input.addEventListener('input', debounce(upd, 120)); upd();
}

// ── Compare ─────────────────────────────────────────────────────────
function mountCompare(root) {
  const A = ta('Original', 'Paste the first version…', 6), B = ta('Changed', 'Paste the second version…', 6);
  const o = { ignoreCase: false, ignoreSpace: false };
  const out = h('div');
  root.append(card({}, A.el, B.el, toggle('Ignore capital letters', false, v => { o.ignoreCase = v; upd(); }).el,
    toggle('Ignore spaces', false, v => { o.ignoreSpace = v; upd(); }).el), out);
  const rowStyle = (bg) => ({ display: 'flex', gap: '8px', padding: '3px 8px', background: bg || '', whiteSpace: 'pre-wrap', wordBreak: 'break-word', minHeight: '1.5em' });
  const lineEl = (sign, content, bg) => h('div', { style: rowStyle(bg) },
    h('span', { style: { flex: 'none', width: '12px', color: sign === '+' ? 'var(--ok)' : sign === '−' ? 'var(--err)' : 'var(--faint)', fontWeight: '700' } }, sign), h('span', { style: { flex: '1', minWidth: '0' } }, content));
  const inline = (runs, keep) => runs.filter(r => r.t === '=' || r.t === keep).map(r => r.t === '=' ? r.s : h('span', { style: { background: keep === '+' ? ADD2 : DEL2, borderRadius: '3px' } }, r.s));
  function upd() {
    if (!A.value && !B.value) { out.replaceChildren(card(muted('Paste two versions above to see what changed.'))); return; }
    const d = lineDiff(A.value, B.value, o);
    if (d.tooBig) { out.replaceChildren(notice('These texts are too long to compare here (about 2,000 changed lines at most). Try comparing a smaller part.', 'warn')); return; }
    const body = h('div', { class: 'mono', style: { fontSize: '13px', lineHeight: '1.5', borderRadius: '12px', overflow: 'hidden', border: '1px solid var(--line)' } });
    const ops = d.ops;
    let k = 0;
    while (k < ops.length) {
      if (ops[k].t === '=') {
        let e = k; while (e < ops.length && ops[e].t === '=') e++;
        const run = ops.slice(k, e), CTX = 2;
        if (run.length > CTX * 2 + 2) {
          const head = k === 0 ? [] : run.slice(0, CTX), tail = e === ops.length ? [] : run.slice(-CTX);
          for (const x of head) body.append(lineEl(' ', d.b[x.j]));
          const hidden = run.slice(head.length, run.length - tail.length);
          const more = h('button', { type: 'button', style: { display: 'block', width: '100%', border: '0', background: 'var(--surface-2)', color: 'var(--muted)', padding: '8px', font: 'inherit', fontSize: '12.5px', cursor: 'pointer' } },
            `⋯ ${hidden.length} unchanged line${hidden.length === 1 ? '' : 's'} — tap to show`);
          more.onclick = () => more.replaceWith(...hidden.map(x => lineEl(' ', d.b[x.j])));
          body.append(more);
          for (const x of tail) body.append(lineEl(' ', d.b[x.j]));
        } else for (const x of run) body.append(lineEl(' ', d.b[x.j]));
        k = e; continue;
      }
      let e = k; while (e < ops.length && ops[e].t !== '=') e++;
      const dels = ops.slice(k, e).filter(x => x.t === '-'), adds = ops.slice(k, e).filter(x => x.t === '+');
      const pairs = Math.min(dels.length, adds.length);
      const runsFor = idx => (idx < pairs && d.a[dels[idx].i].length < 600 && d.b[adds[idx].j].length < 600) ? wordDiff(d.a[dels[idx].i], d.b[adds[idx].j]) : null;
      const runs = dels.map((_, x) => runsFor(x));
      dels.forEach((x, n) => body.append(lineEl('−', runs[n] ? inline(runs[n], '-') : d.a[x.i], DEL)));
      adds.forEach((x, n) => body.append(lineEl('+', runs[n] ? inline(runs[n], '+') : d.b[x.j], ADD)));
      k = e;
    }
    const same = !d.added && !d.removed;
    out.replaceChildren(
      same ? notice('The two texts are identical' + (o.ignoreCase || o.ignoreSpace ? ' (with the options above).' : '.'), 'ok')
        : card({ title: 'What changed' },
          h('div', { class: 'small', style: { display: 'flex', gap: '14px', flexWrap: 'wrap', fontWeight: '650' } },
            h('span', { style: { color: 'var(--ok)' } }, `+${d.added} added`), h('span', { style: { color: 'var(--err)' } }, `−${d.removed} removed`),
            h('span', { class: 'muted' }, `${d.same} unchanged`)),
          body));
  }
  const dd = debounce(upd, 200);
  A.input.addEventListener('input', dd); B.input.addEventListener('input', dd); upd();
}

// ── JSON ────────────────────────────────────────────────────────────
function mountJson(root) {
  const T = field({ label: 'JSON', type: 'textarea', rows: 10, placeholder: '{"name": "SnappTo", "offline": true}' });
  T.input.classList.add('mono');
  Object.assign(T.input.style, { fontSize: '13.5px', fontFamily: 'var(--mono)' });
  let mode = '2';
  let sortKeys = false;
  const seg = segmented([['2', '2 spaces'], ['4', '4 spaces'], ['min', 'Minify']], mode, v => { mode = v; upd(); });
  const status = h('div');
  const out = outputBox('', { mono: true });
  const outCard = card({ title: 'Formatted' }, out);
  root.append(card({}, T.el, seg, toggle('Sort keys A → Z', false, v => { sortKeys = v; upd(); }).el), status, outCard);
  function upd() {
    const r = formatJson(T.value, mode === 'min' ? '' : +mode, sortKeys);
    status.style.marginBottom = '14px';
    if (r.empty) { status.replaceChildren(muted('Paste JSON above — it’s checked and formatted as you type.')); outCard.classList.add('hidden'); return; }
    if (!r.ok) {
      const lines = T.value.split('\n'), L = lines[r.line - 1] ?? '';
      const from = Math.max(0, r.col - 40), seg2 = L.slice(from, from + 80).replace(/\t/g, ' ');
      const caret = ' '.repeat(Math.max(0, r.col - 1 - from)) + '^';
      status.replaceChildren(notice(h('div', {}, h('b', {}, `Line ${r.line}, column ${r.col}: `), r.msg,
        h('pre', { class: 'mono', style: { margin: '8px 0 0', padding: '8px 10px', background: 'var(--surface)', borderRadius: '8px', overflowX: 'auto', fontSize: '12.5px', whiteSpace: 'pre' } },
          (from ? '…' : '') + seg2 + '\n' + (from ? ' ' : '') + caret)), 'err'));
      outCard.classList.add('hidden');
      return;
    }
    const top = r.node.t === 'obj' ? `${r.node.entries.length} key${r.node.entries.length === 1 ? '' : 's'}` : r.node.t === 'arr' ? `${r.node.items.length} item${r.node.items.length === 1 ? '' : 's'}` : 'a single value';
    status.replaceChildren(notice(`Valid JSON · ${top} at the top level`, 'ok'));
    out.set(r.out); outCard.classList.remove('hidden');
  }
  T.input.addEventListener('input', debounce(upd, 150)); upd();
}

// ── Text → PDF ──────────────────────────────────────────────────────
const A4 = [595.28, 841.89];
function mountPdf(root) {
  const Ti = field({ label: 'Title (optional)', placeholder: 'e.g. Meeting notes' });
  const T = ta('Text', 'Type or paste your text — any language works: English, हिन्दी, తెలుగు, emoji 🙂', 10);
  let size = 12;
  const seg = segmented([['10', 'Small'], ['12', 'Medium'], ['15', 'Large'], ['19', 'Extra large']], '12', v => { size = +v; });
  const out = h('div');
  const go = button('Make PDF', () => busy(go, async () => {
    out.replaceChildren();
    if (!T.value.trim()) { out.append(notice('Type or paste some text first.', 'warn')); return; }
    const p = progress('Laying out pages…'); out.append(p.el);
    try {
      const blob = await textToPdf(T.value, { title: Ti.value.trim(), size }, (k, n) => p.set(n ? k / n : null, `Page ${k} of ${n}`));
      p.done();
      const name = (Ti.value.trim() || T.value.trim().split('\n')[0]).replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').trim().slice(0, 40).trim() || 'notes';
      out.append(await resultCard({ title: 'PDF ready', blob, filename: `${name}.pdf`, note: 'Pages are saved as images so every language and emoji prints correctly — the text isn’t selectable in the PDF.' }));
    } catch (e) { console.error(e); p.fail('Couldn’t make the PDF — ' + (e.message || 'please try again with shorter text')); }
  }), { full: true });
  root.append(card({}, Ti.el, T.el), card({ title: 'Text size' }, seg), go, out);
}
async function textToPdf(text, { title, size }, onProgress) {
  const { PDFDocument } = await libs.pdfLib();
  const S = 2, M = 54, [PW, PH] = A4;
  const W = Math.round(PW * S), H = Math.round(PH * S);
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Noto Sans", "Noto Sans Devanagari", "Noto Sans Telugu", "Nirmala UI", sans-serif';
  const px = size * S, lh = Math.round(px * 1.5), maxW = (PW - 2 * M) * S;
  const tpx = Math.round(px * 1.6), tlh = Math.round(tpx * 1.25);
  ctx.font = `600 ${tpx}px ${FONT}`;
  const tLines = title ? fitLines(wrapText(title, maxW, s => ctx.measureText(s).width), 4, maxW, s => ctx.measureText(s).width) : [];
  ctx.font = `${px}px ${FONT}`;
  const lines = wrapText(text, maxW, s => ctx.measureText(s).width);
  const top = M * S, bottom = H - M * S - 18 * S;
  const titleH = tLines.length ? tLines.length * tlh + Math.round(tpx * 0.5) + 10 * S : 0;
  const pages = []; let cur = [], y = top + titleH;
  for (const l of lines) {
    if (y + lh > bottom && cur.length) { pages.push(cur); cur = []; y = top; }
    cur.push(l); y += lh;
  }
  pages.push(cur);
  const doc = await PDFDocument.create();
  if (title) doc.setTitle(title);
  doc.setCreator('SnappTo');
  for (let k = 0; k < pages.length; k++) {
    onProgress && onProgress(k + 1, pages.length);
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#111'; ctx.textBaseline = 'alphabetic';
    let yy = top;
    if (k === 0 && tLines.length) {
      ctx.font = `600 ${tpx}px ${FONT}`;
      tLines.forEach((t, i) => ctx.fillText(t, M * S, yy + tpx + i * tlh));
      yy += titleH;
    }
    ctx.font = `${px}px ${FONT}`;
    for (const l of pages[k]) { if (l) ctx.fillText(l, M * S, yy + px); yy += lh; }
    if (pages.length > 1) {
      ctx.font = `${9 * S}px ${FONT}`; ctx.fillStyle = '#888'; ctx.textAlign = 'center';
      ctx.fillText(`${k + 1} / ${pages.length}`, W / 2, H - (M * S) / 2);
      ctx.textAlign = 'left';
    }
    const jpg = await canvasToBlob(cv, 'image/jpeg', 0.9);
    const img = await doc.embedJpg(new Uint8Array(await jpg.arrayBuffer()));
    doc.addPage(A4).drawImage(img, { x: 0, y: 0, width: PW, height: PH });
    await new Promise(r => setTimeout(r, 0));
  }
  cv.width = cv.height = 0;
  return new Blob([await doc.save()], { type: 'application/pdf' });
}

// ── Password ────────────────────────────────────────────────────────
function mountPassword(root) {
  const o = { length: 16, upper: true, lower: true, digits: true, symbols: true, noLookalike: false, ...(store.get('text:pw', {}) || {}) };
  const pp = { words: 6, sep: '-', cap: true, num: true, ...(store.get('text:pp', {}) || {}) };
  let mode = store.get('text:pwmode', 'password') === 'phrase' ? 'phrase' : 'password';
  const pwText = h('div', { class: 'mono', style: { fontSize: '20px', fontWeight: '600', lineHeight: '1.4', wordBreak: 'break-all', padding: '14px', background: 'var(--surface-2)', borderRadius: '12px', minHeight: '58px', userSelect: 'all', WebkitUserSelect: 'all' } });
  const meter = h('div', { style: { display: 'flex', gap: '5px' } });
  const meterTxt = h('div', { class: 'small muted' });
  let current = '';
  const regen = () => {
    const opts = { ...o };
    current = mode === 'phrase' ? genPassphrase(pp) : genPassword(opts);
    pwText.textContent = current || '—';
    const bits = mode === 'phrase' ? passphraseBits(pp) : passwordBits(opts);
    const s = strengthOf(bits);
    meter.replaceChildren(...[1, 2, 3, 4].map(k => h('div', { style: { flex: '1', height: '6px', borderRadius: '9px', background: k <= s.level ? s.color : 'var(--line)' } })));
    meterTxt.replaceChildren(h('b', { style: { color: s.color } }, s.label), ` · ${Math.round(bits)} bits · brute force: ~${crackTime(bits)}`);
    if (!current) meterTxt.replaceChildren('Pick at least one type of character.');
  };
  const save = () => { store.set('text:pw', o); store.set('text:pp', pp); store.set('text:pwmode', mode); };
  const copy = copyButton(() => current, 'Copy');
  Object.assign(copy.style, { flex: '1' }); copy.classList.remove('btn-ghost', 'btn-sm'); copy.classList.add('btn-primary');
  const again = button('↻ New', regen, { variant: 'secondary' }); again.style.flex = '1';
  const pwOpts = h('div', { class: 'stack' },
    slider('Length', { min: 8, max: 64, value: o.length }, v => { o.length = v; save(); regen(); }).el,
    ...[['upper', 'Capital letters (A–Z)'], ['lower', 'Small letters (a–z)'], ['digits', 'Numbers (0–9)'], ['symbols', 'Symbols (!@#…)'], ['noLookalike', 'Avoid look-alikes (I l 1 O 0)']]
      .map(([k, l]) => toggle(l, o[k], v => { o[k] = v; save(); regen(); }).el));
  const ppOpts = h('div', { class: 'stack' },
    slider('Words', { min: 3, max: 10, value: pp.words }, v => { pp.words = v; save(); regen(); }).el,
    h('div', { class: 'field' }, h('label', {}, 'Between words'), segmented([['-', 'Dash -'], [' ', 'Space'], ['.', 'Dot .'], ['_', 'Under _']], pp.sep, v => { pp.sep = v; save(); regen(); })),
    toggle('Capitalise each word', pp.cap, v => { pp.cap = v; save(); regen(); }).el,
    toggle('Add a number', pp.num, v => { pp.num = v; save(); regen(); }).el,
    muted('Passphrases are easier to type and remember. Words come from a built-in list of common words.'));
  const modeSeg = segmented([['password', 'Password'], ['phrase', 'Passphrase']], mode, v => { mode = v; save(); pwOpts.classList.toggle('hidden', v !== 'password'); ppOpts.classList.toggle('hidden', v !== 'phrase'); regen(); });
  pwOpts.classList.toggle('hidden', mode !== 'password'); ppOpts.classList.toggle('hidden', mode !== 'phrase');
  root.append(card({}, modeSeg, pwText, meter, meterTxt, h('div', { style: { display: 'flex', gap: '10px' } }, copy, again)),
    card({ title: 'Options' }, pwOpts, ppOpts),
    h('p', { class: 'faint small', style: { margin: '4px 6px' } }, 'Made on your phone with secure randomness. Nothing is saved or sent anywhere.'));
  regen();
}

// ── Random number / dice / coin / pick ──────────────────────────────
const DICE = ['⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];
function mountRandom(root) {
  let mode = 'number';
  const panes = {}, out = h('div', { style: { minHeight: '90px' } }), hist = h('div', { class: 'small muted' });
  const history = [];
  const show = (main, sub, histTxt) => {
    out.replaceChildren(answer(main, sub));
    out.firstChild.animate?.([{ opacity: 0, transform: 'scale(.94)' }, { opacity: 1, transform: 'none' }], { duration: 220, easing: 'ease-out' });
    history.unshift(histTxt ?? main); history.length = Math.min(history.length, 8);
    hist.textContent = history.length > 1 ? 'Before: ' + history.slice(1).join(' · ') : '';
  };
  // number
  // No inputmode on From/To: the iPhone number pad has no minus key, and these may be negative.
  const Min = field({ label: 'From', value: '1' }), Max = field({ label: 'To', value: '100' });
  const Cnt = field({ label: 'How many', inputmode: 'numeric', value: '1' });
  let noRep = true;
  panes.number = h('div', { class: 'stack' }, h('div', { class: 'row' }, Min.el, Max.el), Cnt.el, toggle('No repeats', true, v => { noRep = v; }).el);
  // dice
  let dice = 1;
  panes.dice = h('div', { class: 'stack' }, h('div', { class: 'field' }, h('label', {}, 'Number of dice'),
    segmented([1, 2, 3, 4, 5, 6].map(n => [String(n), String(n)]), '1', v => { dice = +v; })));
  // coin
  panes.coin = muted('Heads or tails — a fair, random flip.');
  // pick
  const L = ta('Your list', 'One per line or separated by commas — names, places, ideas…', 6);
  const N = field({ label: 'How many to pick', inputmode: 'numeric', value: '1' });
  panes.pick = h('div', { class: 'stack' }, L.el, N.el);
  const modeSeg = segmented([['number', 'Number'], ['dice', 'Dice'], ['coin', 'Coin'], ['pick', 'Pick']], mode, v => {
    mode = v; for (const [k, p] of Object.entries(panes)) p.classList.toggle('hidden', k !== v);
    goLbl.textContent = { number: 'Generate', dice: 'Roll', coin: 'Flip', pick: 'Pick' }[v];
    out.replaceChildren(); history.length = 0; hist.textContent = '';
  });
  for (const [k, p] of Object.entries(panes)) p.classList.toggle('hidden', k !== mode);
  const go = button('Generate', () => {
    try {
      if (mode === 'number') {
        const a = Math.ceil(+Min.value.replace(/,/g, '')), b = Math.floor(+Max.value.replace(/,/g, '')), k = Math.max(1, Math.min(1000, Math.floor(+Cnt.value) || 1));
        if (!Number.isFinite(a) || !Number.isFinite(b)) return out.replaceChildren(notice('Enter whole numbers for From and To.', 'warn'));
        const [lo, hi] = a <= b ? [a, b] : [b, a];
        if (!Number.isSafeInteger(lo) || !Number.isSafeInteger(hi) || hi - lo + 1 > 2 ** 53) return out.replaceChildren(notice('That range is too large.', 'warn'));
        let r;
        if (noRep) { r = sampleRange(lo, hi, k); if (!r) return out.replaceChildren(notice(`There are only ${(hi - lo + 1).toLocaleString('en-IN')} numbers in that range — pick fewer or allow repeats.`, 'warn')); }
        else r = Array.from({ length: k }, () => lo + randBelow(hi - lo + 1));
        const txt = r.map(x => x.toLocaleString('en-IN')).join(', ');
        show(txt, k > 1 ? `${k} numbers from ${lo.toLocaleString('en-IN')} to ${hi.toLocaleString('en-IN')}` : `from ${lo.toLocaleString('en-IN')} to ${hi.toLocaleString('en-IN')}`, r.length > 3 ? r.slice(0, 3).join(', ') + '…' : txt);
      } else if (mode === 'dice') {
        const r = Array.from({ length: dice }, () => randBelow(6) + 1);
        out.replaceChildren(h('div', {}, h('div', { style: { fontSize: '64px', lineHeight: '1.1', letterSpacing: '4px' } }, r.map(x => DICE[x - 1]).join('')),
          h('div', { class: 'muted small' }, dice > 1 ? `${r.join(' + ')} = ${r.reduce((x, y) => x + y)}` : `You rolled ${r[0]}`)));
        history.unshift(r.join('+')); history.length = Math.min(history.length, 8);
        hist.textContent = history.length > 1 ? 'Before: ' + history.slice(1).join(' · ') : '';
      } else if (mode === 'coin') {
        const hds = randBelow(2) === 0;
        show(hds ? '🪙 Heads' : '🪙 Tails', '', hds ? 'Heads' : 'Tails');
      } else {
        const items = L.value.split(/\n|,/).map(s => s.trim()).filter(Boolean);
        const k = Math.max(1, Math.floor(+N.value) || 1);
        if (!items.length) return out.replaceChildren(notice('Add some items to your list first.', 'warn'));
        if (k > items.length) return out.replaceChildren(notice(`Your list has only ${items.length} item${items.length === 1 ? '' : 's'}.`, 'warn'));
        const idx = sampleRange(0, items.length - 1, k);
        const picked = idx.map(i => items[i]);
        show(picked.join(', '), k > 1 ? `${k} picked from ${items.length}, no repeats` : `picked from ${items.length}`);
      }
    } catch (e) { out.replaceChildren(notice('Something went wrong — please try again.', 'err')); }
  }, { full: true });
  const goLbl = go.querySelector('.lbl');
  root.append(card({}, modeSeg, ...Object.values(panes)), go, card({ title: 'Result' }, out, hist));
}

// ── Checklist ───────────────────────────────────────────────────────
const CL_KEY = 'checklists';
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
function loadLists() {
  const d = store.get(CL_KEY, null);
  const ok = d && Array.isArray(d.lists) && d.lists.every(l => l && typeof l.name === 'string' && Array.isArray(l.items));
  if (ok && d.lists.length) {
    for (const l of d.lists) { l.id ||= uid(); l.items = l.items.filter(i => i && typeof i.text === 'string').map(i => ({ id: i.id || uid(), text: i.text, done: !!i.done })); }
    if (!d.lists.some(l => l.id === d.active)) d.active = d.lists[0].id;
    return d;
  }
  const first = { id: uid(), name: 'My list', items: [] };
  return { lists: [first], active: first.id };
}
/** Text pasted into the checklist → {name, items}. A list copied with "Copy list" (name, then ☐ / ☑ lines) comes back with its name and ticks. */
export function parseChecklistPaste(text) {
  const lines = String(text || '').split(/\r\n?|\n/).map(s => s.trim()).filter(Boolean);
  const box = /^([☐☑])\s*/;
  const named = lines.length > 1 && !box.test(lines[0]) && lines.slice(1).every(l => box.test(l));
  const items = (named ? lines.slice(1) : lines).map(l => { const m = box.exec(l); return { text: m ? l.slice(m[0].length) : l, done: !!m && m[1] === '☑' }; });
  return { name: named ? lines[0] : null, items: items.filter(i => i.text) };
}
// Same checks as the app shell's install banner.
const isIOS = () => /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
function mountChecklist(root) {
  const data = loadLists();
  // Ask the browser not to clear the lists when space runs low (once there is something to keep).
  // Chrome may agree; Safari mostly keeps its own rules, which the iPhone note below explains.
  let askedPersist = false;
  const keep = () => {
    if (askedPersist) return;
    askedPersist = true;
    try { navigator.storage?.persist?.().catch(() => {}); } catch { /* ignore */ }
  };
  const save = () => { store.set(CL_KEY, data); keep(); };
  if (data.lists.some(l => l.items.length)) keep();
  const cur = () => data.lists.find(l => l.id === data.active) || data.lists[0];
  const picker = field({ label: 'List', options: [] });
  const add = h('input', { type: 'text', placeholder: 'Add an item…', enterkeyhint: 'done', autocomplete: 'off',
    style: { flex: '1', minWidth: '0', border: '1px solid var(--line-2)', background: 'var(--surface-2)', borderRadius: '12px', padding: '12px 13px', fontSize: '16px', outline: 'none' } });
  const addBtn = button('Add', () => addItems(), { small: false });
  addBtn.style.flex = 'none';
  const items = h('div', { class: 'stack', style: { gap: '0' } });
  const foot = h('div', { class: 'small muted' });
  const clearDone = button('Clear done', () => { const l = cur(); const n = l.items.filter(i => i.done).length; if (!n) return toast('Nothing ticked yet'); l.items = l.items.filter(i => !i.done); save(); draw(); toast(`Removed ${n} done item${n === 1 ? '' : 's'}`); }, { variant: 'ghost', small: true });
  const uncheck = button('Untick all', () => { cur().items.forEach(i => { i.done = false; }); save(); draw(); }, { variant: 'ghost', small: true });
  const copyAll = copyButton(() => { const l = cur(); return `${l.name}\n` + l.items.map(i => `${i.done ? '☑' : '☐'} ${i.text}`).join('\n'); }, 'Copy list');
  const newList = button('+ New list', () => {
    const name = (prompt('Name for the new list', 'Shopping') || '').trim();
    if (!name) return;
    const l = { id: uid(), name: name.slice(0, 60), items: [] }; data.lists.push(l); data.active = l.id; save(); draw(); add.focus();
  }, { variant: 'secondary', small: true });
  const rename = button('Rename', () => { const l = cur(); const name = (prompt('Rename list', l.name) || '').trim(); if (name) { l.name = name.slice(0, 60); save(); draw(); } }, { variant: 'ghost', small: true });
  const del = button('Delete list', () => {
    const l = cur();
    if (!confirm(`Delete “${l.name}” and its ${l.items.length} item${l.items.length === 1 ? '' : 's'}?`)) return;
    data.lists = data.lists.filter(x => x.id !== l.id);
    if (!data.lists.length) data.lists.push({ id: uid(), name: 'My list', items: [] });
    data.active = data.lists[0].id; save(); draw();
  }, { variant: 'danger', small: true });
  picker.input.addEventListener('change', () => { data.active = picker.value; save(); draw(); });
  const toItems = arr => arr.map(i => ({ id: uid(), text: i.text.slice(0, 500), done: !!i.done }));
  function addItems() {
    const text = add.value.trim();
    if (!text) return;
    cur().items.push(...toItems([{ text }]));
    add.value = ''; save(); draw(); add.focus();
  }
  add.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addItems(); } });
  // A text input drops line breaks from its value, so pasted lines are split here, never via add.value.
  add.addEventListener('paste', e => {
    const t = e.clipboardData && e.clipboardData.getData('text');
    if (!t || !/[\r\n]/.test(t)) return;
    e.preventDefault();
    const v = add.value, a = add.selectionStart ?? v.length, b = add.selectionEnd ?? v.length;
    const { name, items: got } = parseChecklistPaste(v.slice(0, a) + t + v.slice(b));
    if (!got.length) return;
    if (name) {                                                       // a list copied with "Copy list": bring it back as a list
      let l = cur();
      if (l.items.length) { l = { id: uid(), name: '', items: [] }; data.lists.push(l); data.active = l.id; }
      l.name = name.slice(0, 60);
      l.items = toItems(got);
      toast(`Restored “${l.name}” (${got.length} item${got.length === 1 ? '' : 's'})`, 'ok');
    } else cur().items.push(...toItems(got));
    add.value = ''; save(); draw(); add.focus();
  });
  function draw() {
    picker.input.replaceChildren(...data.lists.map(l => h('option', { value: l.id }, `${l.name} (${l.items.filter(i => !i.done).length})`)));
    picker.value = cur().id;
    const l = cur();
    items.replaceChildren(...(l.items.length ? l.items.map(it => {
      const cb = h('input', { type: 'checkbox', style: { width: '24px', height: '24px', accentColor: 'var(--brand)', margin: '0', flex: 'none' } });
      cb.checked = it.done;
      cb.addEventListener('change', () => { it.done = cb.checked; save(); draw(); });
      const txt = h('span', { style: { flex: '1', minWidth: '0', wordBreak: 'break-word', textDecoration: it.done ? 'line-through' : '', color: it.done ? 'var(--faint)' : '' } }, it.text);
      const x = h('button', { type: 'button', 'aria-label': 'Delete item', style: { border: '0', background: 'none', color: 'var(--faint)', fontSize: '22px', width: '44px', height: '44px', cursor: 'pointer', flex: 'none' },
        onclick: () => { l.items = l.items.filter(i => i !== it); save(); draw(); } }, '×');
      return h('div', { style: { display: 'flex', alignItems: 'center', gap: '12px', minHeight: '50px', borderBottom: '1px solid var(--line)' } },
        h('label', { style: { display: 'flex', alignItems: 'center', gap: '12px', flex: '1', minWidth: '0', cursor: 'pointer', padding: '6px 0' } }, cb, txt), x);
    }) : [h('div', { class: 'empty', style: { padding: '20px 10px' } }, h('div', { class: 'e' }, '📝'), 'No items yet. Add your first one above.')]));
    const done = l.items.filter(i => i.done).length;
    foot.textContent = l.items.length ? `${done} of ${l.items.length} done` : '';
    for (const b of [clearDone, uncheck]) b.classList.toggle('hidden', !done);
    del.classList.toggle('hidden', data.lists.length < 2 && !l.items.length);
  }
  root.append(
    card({}, h('div', { style: { display: 'flex', gap: '8px', alignItems: 'flex-end' } }, h('div', { style: { flex: '1', minWidth: '0' } }, picker.el), newList),
      h('div', { style: { display: 'flex', gap: '8px' } }, add, addBtn), items, foot,
      h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } }, clearDone, uncheck, copyAll)),
    h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', margin: '0 2px' } }, rename, del),
    isIOS() && !standalone() ? h('div', { style: { margin: '12px 0 0' } }, notice('On iPhone and iPad, the browser may delete these lists if you don’t open SnappTo for about a week. To keep a copy, tap Copy list and save it in Notes. Pasting it back here restores the list.', 'warn')) : null,
    h('p', { class: 'faint small', style: { margin: '12px 6px' } }, 'Your lists are kept in this browser on this device only. They aren’t backed up anywhere, so clearing website data removes them. Tip: paste several lines to add them all at once.'));
  draw();
}

// ── Text → speech ───────────────────────────────────────────────────
const LANGS = { en: 'English', hi: 'Hindi', te: 'Telugu', all: 'All voices' };
function waitVoices(synth, ms = 2500) {
  return new Promise(res => {
    const v = synth.getVoices(); if (v.length) return res(v);
    let done = false;
    const finish = () => { if (done) return; done = true; clearInterval(poll); synth.removeEventListener?.('voiceschanged', finish); res(synth.getVoices()); };
    synth.addEventListener?.('voiceschanged', finish);
    const poll = setInterval(() => { if (synth.getVoices().length) finish(); }, 250);
    setTimeout(finish, ms);
  });
}
async function mountTts(root, defLang) {
  const synth = window.speechSynthesis;
  if (!synth || typeof SpeechSynthesisUtterance === 'undefined') {
    root.append(notice('This browser can’t read text aloud. Try Safari or Chrome.', 'err')); return;
  }
  const sample = { en: 'Hello! SnappTo can read your text aloud, right on your phone.', hi: 'नमस्ते! स्नैपटू आपका टेक्स्ट पढ़कर सुना सकता है।', te: 'నమస్కారం! స్నాప్‌టూ మీ వచనాన్ని చదివి వినిపిస్తుంది.' };
  const T = ta('Text to speak', '', 7, '');
  let lang = store.get('text:tts-lang:' + defLang, defLang);
  if (!LANGS[lang]) lang = defLang;
  const voiceF = field({ label: 'Voice', options: [] });
  const voiceNote = h('div');
  const rate = slider('Speed', { min: 0.5, max: 2, step: 0.1, value: defLang === 'en' ? 1 : 0.9 }, () => {}, v => `${(+v).toFixed(1)}×`);
  const pitch = slider('Pitch', { min: 0.5, max: 2, step: 0.1, value: 1 }, () => {}, v => (+v).toFixed(1));
  const status = h('div', { class: 'small muted', style: { minHeight: '1.4em' } });
  let voices = [];
  const setPh = () => { T.input.placeholder = `Type or paste text — or just tap Play to hear: “${sample[lang] || sample.en}”`; };
  const langSeg = segmented(Object.entries(LANGS), lang, v => { lang = v; store.set('text:tts-lang:' + defLang, v); fillVoices(); setPh(); });
  // Desktop Chrome and Edge also list cloud voices ("Google …", "… Online"): they send the text away and fail offline.
  const online = v => v.localService === false;
  const okOnline = new Set();                                         // online voices the user has been told about
  let list = [];
  function fillVoices() {
    const pref = lang === 'en' ? ['en-in', 'en-gb', 'en-us', 'en'] : [lang];
    list = voices.filter(v => lang === 'all' || (v.lang || '').toLowerCase().replace('_', '-').startsWith(lang))
      .sort((a, b) => {
        const r = x => { const l = (x.lang || '').toLowerCase().replace('_', '-'); const k = pref.findIndex(p => l.startsWith(p)); return k < 0 ? 99 : k; };
        return online(a) - online(b) || r(a) - r(b) || a.name.localeCompare(b.name);     // on-device voices first
      });
    const savedName = store.get('text:tts-voice:' + lang, '');
    voiceF.input.replaceChildren(...(list.length ? list.map(v => h('option', { value: v.voiceURI || v.name }, `${v.name} · ${v.lang}${online(v) ? ' · online' : ''}`)) : [h('option', { value: '' }, 'Device default')]));
    const savedV = list.find(v => (v.voiceURI || v.name) === savedName);
    if (savedV) voiceF.value = savedV.voiceURI || savedV.name;
    noteVoice();
  }
  function noteVoice() {
    const v = list.find(x => (x.voiceURI || x.name) === voiceF.value);
    voiceNote.replaceChildren(!list.length && lang !== 'all' ? notice(h('span', {}, `No ${LANGS[lang]} voice found on this device. `,
      h('span', { class: 'muted' }, 'On iPhone, add one in Settings ▸ Accessibility ▸ Spoken Content ▸ Voices. On Android, install it in Settings ▸ Text-to-speech.')), 'warn')
      : v && online(v) ? notice(h('span', {}, list.some(x => !online(x)) ? 'This is an online voice. ' : `This browser has only online voices${lang === 'all' ? '' : ` for ${LANGS[lang]}`}. `,
        h('span', { class: 'muted' }, 'Your text is sent to the browser’s speech service (such as Google or Microsoft) to be read aloud, and it won’t work offline.')), 'warn') : '');
  }
  voiceF.input.addEventListener('change', () => { store.set('text:tts-voice:' + lang, voiceF.value); noteVoice(); });
  let queue = [], idx = 0, state = 'idle', current = null;
  const setState = (s, msg) => { state = s; status.textContent = msg || ''; play.querySelector('.lbl').textContent = s === 'paused' ? 'Resume' : 'Play'; pause.disabled = s !== 'speaking'; stop.disabled = s === 'idle'; };
  const play = button('Play', () => {
    if (state === 'paused') { synth.resume(); setState('speaking', `Reading ${idx + 1} of ${queue.length}…`); return; }
    const text = T.value.trim() || sample[lang] || sample.en;
    if (synth.speaking || synth.pending) synth.cancel();
    queue = chunkSpeech(text); idx = 0;
    if (!queue.length) { toast('Nothing to read'); return; }
    const voice = voices.find(v => (v.voiceURI || v.name) === voiceF.value);
    // An online voice sends the user's own text away: say so once, and read it on the next tap.
    const key = voice && online(voice) && T.value.trim() ? voice.voiceURI || voice.name : '';
    if (key && !okOnline.has(key)) {
      okOnline.add(key); current = null;
      setState('idle', 'This voice is online, so your text will be sent to the browser’s speech service. Tap Play again to go ahead.');
      return;
    }
    const runId = Symbol('run'); current = runId;
    queue.forEach((chunk, k) => {
      const u = new SpeechSynthesisUtterance(chunk);
      if (voice) { u.voice = voice; u.lang = voice.lang; } else if (lang !== 'all') u.lang = { en: 'en-IN', hi: 'hi-IN', te: 'te-IN' }[lang];
      u.rate = rate.value; u.pitch = pitch.value;
      u.onstart = () => { if (current === runId) { idx = k; setState('speaking', queue.length > 1 ? `Reading ${k + 1} of ${queue.length}…` : 'Reading…'); } };
      u.onend = () => { if (current === runId && k === queue.length - 1) setState('idle', 'Done'); };
      u.onerror = e => { if (current === runId && e.error !== 'interrupted' && e.error !== 'canceled') setState('idle', 'Couldn’t play — try another voice.'); };
      synth.speak(u);     // all queued inside the tap, which iOS requires
    });
    setState('speaking', 'Starting…');
  });
  const pause = button('Pause', () => { synth.pause(); setState('paused', 'Paused'); }, { variant: 'secondary' });
  const stop = button('Stop', () => { current = null; synth.cancel(); setState('idle', ''); }, { variant: 'ghost' });
  for (const b of [play, pause, stop]) b.style.flex = '1';
  root.append(card({}, T.el), card({ title: 'Language & voice' }, langSeg, voiceF.el, voiceNote, rate.el, pitch.el),
    h('div', { style: { display: 'flex', gap: '8px' } }, play, pause, stop), h('div', { style: { margin: '10px 4px' } }, status),
    h('p', { class: 'faint small', style: { margin: '4px 6px' } }, 'Voices come from your device, so the choice and quality depend on it. Voices marked online send your text to the browser’s speech service; all others work offline.'));
  setState('idle');
  onLeave(root, () => { current = null; try { synth.cancel(); } catch { /* ignore */ } });
  setPh();
  voices = await waitVoices(synth);
  fillVoices();
  synth.addEventListener?.('voiceschanged', () => { voices = synth.getVoices(); if (root.isConnected) fillVoices(); });
}
