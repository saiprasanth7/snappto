// QR & barcodes: a safe scanner (never auto-opens anything) and live generators.
// Pure logic (payload builders, parsers, URL safety checks, check digits) is exported and unit-tested.
import { h, card, button, field, segmented, filePicker, notice, toast, copyButton, download, share, canShareFiles,
  loadImage, toCanvas, canvasToBlob } from '../ui.js';
import { libs } from '../lib.js';
import * as store from '../store.js';

// ═════════════════════════════ pure helpers ═════════════════════════════

/** qrcode-generator stores one byte per char; feed it UTF-8 bytes so Hindi, ₹ and emoji survive. */
export function toUtf8Binary(s) {
  const b = new TextEncoder().encode(String(s));
  let out = '';
  for (let i = 0; i < b.length; i += 4096) out += String.fromCharCode.apply(null, b.subarray(i, i + 4096));
  return out;
}

/** Integer pixels per module + quiet zone → crisp PNG around `target` px wide. */
export function qrLayout(count, quiet = 4, target = 1000) {
  const scale = Math.max(4, Math.floor(target / (count + 2 * quiet)));
  return { scale, size: (count + 2 * quiet) * scale };
}

const safeDecode = s => { try { return decodeURIComponent(s); } catch { return s; } };

// ── UPI ─────────────────────────────────────────────────────────────
export const validVpa = v => /^[a-zA-Z0-9][a-zA-Z0-9._-]{1,255}@[a-zA-Z][a-zA-Z0-9.-]{1,63}$/.test(String(v || '').trim());
export function cleanAmount(a) {
  let s = String(a ?? '').trim().replace(/[₹\s]/g, '');
  // A comma-decimal keypad gives "99,50": one comma with 1 or 2 digits after it is a decimal point, not grouping.
  if (!s.includes('.') && /^\d*,\d{1,2}$/.test(s)) s = s.replace(',', '.');
  s = s.replace(/,/g, '');
  if (!s) return { ok: true, value: '' };
  if (!/^\d+(\.\d{1,2})?$/.test(s) || !(+s > 0)) return { ok: false };
  return { ok: true, value: (+s).toFixed(2) };
}
/** upi://pay?pa=&pn=&am=&cu=INR&tn= — percent-encoded, '@' kept readable (what UPI apps expect). */
export function buildUpi({ vpa, name = '', amount = '', note = '' }) {
  const enc = s => encodeURIComponent(String(s).trim()).replace(/%40/g, '@');
  const q = [`pa=${enc(vpa)}`];
  if (String(name).trim()) q.push(`pn=${enc(name)}`);
  const am = cleanAmount(amount);
  if (am.ok && am.value) q.push(`am=${am.value}`);
  q.push('cu=INR');
  if (String(note).trim()) q.push(`tn=${enc(note)}`);
  return 'upi://pay?' + q.join('&');
}
const UPI_KEYS = ['pa', 'pn', 'am', 'cu', 'tn', 'mc', 'recur', 'validitystart', 'validityend', 'amrule'];
/**
 * Read a upi:// link the way payment apps do: exact lowercase keys, values %-decoded.
 * verb is 'pay', 'mandate' (AutoPay), etc. A key given twice, or as PA / p%61, is read
 * differently by different apps, so it is never trusted: conflict = {key: [values seen]}.
 */
export function parseUpi(s) {
  const qi = s.indexOf('?');
  const out = { verb: ((/^upi:\/\/([^?#/]*)/i.exec(s) || [])[1] || '').toLowerCase(), conflict: null };
  for (const k of UPI_KEYS) out[k] = '';
  const seen = {};
  for (const part of (qi >= 0 ? s.slice(qi + 1) : '').split('&')) {
    const eq = part.indexOf('='), name = eq >= 0 ? part.slice(0, eq) : part;
    const k = safeDecode(name.replace(/\+/g, ' ')).trim().toLowerCase();
    if (!UPI_KEYS.includes(k)) continue;
    const v = safeDecode((eq >= 0 ? part.slice(eq + 1) : '').replace(/\+/g, ' ')).trim();
    (seen[k] ||= []).push({ v, odd: name !== k });
  }
  for (const [k, list] of Object.entries(seen)) {
    if (list.length === 1 && !list[0].odd) out[k] = list[0].v;
    else (out.conflict ||= {})[k] = [...new Set(list.map(x => x.v))];
  }
  return out;
}

// ── Wi-Fi ───────────────────────────────────────────────────────────
export const escWifi = s => String(s).replace(/([\\;,:"])/g, '\\$1');
export function buildWifi({ ssid, password = '', security = 'WPA', hidden = false }) {
  const t = security === 'None' || security === 'nopass' ? 'nopass' : security;
  return `WIFI:T:${t};S:${escWifi(ssid)};${t !== 'nopass' ? `P:${escWifi(password)};` : ''}H:${hidden ? 'true' : 'false'};;`;
}
export function parseWifi(s) {
  const body = String(s).replace(/^WIFI:/i, '');
  const f = {};
  let key = '', val = '', inKey = true, esc = false;
  for (const ch of body) {
    if (esc) { if (inKey) key += ch; else val += ch; esc = false; continue; }
    if (ch === '\\') { esc = true; continue; }
    if (inKey && ch === ':') { inKey = false; continue; }
    if (ch === ';') { if (key) f[key.trim().toUpperCase()] = val; key = ''; val = ''; inKey = true; continue; }
    if (inKey) key += ch; else val += ch;
  }
  if (key) f[key.trim().toUpperCase()] = val;
  const unq = v => (v && v.length >= 2 && v[0] === '"' && v[v.length - 1] === '"' ? v.slice(1, -1) : v || '');
  const type = (f.T || '').toUpperCase();
  return { ssid: unq(f.S), password: unq(f.P), security: !type || type === 'NOPASS' ? 'None' : type, hidden: /^true$/i.test(f.H || '') };
}

// ── vCard ───────────────────────────────────────────────────────────
export const escVcard = s => String(s).replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/([,;])/g, '\\$1');
/** One phone/email, or arrays (phones, emails, urls) when saving a scanned card with several. */
export function buildVcard({ name, phone = '', email = '', org = '', phones, emails, urls = [], address = '', title = '' }) {
  const nm = String(name).trim().replace(/\s+/g, ' ');
  const parts = nm.split(' ');
  const last = parts.length > 1 ? parts.pop() : '';
  const lines = ['BEGIN:VCARD', 'VERSION:3.0', `N:${escVcard(last)};${escVcard(parts.join(' '))};;;`, `FN:${escVcard(nm)}`];
  if (String(org).trim()) lines.push(`ORG:${escVcard(org.trim())}`);
  if (String(title).trim()) lines.push(`TITLE:${escVcard(title.trim())}`);
  for (const p of phones ?? [phone]) { const tel = String(p).replace(/[^\d+]/g, ''); if (tel) lines.push(`TEL;TYPE=CELL:${tel}`); }
  for (const e of emails ?? [email]) if (String(e).trim()) lines.push(`EMAIL;TYPE=INTERNET:${escVcard(String(e).trim())}`);
  for (const u of urls) { const url = String(u).replace(/[\r\n]+/g, '').trim(); if (url) lines.push(`URL:${url}`); }
  if (String(address).trim()) lines.push(`ADR:;;${escVcard(address.trim())};;;;`);
  lines.push('END:VCARD');
  return lines.join('\r\n');
}
/** Split on a separator that isn't backslash-escaped (escapes are kept for unescV). */
function splitUnesc(v, sep) {
  const out = []; let cur = '';
  for (let i = 0; i < v.length; i++) {
    if (v[i] === '\\' && i + 1 < v.length) { cur += v[i] + v[i + 1]; i++; continue; }
    if (v[i] === sep) { out.push(cur); cur = ''; continue; }
    cur += v[i];
  }
  out.push(cur);
  return out;
}
const unescV = s => s.replace(/\\([nN,;:\\])/g, (m, c) => (c === 'n' || c === 'N' ? '\n' : c));
export function parseVcard(s) {
  const lines = String(s).replace(/\r\n?/g, '\n').replace(/\n[ \t]/g, '').split('\n');
  const out = { name: '', phones: [], emails: [], org: '', title: '', urls: [], address: '' };
  let n = '';
  for (const line of lines) {
    const c = line.indexOf(':'); if (c < 0) continue;
    const key = line.slice(0, c).split(';')[0].replace(/^item\d+\./i, '').toUpperCase(), v = line.slice(c + 1);
    if (key === 'FN') out.name = unescV(v).trim();
    else if (key === 'N') { const [fam, giv, add, pre, suf] = splitUnesc(v, ';').map(unescV); n = [pre, giv, add, fam, suf].filter(Boolean).join(' '); }
    else if (key === 'TEL') out.phones.push(v.replace(/^tel:/i, '').trim());
    else if (key === 'EMAIL') out.emails.push(unescV(v).trim());
    else if (key === 'ORG') out.org = splitUnesc(v, ';').map(unescV).map(x => x.trim()).filter(Boolean).join(', ');
    else if (key === 'TITLE') out.title = unescV(v).trim();
    else if (key === 'URL') out.urls.push(unescV(v).trim());
    else if (key === 'ADR') out.address = splitUnesc(v, ';').map(unescV).map(x => x.trim()).filter(Boolean).join(', ');
  }
  if (!out.name) out.name = n.trim();
  return out;
}
export function parseMecard(s) {
  const out = { name: '', phones: [], emails: [], org: '', title: '', urls: [], address: '' };
  const body = String(s).replace(/^MECARD:/i, '');
  const fields = []; let cur = '', esc = false;
  for (const ch of body) { if (esc) { cur += ch; esc = false; } else if (ch === '\\') esc = true; else if (ch === ';') { fields.push(cur); cur = ''; } else cur += ch; }
  if (cur) fields.push(cur);
  for (const f of fields) {
    const c = f.indexOf(':'); if (c < 0) continue;
    const k = f.slice(0, c).toUpperCase(), v = f.slice(c + 1).trim();
    if (k === 'N') out.name = v.includes(',') ? v.split(',').map(x => x.trim()).reverse().join(' ') : v;
    else if (k === 'TEL') out.phones.push(v);
    else if (k === 'EMAIL') out.emails.push(v);
    else if (k === 'ORG') out.org = v;
    else if (k === 'URL') out.urls.push(v);
    else if (k === 'ADR') out.address = v;
  }
  return out;
}

// ── barcodes ────────────────────────────────────────────────────────
export function ean13Check(d12) { let s = 0; for (let i = 0; i < 12; i++) s += (+d12[i]) * (i % 2 ? 3 : 1); return (10 - (s % 10)) % 10; }
export function upcCheck(d11) { let s = 0; for (let i = 0; i < 11; i++) s += (+d11[i]) * (i % 2 ? 1 : 3); return (10 - (s % 10)) % 10; }
/** Validate / complete a barcode value. → {value, note} or {error}. */
export function prepareBarcode(format, raw) {
  const v = String(raw || '').trim();
  if (!v) return { error: '' };
  if (format === 'EAN13' || format === 'UPC') {
    const d = v.replace(/[\s-]/g, ''), n = format === 'EAN13' ? 12 : 11, name = format === 'EAN13' ? 'EAN-13' : 'UPC-A';
    const chk = format === 'EAN13' ? ean13Check : upcCheck;
    if (!/^\d+$/.test(d)) return { error: `${name} uses digits only.` };
    if (d.length === n) { const c = chk(d); return { value: d + c, note: `Check digit ${c} added automatically.` }; }
    if (d.length === n + 1) { const c = chk(d.slice(0, n)); return +d[n] === c ? { value: d, note: 'Check digit is correct.' } : { error: `The last digit should be ${c} — check the number.` }; }
    return { error: `${name} needs ${n} digits (we add the last one) or all ${n + 1}. You have ${d.length}.` };
  }
  if (format === 'CODE39') {
    const u = v.toUpperCase();
    if (!/^[0-9A-Z .$/+%-]+$/.test(u)) return { error: 'Code 39 allows A–Z, 0–9, space and - . $ / + % only.' };
    if (u.length > 40) return { error: 'That’s too long for one Code 39 barcode — keep it under 40 characters.' };
    return { value: u, note: u !== v ? 'Code 39 uses capital letters, so it was converted.' : '' };
  }
  if (!/^[\x20-\x7E]+$/.test(v)) return { error: 'Code 128 supports English letters, numbers and common symbols only.' };
  if (v.length > 80) return { error: 'That’s too long for one barcode — keep it under 80 characters.' };
  return { value: v, note: '' };
}

// ── URL safety ──────────────────────────────────────────────────────
/** RFC 3492 punycode label decode, to reveal what an xn-- name really spells. */
export function punyDecode(label) {
  const base = 36, tMin = 1, tMax = 26, skew = 38, damp = 700;
  const adapt = (delta, num, first) => {
    let k = 0; delta = first ? Math.floor(delta / damp) : delta >> 1; delta += Math.floor(delta / num);
    for (; delta > ((base - tMin) * tMax) >> 1; k += base) delta = Math.floor(delta / (base - tMin));
    return Math.floor(k + ((base - tMin + 1) * delta) / (delta + skew));
  };
  const out = []; let i = 0, n = 128, bias = 72;
  let b = label.lastIndexOf('-'); if (b < 0) b = 0;
  for (let j = 0; j < b; j++) out.push(label.charCodeAt(j));
  for (let idx = b > 0 ? b + 1 : 0; idx < label.length;) {
    const oldi = i;
    for (let w = 1, k = base; ; k += base) {
      if (idx >= label.length) throw new Error('bad punycode');
      const cp = label.charCodeAt(idx++);
      const digit = cp >= 48 && cp <= 57 ? cp - 22 : cp >= 65 && cp <= 90 ? cp - 65 : cp >= 97 && cp <= 122 ? cp - 97 : base;
      if (digit >= base) throw new Error('bad punycode');
      i += digit * w;
      const t = k <= bias ? tMin : k >= bias + tMax ? tMax : k - bias;
      if (digit < t) break;
      w *= base - t;
    }
    const len = out.length + 1;
    bias = adapt(i - oldi, len, oldi === 0);
    n += Math.floor(i / len); i %= len;
    out.splice(i++, 0, n);
  }
  return String.fromCodePoint(...out);
}
export function unicodeHost(host) {
  return host.split('.').map(l => { if (!/^xn--/i.test(l)) return l; try { return punyDecode(l.slice(4)); } catch { return l; } }).join('.');
}
export const SHORTENERS = ['bit.ly', 'bitly.com', 'tinyurl.com', 't.co', 'goo.gl', 'is.gd', 'v.gd', 'cutt.ly', 'rb.gy', 'ow.ly', 'buff.ly',
  'shorturl.at', 'tiny.cc', 'rebrand.ly', 'bl.ink', 't.ly', 's.id', 'lnkd.in', 'surl.li', 'shorte.st', 'adf.ly', 'tiny.one', 'qrco.de', 'shrtco.de', 'clck.ru', 'u.to', 'x.gd'];
const DANGER_SCHEMES = ['javascript', 'data', 'file', 'vbscript', 'blob', 'intent', 'content'];
const APP_SCHEMES = [...DANGER_SCHEMES, 'market', 'whatsapp', 'tg', 'bitcoin', 'ethereum', 'otpauth', 'facetime', 'skype', 'itms-services', 'itms-apps', 'paytmmp', 'phonepe', 'gpay', 'tez'];

/** Parse a link and list human-readable red flags. Never throws. */
export function analyzeUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { return { ok: false, warnings: [{ lvl: 'danger', msg: 'This doesn’t look like a valid link.' }] }; }
  const scheme = u.protocol.replace(/:$/, '').toLowerCase();
  const warnings = [];
  if (scheme !== 'http' && scheme !== 'https') {
    warnings.push(DANGER_SCHEMES.includes(scheme)
      ? { lvl: 'danger', msg: `This is not a website link (${scheme}:) — it could run code or open files. Don’t open it.` }
      : { lvl: 'warn', msg: `This opens another app (${scheme}:), not a website. Only use it if you trust where the code came from.` });
    return { ok: true, url: u, scheme, host: u.hostname, openable: false, warnings };
  }
  const host = u.hostname.toLowerCase(), uhost = unicodeHost(host);
  const bare = host.replace(/^www\./, '');
  if (scheme === 'http') warnings.push({ lvl: 'warn', msg: 'Not secure: it starts with http, not https — anything you type there can be seen by others.' });
  if (/(^|\.)xn--/.test(host)) warnings.push({ lvl: 'danger', msg: `Uses look-alike letters from other alphabets. The real address is ${host}, which can look like “${uhost}”. If that looks like a site you know, it is probably a fake.` });
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith('[')) warnings.push({ lvl: 'danger', msg: 'Goes to a bare number address (IP) instead of a named website — real businesses rarely do this.' });
  if (u.username || u.password || /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*@/i.test(String(raw).trim())) warnings.push({ lvl: 'danger', msg: `Contains “@” — everything before the @ is a decoy. The real site is ${host}.` });
  if (SHORTENERS.some(d => bare === d || bare.endsWith('.' + d))) warnings.push({ lvl: 'warn', msg: 'Shortened link — the real destination is hidden until you open it.' });
  if (host.length > 45 || host.split('.').length > 4 || (host.replace(/(^|\.)xn--/g, '$1').match(/-/g) || []).length >= 3) warnings.push({ lvl: 'warn', msg: 'Unusually long or complicated website name — read it carefully, the real name is the part just before the last dot.' });
  if (/\.(zip|mov)$/.test(host)) warnings.push({ lvl: 'warn', msg: 'The website name ends like a file (.zip or .mov) — a common trick.' });
  if (u.port) warnings.push({ lvl: 'warn', msg: `Uses an unusual port (:${u.port}).` });
  if (String(raw).length > 300) warnings.push({ lvl: 'warn', msg: 'Very long link — long links can hide where they really go.' });
  return { ok: true, url: u, scheme, host, uhost, openable: true, warnings };
}

/** Work out what a scanned code contains. */
export function classifyScan(raw, format = 'qr_code') {
  const s = String(raw ?? '').replace(/^\uFEFF/, '').trim();
  if (format && !/^(qr_code|micro_qr_code|data_matrix|aztec|pdf417|unknown)$/.test(format)) return { kind: 'barcode', text: s, format };
  if (/^upi:\/\//i.test(s)) return { kind: 'upi', text: s, ...parseUpi(s) };
  if (/^WIFI:/i.test(s)) return { kind: 'wifi', text: s, ...parseWifi(s) };
  if (/^BEGIN:VCARD/i.test(s)) return { kind: 'contact', text: s, ...parseVcard(s) };
  if (/^MECARD:/i.test(s)) return { kind: 'contact', text: s, ...parseMecard(s) };
  if (/^tel:/i.test(s)) return { kind: 'phone', text: s, number: safeDecode(s.slice(4)).trim() };
  if (/^mailto:/i.test(s)) {
    const [addr, q = ''] = s.slice(7).split('?');
    const p = new URLSearchParams(q);
    return { kind: 'email', text: s, to: safeDecode(addr), subject: p.get('subject') || '', body: p.get('body') || '' };
  }
  if (/^MATMSG:/i.test(s)) {
    const g = k => (new RegExp(`${k}:([^;]*)`, 'i').exec(s) || [])[1] || '';
    return { kind: 'email', text: s, to: g('TO'), subject: g('SUB'), body: g('BODY') };
  }
  if (/^(smsto|sms):/i.test(s)) {
    const rest = s.replace(/^(smsto|sms):/i, '');
    const [num, ...msg] = rest.split(/[:?]/);
    return { kind: 'sms', text: s, number: safeDecode(num), body: safeDecode(msg.join(':').replace(/^body=/i, '')) };
  }
  if (/^geo:/i.test(s)) { const [lat, lon] = s.slice(4).split(/[,;?]/); return { kind: 'geo', text: s, lat: +lat, lon: +lon }; }
  if (/^https?:\/\//i.test(s)) return { kind: 'url', text: s, ...analyzeUrl(s) };
  if (/^www\.\S+\.\S+$/i.test(s)) return { kind: 'url', text: s, assumed: true, ...analyzeUrl('https://' + s) };
  const sch = /^([a-z][a-z0-9+.-]{1,30}):\S/i.exec(s);
  if (sch && !/\s/.test(s.slice(0, 40)) && (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) || APP_SCHEMES.includes(sch[1].toLowerCase()))) return { kind: 'url', text: s, ...analyzeUrl(s) };
  if (/^\+?[\d\s().-]{7,20}$/.test(s) && s.replace(/\D/g, '').length >= 7 && !/^\d{4}-\d{1,2}-\d{1,2}$|^\d{1,2}[-.]\d{1,2}[-.]\d{2,4}$/.test(s)) return { kind: 'phone', text: s, number: s };
  if (/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s)) return { kind: 'email', text: s, to: s, subject: '', body: '' };
  const inner = /https?:\/\/[^\s<>"']+/i.exec(s);
  return { kind: 'text', text: s, inner: inner ? analyzeUrl(inner[0]) : null };
}

// ═════════════════════════════ UI helpers ═════════════════════════════
const muted = t => h('p', { class: 'muted small', style: { margin: 0 } }, t);
function toggle(label, checked, onChange) {
  const input = h('input', { type: 'checkbox', style: { width: '22px', height: '22px', accentColor: 'var(--brand)', margin: 0, flex: 'none' } });
  input.checked = !!checked;
  input.addEventListener('change', () => onChange && onChange(input.checked));
  const el = h('label', { style: { display: 'flex', alignItems: 'center', gap: '10px', minHeight: '44px', cursor: 'pointer', fontSize: '15px' } }, input, h('span', {}, label));
  return { el, input, get checked() { return input.checked; } };
}
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const safeName = s => String(s || '').normalize('NFKD').replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'code';
const kv = (k, v, opts = {}) => h('div', { style: { display: 'flex', gap: '12px', padding: '9px 0', borderBottom: '1px solid var(--line)', alignItems: 'baseline' } },
  h('span', { class: 'muted small', style: { flex: '0 0 92px' } }, k),
  h('span', { style: { flex: '1', minWidth: '0', wordBreak: 'break-word', fontWeight: opts.bold ? '700' : '550', fontSize: opts.big ? '18px' : '15px', fontFamily: opts.mono ? 'var(--mono)' : '' } }, v));
const fmtINR = n => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 }).format(n);

function drawQrCanvas(q, { quiet = 4, target = 1000, caption = [] } = {}) {
  const count = q.getModuleCount();
  const { scale, size } = qrLayout(count, quiet, target);
  const lines = caption.filter(Boolean).slice(0, 3);
  const fs = Math.round(size * 0.042), lh = Math.round(fs * 1.35);
  const capH = lines.length ? lines.length * lh + Math.round(fs * 0.6) : 0;
  const cv = document.createElement('canvas');
  cv.width = size; cv.height = size + capH;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height);
  ctx.fillStyle = '#000';
  for (let r = 0; r < count; r++) for (let c = 0; c < count; c++) if (q.isDark(r, c)) ctx.fillRect((c + quiet) * scale, (r + quiet) * scale, scale, scale);
  if (lines.length) {
    ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic'; ctx.fillStyle = '#111';
    lines.forEach((t, k) => {
      ctx.font = `${k === 0 ? '700' : '500'} ${fs}px -apple-system, "Segoe UI", Roboto, "Noto Sans", sans-serif`;
      let s = t; while (s.length > 1 && ctx.measureText(s).width > size * 0.9) s = s.slice(0, -2) + '…';
      ctx.fillText(s, size / 2, size + k * lh + fs);     // below the full quiet zone, so scanning isn't affected
    });
  }
  return cv;
}

const onLeave = fn => {
  const ac = new AbortController();
  const done = () => { ac.abort(); fn(); };
  addEventListener('hashchange', done, { signal: ac.signal });
  addEventListener('pagehide', done, { signal: ac.signal });
  return ac;
};

// ═════════════════════════════ mount ═════════════════════════════
export async function mount(root, toolId) {
  try {
    if (toolId === 'qrscan') return await mountScan(root);
    if (toolId === 'barcode') return await mountBarcode(root);
    if (['qrtext', 'qrupi', 'qrwifi', 'qrcontact'].includes(toolId)) return await mountGenerator(root, toolId);
    root.append(notice('This tool isn’t available yet.', 'warn'));
  } catch (e) {
    console.error(e);
    root.append(notice(navigator.onLine ? 'Something went wrong setting up this tool. Please reload the page.'
      : 'Part of this tool isn’t saved for offline use yet. Open it once with internet.', 'err'));
  }
}

// ── Generators ──────────────────────────────────────────────────────
async function mountGenerator(root, toolId) {
  const qrcode = await libs.qrcode();
  const form = h('div', { class: 'stack' });
  const msg = h('div');
  let ec = store.get('qr:ec', 'M');
  if (!'LMQH'.includes(ec) || ec.length !== 1) ec = 'M';
  const ecSeg = segmented([['L', 'L · 7%'], ['M', 'M · 15%'], ['Q', 'Q · 25%'], ['H', 'H · 30%']], ec, v => { ec = v; store.set('qr:ec', v); render(); });
  const holder = h('div', { style: { display: 'grid', placeItems: 'center', padding: '16px', background: 'var(--surface-2)', borderRadius: '16px', minHeight: '200px' } });
  const inside = h('div', { class: 'mono small', style: { whiteSpace: 'pre-wrap', wordBreak: 'break-all', color: 'var(--muted)', maxHeight: '140px', overflow: 'auto' } });
  const insideWrap = h('details', { style: { fontSize: '13.5px' } }, h('summary', { class: 'muted', style: { cursor: 'pointer', padding: '4px 0' } }, 'What’s inside the code'), inside);
  let lastCanvas = null, lastName = 'qr.png';
  const dl = button('Download PNG', async () => { if (!lastCanvas) return; try { download(await canvasToBlob(lastCanvas, 'image/png'), lastName); } catch { toast('Couldn’t save the image', 'err'); } });
  const sh = canShareFiles() ? button('Share', async () => { if (!lastCanvas) return; try { await share(await canvasToBlob(lastCanvas, 'image/png'), lastName); } catch { toast('Couldn’t share', 'err'); } }, { variant: 'secondary' }) : null;
  for (const b of [dl, sh]) if (b) b.style.flex = '1';
  const acts = h('div', { style: { display: 'flex', gap: '9px' } }, dl, sh);
  const extra = h('div');
  let build = () => ({ empty: true });

  // ---- per-tool forms
  if (toolId === 'qrtext') {
    const T = field({ label: 'Text or link', type: 'textarea', rows: 5, placeholder: 'https://example.com or any text' });
    form.append(T.el);
    T.input.addEventListener('input', debounce(render, 120));
    build = () => {
      const t = T.value;
      if (!t.trim()) return { empty: true, hint: 'Type or paste something to make its QR code.' };
      const w = /^www\.\S+$/i.test(t.trim()) ? 'Tip: add https:// at the start so phones open it as a link.' : '';
      return { text: t, filename: /^https?:\/\//i.test(t.trim()) ? `qr_${safeName(analyzeUrl(t.trim()).host || 'link')}.png` : 'qr_text.png', note: w };
    };
  } else if (toolId === 'qrupi') {
    const saved = store.get('qr:upi', {}) || {};
    const V = field({ label: 'Your UPI ID', placeholder: 'name@bank', value: saved.vpa || '', inputmode: 'email', autocomplete: 'off' });
    V.input.setAttribute('autocapitalize', 'none');
    const N = field({ label: 'Name shown to the payer', placeholder: 'e.g. Sharma General Store', value: saved.name || '' });
    const A = field({ label: 'Amount (₹, optional)', placeholder: 'Leave empty to let them enter it', inputmode: 'decimal' });
    const Nt = field({ label: 'Note (optional)', placeholder: 'e.g. Rent for October' });
    form.append(V.el, N.el, A.el, Nt.el);
    for (const f of [V, N, A, Nt]) f.input.addEventListener('input', debounce(() => { store.set('qr:upi', { vpa: V.value.trim(), name: N.value.trim() }); render(); }, 120));
    build = () => {
      const vpa = V.value.trim();
      if (!vpa) return { empty: true, hint: 'Enter your UPI ID (looks like name@bank) to make your payment QR.' };
      if (!validVpa(vpa)) return { error: 'That UPI ID doesn’t look right. It should look like name@bank, e.g. 9876543210@ybl.' };
      const am = cleanAmount(A.value);
      if (!am.ok) return { error: 'Enter the amount as a number, e.g. 250 or 99.50.' };
      const amt = am.value ? +am.value : 0;
      return { text: buildUpi({ vpa, name: N.value, amount: A.value, note: Nt.value }), filename: `upi_${safeName(vpa.split('@')[0])}.png`,
        caption: [`Pay ${N.value.trim() || vpa}`, amt ? fmtINR(amt) : '', N.value.trim() ? vpa : ''],
        warn: amt > 100000 ? 'Many UPI apps limit a single payment to ₹1,00,000.' : '',
        note: 'Any UPI app can scan this — GPay, PhonePe, Paytm, BHIM and bank apps. Test it once with a small amount.' };
    };
  } else if (toolId === 'qrwifi') {
    const S = field({ label: 'Network name (SSID)', placeholder: 'e.g. Home_WiFi' });
    const P = field({ label: 'Password', placeholder: 'Wi-Fi password' });
    for (const f of [S, P]) f.input.setAttribute('autocapitalize', 'none');
    let sec = 'WPA';
    const secSeg = segmented([['WPA', 'WPA/WPA2'], ['WEP', 'WEP'], ['None', 'No password']], sec, v => { sec = v; P.el.classList.toggle('hidden', v === 'None'); render(); });
    const hid = toggle('Hidden network', false, () => render());
    const showPw = toggle('Print the password under the code', false, () => render());
    form.append(S.el, h('div', { class: 'field' }, h('label', {}, 'Security'), secSeg), P.el, hid.el, showPw.el);
    for (const f of [S, P]) f.input.addEventListener('input', debounce(render, 120));
    build = () => {
      const ssid = S.value;
      if (!ssid.trim()) return { empty: true, hint: 'Enter your Wi-Fi name and password. Guests scan it with their camera to join.' };
      const pw = P.value;
      if (sec !== 'None' && !pw) return { error: 'Enter the Wi-Fi password, or choose “No password”.' };
      const warn = sec === 'WPA' && pw.length < 8 ? 'WPA passwords are at least 8 characters — double-check it.'
        : sec === 'WEP' && ![5, 10, 13, 26].includes(pw.length) ? 'WEP passwords are usually 5, 10, 13 or 26 characters.' : '';
      return { text: buildWifi({ ssid, password: pw, security: sec, hidden: hid.checked }), filename: `wifi_${safeName(ssid)}.png`,
        caption: [`Wi-Fi: ${ssid}`, showPw.checked && sec !== 'None' ? `Password: ${pw}` : ''], warn,
        note: 'iPhone and Android cameras join automatically after scanning.' };
    };
  } else if (toolId === 'qrcontact') {
    const N = field({ label: 'Full name', placeholder: 'e.g. Priya Sharma' });
    const P = field({ label: 'Phone', placeholder: '+91 98765 43210', type: 'tel', inputmode: 'tel' });
    const E = field({ label: 'Email', placeholder: 'priya@example.com', type: 'email', inputmode: 'email' });
    const O = field({ label: 'Company / organisation', placeholder: 'Optional' });
    E.input.setAttribute('autocapitalize', 'none');
    form.append(N.el, P.el, E.el, O.el);
    for (const f of [N, P, E, O]) f.input.addEventListener('input', debounce(render, 120));
    const vcf = button('Download contact file (.vcf)', () => {
      const r = build(); if (!r.text) return;
      download(new Blob([r.text], { type: 'text/vcard' }), `${safeName(N.value)}.vcf`);
    }, { variant: 'ghost', small: true });
    extra.append(vcf);
    build = () => {
      if (!N.value.trim()) return { empty: true, hint: 'Enter at least a name. People scan it to save you to their contacts.' };
      const e = E.value.trim();
      if (e && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e)) return { error: 'That email address doesn’t look complete.' };
      const digits = P.value.replace(/\D/g, '');
      if (P.value.trim() && digits.length < 6) return { error: 'That phone number looks too short.' };
      return { text: buildVcard({ name: N.value, phone: P.value, email: e, org: O.value }), filename: `contact_${safeName(N.value)}.png`, caption: [N.value.trim()] };
    };
  }

  function render() {
    msg.replaceChildren();
    let r;
    try { r = build(); } catch (e) { r = { error: 'Something went wrong — check the details above.' }; }
    const off = r.empty || r.error;
    acts.classList.toggle('hidden', !!off); insideWrap.classList.toggle('hidden', !!off); extra.classList.toggle('hidden', !!off);
    if (off) {
      lastCanvas = null;
      holder.replaceChildren(h('div', { class: 'empty', style: { padding: '24px 8px' } }, h('div', { class: 'e' }, '🔳'), r.hint || 'Your QR code appears here.'));
      if (r.error) msg.append(notice(r.error, 'warn'));
      return;
    }
    let q;
    try { q = qrcode(0, ec); q.addData(toUtf8Binary(r.text), 'Byte'); q.make(); }
    catch (e) {
      const cap = { L: '2,900', M: '2,300', Q: '1,650', H: '1,250' }[ec];
      holder.replaceChildren(h('div', { class: 'empty' }, h('div', { class: 'e' }, '🔳'), 'Too much for one QR code'));
      msg.append(notice(`That’s too much text for one QR code at level ${ec} (about ${cap} letters max, fewer for Hindi/Telugu). Shorten it or pick a lower level.`, 'warn'));
      acts.classList.add('hidden'); insideWrap.classList.add('hidden'); lastCanvas = null;
      return;
    }
    const cv = drawQrCanvas(q, { caption: r.caption || [] });
    Object.assign(cv.style, { width: 'min(100%, 300px)', height: 'auto', imageRendering: 'pixelated', borderRadius: '8px', boxShadow: '0 4px 18px rgba(0,0,0,.12)' });
    cv.setAttribute('role', 'img'); cv.setAttribute('aria-label', 'QR code preview');
    holder.replaceChildren(cv);
    lastCanvas = cv; lastName = r.filename || 'qr.png';
    inside.textContent = r.text;
    if (r.warn) msg.append(notice(r.warn, 'warn'));
    if (r.note) msg.append(h('p', { class: 'faint small', style: { margin: '2px 4px' } }, r.note));
  }
  root.append(card({}, form), card({ title: 'Your QR code' }, holder, msg, acts, extra, insideWrap),
    card({ title: 'Error correction', sub: 'Higher levels still scan if the code is scratched or has a logo on top, but make the code denser.' }, ecSeg));
  render();
}

// ── Barcode ─────────────────────────────────────────────────────────
async function mountBarcode(root) {
  const JsBarcode = await libs.JsBarcode();
  let fmt = 'CODE128';
  const V = field({ label: 'Value', placeholder: 'e.g. INV-2024-0042' });
  V.input.setAttribute('autocapitalize', 'none');
  const hints = { CODE128: ['Letters, numbers and symbols — the most flexible.', 'e.g. INV-2024-0042'], EAN13: ['Retail product code: type 12 digits and we add the check digit.', 'e.g. 890123456789'],
    UPC: ['US/Canada product code: type 11 digits and we add the check digit.', 'e.g. 03600029145'], CODE39: ['Capital letters, numbers and - . $ / + % space.', 'e.g. ASSET-42'] };
  const hint = h('div', { class: 'hint small faint' });
  const seg = segmented([['CODE128', 'Code 128'], ['EAN13', 'EAN-13'], ['UPC', 'UPC-A'], ['CODE39', 'Code 39']], fmt, v => { fmt = v; setHint(); render(); });
  const setHint = () => { hint.textContent = hints[fmt][0]; V.input.placeholder = hints[fmt][1]; V.input.inputMode = fmt === 'EAN13' || fmt === 'UPC' ? 'numeric' : 'text'; };
  setHint();
  const holder = h('div', { style: { display: 'grid', placeItems: 'center', padding: '16px', background: 'var(--surface-2)', borderRadius: '16px', minHeight: '150px' } });
  const msg = h('div');
  let lastCanvas = null, lastName = 'barcode.png';
  const dl = button('Download PNG', async () => { if (lastCanvas) download(await canvasToBlob(lastCanvas, 'image/png'), lastName); });
  const sh = canShareFiles() ? button('Share', async () => { if (lastCanvas) await share(await canvasToBlob(lastCanvas, 'image/png'), lastName); }, { variant: 'secondary' }) : null;
  for (const b of [dl, sh]) if (b) b.style.flex = '1';
  const acts = h('div', { style: { display: 'flex', gap: '9px' } }, dl, sh);
  function render() {
    msg.replaceChildren();
    const p = prepareBarcode(fmt, V.value);
    if (!p.value) {
      lastCanvas = null; acts.classList.add('hidden');
      holder.replaceChildren(h('div', { class: 'empty', style: { padding: '20px 8px' } }, h('div', { class: 'e' }, '▮▯▮▮▯'), 'Your barcode appears here.'));
      if (p.error) msg.append(notice(p.error, 'warn'));
      return;
    }
    const cv = document.createElement('canvas');
    let ok = true;
    try {
      JsBarcode(cv, p.value, { format: fmt, width: 4, height: 160, margin: 28, displayValue: true, fontSize: 34, textMargin: 6,
        font: 'monospace', background: '#ffffff', lineColor: '#000000', valid: v => { ok = v; } });
    } catch { ok = false; }
    if (!ok) { acts.classList.add('hidden'); lastCanvas = null; holder.replaceChildren(h('div', { class: 'empty' }, 'Can’t draw that value')); msg.append(notice('That value can’t be made into this kind of barcode.', 'warn')); return; }
    Object.assign(cv.style, { width: '100%', maxWidth: '420px', height: 'auto', borderRadius: '8px', boxShadow: '0 4px 18px rgba(0,0,0,.12)' });
    holder.replaceChildren(cv);
    lastCanvas = cv; lastName = `barcode_${safeName(p.value)}.png`; acts.classList.remove('hidden');
    if (p.note) msg.append(h('p', { class: 'muted small', style: { margin: 0 } }, p.note));
  }
  V.input.addEventListener('input', debounce(render, 100));
  root.append(card({}, h('div', { class: 'field' }, h('label', {}, 'Type'), seg, hint), V.el), card({ title: 'Your barcode' }, holder, msg, acts),
    h('p', { class: 'faint small', style: { margin: '4px 6px' } }, 'Selling in shops? Official EAN/UPC product numbers are issued by GS1 India — made-up numbers can clash with real products.'));
  render();
}

// ── Scanner ─────────────────────────────────────────────────────────
const NATIVE_FORMATS = ['qr_code', 'ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'code_93', 'itf', 'codabar', 'data_matrix', 'pdf417', 'aztec'];
async function makeEngine() {
  if ('BarcodeDetector' in window) {
    try {
      const fmts = await window.BarcodeDetector.getSupportedFormats();
      if (fmts && fmts.includes('qr_code')) return { native: new window.BarcodeDetector({ formats: fmts.filter(f => NATIVE_FORMATS.includes(f)) }) };
    } catch { /* fall back to jsQR */ }
  }
  return { jsQR: await libs.jsQR() };
}
async function detect(engine, source, work, { maxSide = 640, invert = false } = {}) {
  if (engine.native) {
    const r = await engine.native.detect(source);
    return r && r.length ? { text: r[0].rawValue, format: r[0].format } : null;
  }
  const vw = source.videoWidth || source.width, vh = source.videoHeight || source.height;
  if (!vw || !vh) return null;
  const s = Math.min(1, maxSide / Math.max(vw, vh)), w = Math.round(vw * s), hh = Math.round(vh * s);
  if (work.width !== w || work.height !== hh) { work.width = w; work.height = hh; }
  const ctx = work.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, 0, 0, w, hh);
  const img = ctx.getImageData(0, 0, w, hh);
  const code = engine.jsQR(img.data, w, hh, { inversionAttempts: invert ? 'attemptBoth' : 'dontInvert' });
  return code && code.data ? { text: code.data, format: 'qr_code' } : null;
}

async function mountScan(root) {
  const engineP = makeEngine();
  engineP.catch(() => {});
  const video = h('video', { playsinline: true, muted: true, autoplay: true, 'aria-label': 'Camera view' });
  video.muted = true; video.playsInline = true;
  const frame = h('div', { style: { position: 'absolute', left: '50%', top: '50%', width: '64%', aspectRatio: '1', transform: 'translate(-50%,-50%)',
    border: '3px solid rgba(255,255,255,.9)', borderRadius: '22px', boxShadow: '0 0 0 9999px rgba(0,0,0,.28)' } });
  const hint = h('div', { class: 'camhint' }, 'Point at a QR code');
  const overlay = h('div', { class: 'overlay hidden' }, frame, hint);
  const startBtn = button('Start camera', null, { icon: '📷' });
  const idle = h('div', { role: 'button', tabindex: '0', 'aria-label': 'Start camera', onclick: () => start(),
    style: { position: 'absolute', inset: '0', display: 'grid', placeItems: 'center', color: '#fff', textAlign: 'center', padding: '20px', cursor: 'pointer' } },
    h('div', { class: 'stack', style: { alignItems: 'center' } }, h('div', { style: { fontSize: '44px' } }, '📷'), startBtn,
      h('div', { style: { fontSize: '13px', opacity: '.75', maxWidth: '26ch' } }, 'Nothing opens automatically — you’ll see what’s inside first.')));
  const cam = h('div', { class: 'cam', style: { maxHeight: '58vh' } }, video, overlay, idle);
  const stopBtn = button('Stop camera', () => stop(), { variant: 'ghost', full: true });
  stopBtn.classList.add('hidden');
  const camMsg = h('div');
  const out = h('div');
  const picker = filePicker({ accept: 'image/*', label: 'Scan from a photo', hint: 'A screenshot or picture of a QR code', icon: '🖼', onFiles: f => { if (f[0]) scanFile(f[0]); } });
  root.append(card({}, cam, stopBtn, camMsg), card({ title: 'Or use a photo' }, picker), out);

  let stream = null, timer = null, running = false, starting = false, engine = null;
  const work = document.createElement('canvas');
  const ac = onLeave(() => stop());
  document.addEventListener('visibilitychange', () => { if (document.hidden && running) stop(); }, { signal: ac.signal });

  async function start() {
    if (running || starting) return;
    camMsg.replaceChildren();
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      camMsg.append(notice('The camera isn’t available here (it needs a secure https page). You can still scan from a photo below.', 'warn'));
      return;
    }
    startBtn.disabled = true; starting = true;
    try {
      engine = await engineP;
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
      if (!root.isConnected) { stop(); return; }
      video.srcObject = stream;
      await video.play().catch(() => {});
      running = true;
      idle.classList.add('hidden'); overlay.classList.remove('hidden'); stopBtn.classList.remove('hidden');
      out.replaceChildren();
      loop();
    } catch (e) {
      stop();
      const n = e && e.name;
      camMsg.append(notice(n === 'NotAllowedError' || n === 'SecurityError'
        ? 'Camera access was blocked. Allow the camera for this site (iPhone: Settings ▸ Safari ▸ Camera), or scan from a photo below.'
        : n === 'NotFoundError' || n === 'OverconstrainedError' ? 'No camera was found on this device. Scan from a photo below instead.'
          : n === 'NotReadableError' ? 'The camera is busy in another app. Close it and try again.'
            : 'Couldn’t start the camera. Try again, or scan from a photo below.', 'err'));
    } finally { startBtn.disabled = false; starting = false; }
  }
  async function loop() {
    if (!running) return;
    if (!root.isConnected) { stop(); return; }
    if (video.readyState >= 2) {
      let r = null;
      try { r = await detect(engine, video, work); } catch { /* a bad frame — keep going */ }
      if (r && running) { found(r); return; }     // outside the try, so a display problem is never mistaken for a bad frame
    }
    if (running) timer = setTimeout(loop, 150);
  }
  function stop() {
    running = false; clearTimeout(timer);
    if (stream) { for (const t of stream.getTracks()) t.stop(); stream = null; }
    try { video.pause(); } catch { /* ignore */ }
    video.srcObject = null;
    idle.classList.remove('hidden'); overlay.classList.add('hidden'); stopBtn.classList.add('hidden');
  }
  function found(r) {
    stop();
    try { navigator.vibrate && navigator.vibrate(60); } catch { /* ignore */ }
    show(r.text, r.format);
  }
  async function scanFile(file) {
    out.replaceChildren(h('div', { class: 'empty' }, h('div', { class: 'e' }, '🔎'), 'Looking for a code…'));
    try {
      const eng = await engineP;
      const img = await loadImage(file);
      let r = null;
      for (const side of [1600, 1000, 600]) {
        const cv = toCanvas(img, side);
        r = eng.native ? await detect(eng, cv, work) : await detect(eng, cv, work, { maxSide: side, invert: true });
        if (r) break;
      }
      if (img.src.startsWith('blob:')) URL.revokeObjectURL(img.src);
      if (!r) { out.replaceChildren(notice('No QR code found in that picture. Try a sharper, closer photo with the whole code visible.', 'warn')); return; }
      show(r.text, r.format);
    } catch (e) { out.replaceChildren(notice(e.message || 'Couldn’t read that image. Try a JPG or PNG.', 'err')); }
  }
  function show(text, format) {
    const again = () => { out.replaceChildren(); start(); };
    let view;
    try { view = resultView(classifyScan(text, format), text, again); }
    catch (e) {
      console.error(e);
      const cp = copyButton(text, 'Copy'); cp.classList.remove('btn-sm'); cp.style.flex = '1';
      const ag = button('Scan again', again, { variant: 'secondary' }); ag.style.flex = '1';
      view = h('section', { class: 'result' }, h('div', { class: 'rb stack' },
        notice('Couldn’t show the details of this code. Here is the text inside it. Don’t open it unless you trust where it came from.', 'warn'),
        h('div', { class: 'mono', style: { whiteSpace: 'pre-wrap', wordBreak: 'break-all' } }, text),
        h('div', { style: { display: 'flex', gap: '9px', flexWrap: 'wrap' } }, cp, ag)));
    }
    out.replaceChildren(view);
    out.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

const KIND = { url: ['🔗', 'Link'], upi: ['💸', 'UPI payment'], wifi: ['📶', 'Wi-Fi network'], contact: ['👤', 'Contact'], phone: ['📞', 'Phone number'],
  email: ['✉️', 'Email'], sms: ['💬', 'Text message'], geo: ['📍', 'Location'], text: ['📝', 'Text'], barcode: ['▮▯▮', 'Barcode'] };

function warnList(ws) {
  if (!ws || !ws.length) return notice('No obvious warning signs. Still, only open links you were expecting.', 'ok');
  const danger = ws.some(w => w.lvl === 'danger');
  return notice(h('div', { class: 'stack', style: { gap: '6px' } }, h('b', {}, danger ? 'Be careful with this link' : 'Check before you open'),
    ws.map(w => h('div', {}, (w.lvl === 'danger' ? '⛔ ' : '⚠️ ') + w.msg))), danger ? 'err' : 'warn');
}
function urlBlock(a, raw) {
  if (!a.ok) return h('div', { class: 'mono', style: { wordBreak: 'break-all' } }, raw);
  const u = a.url;
  if (!a.openable) return h('div', { class: 'mono', style: { wordBreak: 'break-all', fontSize: '14px' } }, raw);
  const user = u.username ? safeDecode(u.username) + (u.password ? ':•••' : '') + '@' : '';
  // A look-alike (xn--) name is headlined as its real ASCII address; the disguise is only a footnote.
  const lookAlike = a.uhost && a.uhost !== a.host;
  return h('div', { class: 'stack', style: { gap: '8px' } },
    h('div', {}, h('div', { class: 'muted small' }, 'Website'), h('div', { style: { fontSize: '22px', fontWeight: '760', wordBreak: 'break-all', letterSpacing: '-.01em' } }, a.host),
      lookAlike ? h('div', { class: 'small', style: { color: 'var(--err)', overflowWrap: 'anywhere' } }, `Written in other alphabets, so it can look like “${a.uhost}”`) : null),
    h('div', { class: 'mono', style: { wordBreak: 'break-all', fontSize: '13.5px', lineHeight: '1.5', padding: '10px 12px', background: 'var(--surface-2)', borderRadius: '10px' } },
      h('span', { style: { color: a.scheme === 'http' ? 'var(--err)' : 'var(--faint)' } }, a.scheme + '://'),
      user && h('span', { style: { color: 'var(--err)', textDecoration: 'line-through' } }, user),
      h('b', { style: { color: 'var(--text)', fontSize: '15px' } }, u.hostname + (u.port ? ':' + u.port : '')),
      h('span', { style: { color: 'var(--muted)' } }, u.pathname + u.search + u.hash)));
}
const UPI_LABEL = { pa: 'UPI ID', pn: 'name', am: 'amount', cu: 'currency', tn: 'note', mc: 'merchant code', recur: 'repeat schedule',
  validitystart: 'start date', validityend: 'end date', amrule: 'amount rule' };
const RECUR = { ONETIME: 'once, at a later date', DAILY: 'every day', WEEKLY: 'every week', FORTNIGHTLY: 'every two weeks', MONTHLY: 'every month',
  BIMONTHLY: 'every two months', QUARTERLY: 'every three months', HALFYEARLY: 'every six months', YEARLY: 'every year', ASPRESENTED: 'whenever the merchant asks' };
/** AutoPay dates are DDMMYYYY → "31 Dec 2030"; anything else is shown as given. */
function upiDate(s) {
  const m = /^(\d{2})(\d{2})(\d{4})$/.exec(s || '');
  const d = m && new Date(Date.UTC(+m[3], +m[2] - 1, +m[1]));
  if (!d || d.getUTCDate() !== +m[1] || d.getUTCMonth() !== +m[2] - 1) return s;
  return new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(d);
}
const andList = a => (a.length > 1 ? a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1] : a[0] || '');

function resultView(info, raw, again) {
  let [icon, label] = KIND[info.kind] || KIND.text;
  const body = h('div', { class: 'stack' });
  const acts = h('div', { style: { display: 'flex', gap: '9px', flexWrap: 'wrap' } });
  const cp = copyButton(raw, 'Copy'); cp.classList.remove('btn-sm'); cp.style.flex = '1';
  const agBtn = button('Scan again', again, { variant: 'secondary' }); agBtn.style.flex = '1';

  if (info.kind === 'url') {
    body.append(urlBlock(info, raw), warnList(info.warnings));
    if (info.assumed) body.append(muted('The code has no https:// — it would open as a secure (https) link.'));
    if (info.openable) {
      const danger = info.warnings.some(w => w.lvl === 'danger');
      const open = button('Open link', () => {
        if (info.warnings.length && !confirm(`Open ${info.host}?\n\n${info.warnings.map(w => '• ' + w.msg).join('\n')}`)) return;
        window.open(info.url.href, '_blank', 'noopener,noreferrer');
      }, { variant: danger ? 'danger' : 'primary' });
      open.style.flex = '1 1 100%';
      acts.append(open);
    }
  } else if (info.kind === 'upi') {
    const odd = info.conflict || {}, mandate = info.verb === 'mandate';
    if (mandate) label = 'UPI AutoPay'; else if (info.verb !== 'pay') label = 'UPI request';
    // A detail that apps may read two ways is never shown as one answer: every version is listed in red.
    const alt = (k, v) => (odd[k] ? h('span', { style: { color: 'var(--err)' } }, odd[k].map(x => x || '(empty)').join(' or ')) : v);
    const why = (title, text, kind) => notice(h('div', {}, h('b', {}, title), h('div', { class: 'small', style: { marginTop: '4px' } }, text)), kind);
    const amOk = /^\d+(\.\d{1,2})?$/.test(info.am) && +info.am > 0;
    const amount = amOk ? (/^max$/i.test(info.amrule) ? `Up to ${fmtINR(+info.am)} each time` : fmtINR(+info.am))
      : info.am ? h('span', { style: { color: 'var(--warn)' } }, info.am) : 'Not set — you’ll type it in your app';
    const often = RECUR[info.recur.toUpperCase()] || (info.recur ? `on the schedule “${info.recur}”` : 'again later');
    const keys = Object.keys(odd);
    if (keys.length) body.append(why('Don’t pay with this code.', `Its ${andList(keys.map(k => UPI_LABEL[k]))} ${keys.length > 1 ? 'are' : 'is'} written more than once or in an unusual way, so your payment app may not use what is shown here.`, 'err'));
    if (mandate) body.append(why('This sets up AutoPay, not a one-time payment.', `If you approve it, money can be taken from your account ${often}${info.validityend ? ` until ${upiDate(info.validityend)}` : ''}. You never need to approve AutoPay to receive money.`, 'err'));
    else if (info.verb !== 'pay') body.append(why('This isn’t a normal UPI payment code.', `It is a “${info.verb || 'unknown'}” request, not a payment. Don’t use it unless you know exactly what it does.`, 'err'));
    else if (!keys.length) body.append(why('Check the name and amount before you pay.', 'You never need to scan a QR code or enter your UPI PIN to receive money — that’s a common scam.', 'warn'));
    body.append(h('div', {}, kv('Pay to', alt('pn', info.pn || h('span', { style: { color: 'var(--warn)' } }, 'No name given')), { bold: true, big: true }),
      kv('UPI ID', alt('pa', info.pa || '—'), { mono: true }),
      kv('Amount', alt('am', amount), { bold: amOk && !odd.am, big: amOk && !odd.am }),
      mandate || odd.recur ? kv('Repeats', alt('recur', info.recur ? often[0].toUpperCase() + often.slice(1) : 'Not stated')) : null,
      info.validitystart || odd.validitystart ? kv('Starts', alt('validitystart', upiDate(info.validitystart))) : null,
      info.validityend || odd.validityend ? kv('Ends', alt('validityend', upiDate(info.validityend))) : null,
      info.tn || odd.tn ? kv('Note', alt('tn', info.tn)) : null,
      (info.cu && info.cu.toUpperCase() !== 'INR') || odd.cu ? kv('Currency', alt('cu', info.cu)) : null));
    if (info.am && !amOk && !odd.am) body.append(notice(`The amount in this code (“${info.am}”) isn’t written like a normal rupee amount, so your app may read it differently. Check the amount in your app before you pay.`, 'warn'));
    if (info.pa && !validVpa(info.pa)) body.append(notice('The UPI ID in this code looks malformed. Don’t pay unless you’re sure.', 'err'));
    if (info.pa && !keys.length && info.verb === 'pay') {
      const pay = h('a', { class: 'btn btn-primary', href: raw, style: { flex: '1 1 100%' } }, 'Open in UPI app');
      acts.append(pay);
    } else if (info.pa && !keys.length && mandate) {
      const ask = `Set up AutoPay for ${info.pn || info.pa}?\n\nMoney can be taken from your account ${often}${info.validityend ? ` until ${upiDate(info.validityend)}` : ''}.`;
      acts.append(h('a', { class: 'btn btn-danger', href: raw, style: { flex: '1 1 100%' }, onclick: e => { if (!confirm(ask)) e.preventDefault(); } }, 'Set up AutoPay in UPI app'));
    }
  } else if (info.kind === 'wifi') {
    let shown = false;
    const pw = h('span', { class: 'mono' }, info.password ? '•'.repeat(Math.min(12, info.password.length)) : '—');
    const eye = info.password ? button('Show', () => { shown = !shown; pw.textContent = shown ? info.password : '•'.repeat(Math.min(12, info.password.length)); eye.querySelector('.lbl').textContent = shown ? 'Hide' : 'Show'; }, { variant: 'ghost', small: true }) : null;
    body.append(h('div', {}, kv('Network', info.ssid || '—', { bold: true, big: true }), kv('Security', info.security === 'None' ? 'Open (no password)' : info.security),
      h('div', { style: { display: 'flex', gap: '12px', padding: '9px 0', alignItems: 'center', borderBottom: '1px solid var(--line)' } },
        h('span', { class: 'muted small', style: { flex: '0 0 92px' } }, 'Password'), h('span', { style: { flex: '1', minWidth: '0', wordBreak: 'break-all' } }, pw), eye),
      info.hidden ? kv('Hidden', 'Yes — add it manually by name') : null),
    muted('Copy the password, then join the network in Settings ▸ Wi-Fi.'));
    if (info.password) { const c = copyButton(info.password, 'Copy password'); c.classList.remove('btn-sm', 'btn-ghost'); c.classList.add('btn-primary'); c.style.flex = '1 1 100%'; acts.append(c); }
  } else if (info.kind === 'contact') {
    body.append(h('div', {}, kv('Name', info.name || '—', { bold: true, big: true }), info.org ? kv('Organisation', info.org) : null, info.title ? kv('Title', info.title) : null,
      ...info.phones.map(p => kv('Phone', p)), ...info.emails.map(e => kv('Email', e)), ...info.urls.map(u => kv('Website', u)), info.address ? kv('Address', info.address) : null));
    const vcard = /^BEGIN:VCARD/i.test(raw) ? raw : buildVcard({ name: info.name || 'Contact', phones: info.phones, emails: info.emails, org: info.org,
      urls: info.urls, address: info.address, title: info.title });
    const save = button('Save to contacts (.vcf)', () => download(new Blob([vcard], { type: 'text/vcard' }), `${safeName(info.name || 'contact')}.vcf`));
    save.style.flex = '1 1 100%'; acts.append(save);
  } else if (info.kind === 'phone') {
    body.append(kv('Number', info.number, { bold: true, big: true }));
    const call = h('a', { class: 'btn btn-primary', href: 'tel:' + info.number.replace(/[^\d+]/g, ''), style: { flex: '1 1 100%' } }, 'Call');
    acts.append(call);
  } else if (info.kind === 'email') {
    body.append(h('div', {}, kv('To', info.to, { bold: true }), info.subject ? kv('Subject', info.subject) : null, info.body ? kv('Message', info.body) : null));
  } else if (info.kind === 'sms') {
    body.append(h('div', {}, kv('To', info.number, { bold: true }), info.body ? kv('Message', info.body) : null),
      muted('Sending messages to unknown numbers can cost money or sign you up for services. Check before you send.'));
  } else if (info.kind === 'geo') {
    body.append(kv('Coordinates', Number.isFinite(info.lat) && Number.isFinite(info.lon) ? `${info.lat}, ${info.lon}` : raw, { mono: true }));
    if (Number.isFinite(info.lat) && Number.isFinite(info.lon)) acts.append(h('a', { class: 'btn btn-primary', style: { flex: '1 1 100%' }, href: `https://maps.google.com/?q=${info.lat},${info.lon}`, target: '_blank', rel: 'noopener noreferrer' }, 'Open in Maps'));
  } else if (info.kind === 'barcode') {
    const name = { ean_13: 'EAN-13 (product)', ean_8: 'EAN-8 (product)', upc_a: 'UPC-A (product)', upc_e: 'UPC-E (product)', code_128: 'Code 128', code_39: 'Code 39', itf: 'ITF', codabar: 'Codabar', code_93: 'Code 93' }[info.format] || info.format;
    body.append(h('div', {}, kv('Type', name), kv('Value', info.text, { bold: true, big: true, mono: true })));
  } else {
    body.append(h('div', { class: 'out', style: { maxHeight: '260px' } }, info.text || '(empty)'));
    if (info.inner) body.append(h('div', { class: 'small muted' }, 'This text contains a link:'), urlBlock(info.inner, info.inner.url ? info.inner.url.href : ''), warnList(info.inner.warnings));
  }
  acts.append(cp, agBtn);
  return h('section', { class: 'result' }, h('div', { class: 'rb stack' },
    h('div', { class: 'rt' }, h('span', {}, icon), label), body, acts,
    h('details', { class: 'small' }, h('summary', { class: 'muted', style: { cursor: 'pointer' } }, 'Show raw content'),
      h('div', { class: 'mono', style: { whiteSpace: 'pre-wrap', wordBreak: 'break-all', marginTop: '6px', color: 'var(--muted)' } }, raw))));
}
