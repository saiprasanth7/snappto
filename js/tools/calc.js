// Calculators & converters. Everything updates live as you type — no Calculate button.
// Pure maths is exported (and unit-tested in node); the UI below only wires it up.
import { h, card, button, field, row, segmented, notice, answer, stats, toast } from '../ui.js';
import * as store from '../store.js';

// ═════════════════════════════ pure helpers ═════════════════════════════

/** Lenient number parser: "1,00,000", "₹ 2,500.50", "18%", "−5", "12,50" (decimal comma) → number; '' or junk → NaN. */
export function parseNum(s) {
  if (typeof s === 'number') return s;
  let t = String(s ?? '').trim().replace(/[−–—]/g, '-').replace(/[₹$€£¥\s%_']/g, '');
  // Comma-decimal keypads (much of Europe, Indonesia, Brazil…) type "12,50". Grouping always ends in 3 digits,
  // so one comma with 1 or 2 digits after it, or "0,125", is the decimal point. "1.234,56" is the same style in full.
  if (!t.includes('.') && /^[+-]?(\d*,\d{1,2}|0,\d+)$/.test(t)) t = t.replace(',', '.');
  else if (/^[+-]?\d{1,3}(\.\d{3})+,\d+$/.test(t)) t = t.replace(/\./g, '').replace(',', '.');
  t = t.replace(/,/g, '');
  if (t.startsWith('+')) t = t.slice(1);
  if (!t || !/^-?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(t)) return NaN;
  return parseFloat(t);
}

/** Round to 2 dp the way people expect (1.005 → 1.01), not the binary-float way. */
export function round2(x) {
  if (!Number.isFinite(x)) return x;
  if (Math.abs(x) < 1e-9) return 0;
  if (Math.abs(x) >= 1e15) return Math.round(x * 100) / 100;
  const r = Number(Math.round(Number(Math.abs(x) + 'e2')) + 'e-2');
  return x < 0 ? -r : r;
}

const nfCache = new Map();
function nf(opts) {
  const k = JSON.stringify(opts);
  let f = nfCache.get(k);
  if (!f) { f = new Intl.NumberFormat('en-IN', opts); nfCache.set(k, f); }
  return f;
}

/** Indian-grouped plain number: 1234567.891 → "12,34,567.89". */
export function fmtNum(n, maxDp = 2, minDp = 0) {
  if (!Number.isFinite(n)) return '—';
  if (Math.abs(n) < 0.5 * 10 ** -maxDp) n = 0;
  return nf({ maximumFractionDigits: maxDp, minimumFractionDigits: Math.min(minDp, maxDp) }).format(n);
}

/** Money with lakh/crore grouping. Whole amounts drop the paise; dp forces a fixed count. */
export function money(n, cur = 'INR', dp) {
  if (!Number.isFinite(n)) return '—';
  if (Math.abs(n) < 0.005) n = 0;
  const d = dp ?? (Math.abs(n - Math.round(n)) < 0.005 ? 0 : 2);
  try { return nf({ style: 'currency', currency: cur, minimumFractionDigits: d, maximumFractionDigits: d }).format(n); }
  catch { return `${cur} ${fmtNum(n, d, d)}`; }
}

/** "₹12.5 lakh" style helper for big amounts ('' below a thousand). */
export function inWords(n, sym = '₹') {
  if (!Number.isFinite(n)) return '';
  const a = Math.abs(n), sign = n < 0 ? '−' : '';
  const f = (v, u) => `${sign}${sym}${nf({ maximumFractionDigits: 2 }).format(v)} ${u}`;
  if (a >= 1e7) return f(a / 1e7, 'crore');
  if (a >= 1e5) return f(a / 1e5, 'lakh');
  if (a >= 1e3) return f(a / 1e3, 'thousand');
  return '';
}

/** Smart number for unit conversions: ~10 significant digits, exponent for extremes. */
export function fmtSmart(n) {
  if (!Number.isFinite(n)) return '—';
  if (n === 0) return '0';
  const a = Math.abs(n);
  if (a >= 1e15 || a < 1e-6) return n.toExponential(4).replace(/\.?0+e/, 'e');
  const p = Number(n.toPrecision(10));
  return nf({ maximumFractionDigits: 10 }).format(p);
}

// ── loans & money ───────────────────────────────────────────────────
/**
 * EMI (reducing balance). Returns null for unusable input.
 * years[] aggregates the schedule per loan-year: {year, principal, interest, balance}.
 */
export function emi(principal, annualRate, months) {
  const P = +principal, n = Math.round(+months), R = +annualRate;
  if (!(P > 0) || !(n > 0) || !(R >= 0) || n > 1200) return null;
  const i = R / 1200;
  const e = i === 0 ? P / n : P * i * Math.pow(1 + i, n) / (Math.pow(1 + i, n) - 1);
  let bal = P;
  const years = [];
  for (let m = 1; m <= n; m++) {
    const int = bal * i;
    const prin = m === n ? bal : e - int;     // last instalment closes the float residue
    bal -= prin;
    const y = Math.ceil(m / 12) - 1;
    const Y = (years[y] ||= { year: y + 1, principal: 0, interest: 0, balance: 0 });
    Y.principal += prin; Y.interest += int; Y.balance = Math.max(0, bal);
  }
  const total = e * n;
  return { emi: e, total, interest: total - P, principal: P, months: n, years };
}

/** Indian GST. mode 'add' = amount is before tax, 'remove' = amount already includes GST. */
export function gst(amount, rate, mode = 'add') {
  const A = +amount, r = +rate;
  if (!(A >= 0) || !(r >= 0)) return null;
  let base, tax, total;
  if (mode === 'remove') { tax = round2(A - A / (1 + r / 100)); total = round2(A); base = round2(total - tax); }
  else { base = round2(A); tax = round2(A * r / 100); total = round2(base + tax); }
  const cgst = round2(tax / 2);
  return { base, tax, total, cgst, sgst: round2(tax - cgst), igst: tax, rate: r };
}

export const percentOf = (x, y) => (+x / 100) * +y;
export const whatPercent = (x, y) => (+y === 0 ? NaN : (+x / +y) * 100);
export const pctChange = (a, b) => (+a === 0 ? NaN : ((+b - +a) / Math.abs(+a)) * 100);

/** Price after % off, then an optional extra % off on the already-reduced price. */
export function discount(price, pct, extra = 0) {
  const P = +price, d1 = +pct || 0, d2 = +extra || 0;
  if (!(P >= 0) || d1 < 0 || d2 < 0 || d1 > 100 || d2 > 100) return null;
  const final = P * (1 - d1 / 100) * (1 - d2 / 100);
  const saved = P - final;
  return { final, saved, effective: P ? (saved / P) * 100 : 0 };
}

export function simpleInterest(p, rate, years) {
  const P = +p, r = +rate, t = +years;
  if (!(P >= 0) || !(r >= 0) || !(t >= 0)) return null;
  const interest = P * r * t / 100;
  return { interest, total: P + interest };
}

/** Compound interest, k = compoundings per year (1, 2, 4, 12). */
export function compoundInterest(p, rate, years, k = 1) {
  const P = +p, r = +rate, t = +years;
  if (!(P >= 0) || !(r >= 0) || !(t >= 0) || !(k > 0)) return null;
  const total = P * Math.pow(1 + r / 100 / k, k * t);
  return { interest: total - P, total, effectiveRate: (Math.pow(1 + r / 100 / k, k) - 1) * 100 };
}

/** Split an amount in paise evenly; leftover paise go to the first people. */
export function splitEven(totalPaise, people) {
  const n = Math.max(1, Math.floor(people));
  const base = Math.floor(totalPaise / n), rem = totalPaise - base * n;
  return Array.from({ length: n }, (_, i) => base + (i < rem ? 1 : 0));
}

/** Split paise by weights with largest-remainder rounding, so parts always add up exactly. */
export function splitByShares(totalPaise, shares) {
  const w = shares.map(s => (Number.isFinite(+s) && +s > 0 ? +s : 0));
  const sum = w.reduce((a, b) => a + b, 0);
  if (!sum) return w.map(() => 0);
  const raw = w.map(x => (totalPaise * x) / sum);
  const out = raw.map(Math.floor);
  let left = totalPaise - out.reduce((a, b) => a + b, 0);
  const order = raw.map((x, i) => [x - Math.floor(x), i]).filter(([, i]) => w[i] > 0).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (let j = 0; left > 0 && order.length; j = (j + 1) % order.length, left--) out[order[j][1]]++;
  return out;
}

export function tipCalc(bill, tipPct, people = 1) {
  const B = +bill, t = +tipPct || 0, n = Math.max(1, Math.floor(+people || 1));
  if (!(B >= 0) || t < 0) return null;
  const tip = round2(B * t / 100), total = round2(B + tip);
  const parts = splitEven(Math.round(total * 100), n);
  return { tip, total, people: n, per: parts[n - 1] / 100, max: parts[0] / 100, parts };
}

// ── dates (all arithmetic in UTC days, so DST never shifts a date) ───
const DAY = 86400000;
/** 'YYYY-MM-DD' → UTC ms, or null if not a real calendar date. */
export function parseISODate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || '').trim());
  if (!m) return null;
  const y = +m[1], mo = +m[2] - 1, d = +m[3];
  const dt = new Date(0); dt.setUTCFullYear(y, mo, d); dt.setUTCHours(0, 0, 0, 0);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo || dt.getUTCDate() !== d) return null;
  return dt.getTime();
}
export function isoOf(t) { return new Date(t).toISOString().slice(0, 10); }
export function todayUTC() { const n = new Date(); return Date.UTC(n.getFullYear(), n.getMonth(), n.getDate()); }

function ymd(t) { const d = new Date(t); return [d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()]; }
/** Add months, clamping the day to the month's end (31 Jan + 1 month = 28/29 Feb). */
export function addMonths(t, months) {
  const [y, m, d] = ymd(t);
  const tm = m + months, ty = y + Math.floor(tm / 12), mm = ((tm % 12) + 12) % 12;
  const dt = new Date(0); dt.setUTCFullYear(ty, mm + 1, 0);
  const dim = dt.getUTCDate();
  dt.setUTCFullYear(ty, mm, Math.min(d, dim));
  return dt.getTime();
}

/** Calendar difference a→b (a ≤ b): whole years, months, then days. */
export function calendarDiff(a, b) {
  const [ay, am] = ymd(a), [by, bm] = ymd(b);
  let months = (by - ay) * 12 + (bm - am);
  if (addMonths(a, months) > b) months--;
  const anchor = addMonths(a, months);
  return { years: Math.floor(months / 12), months: months % 12, days: Math.round((b - anchor) / DAY), totalMonths: months };
}

/** Exact age on a date + next birthday. Feb-29 birthdays fall on 28 Feb in other years. */
export function ageOn(dob, ref) {
  if (dob == null || ref == null || ref < dob) return null;
  const diff = calendarDiff(dob, ref);
  const totalDays = Math.round((ref - dob) / DAY);
  let k = diff.years, next = addMonths(dob, 12 * k);
  if (next < ref) { k++; next = addMonths(dob, 12 * k); }
  return { ...diff, totalDays, totalWeeks: Math.floor(totalDays / 7), nextBirthday: next,
    daysToBirthday: Math.round((next - ref) / DAY), turning: k, isBirthday: next === ref };
}

/** Mon–Fri days in [a, b). */
export function countWeekdays(a, b) {
  const days = Math.round((b - a) / DAY);
  let n = Math.floor(days / 7) * 5;
  const start = new Date(a).getUTCDay();
  for (let i = 0; i < days % 7; i++) { const w = (start + i) % 7; if (w !== 0 && w !== 6) n++; }
  return n;
}

export function dateDiff(a, b, inclusive = false) {
  if (a == null || b == null) return null;
  let swapped = false;
  if (b < a) { [a, b] = [b, a]; swapped = true; }
  const end = inclusive ? b + DAY : b;
  const totalDays = Math.round((end - a) / DAY);
  // years/months/days = calendar breakdown; totalDays = the plain day count.
  return { ...calendarDiff(a, end), totalDays, weeks: Math.floor(totalDays / 7), weekDays: totalDays % 7,
    weekdays: countWeekdays(a, end), swapped };
}

// ── unit conversion ─────────────────────────────────────────────────
// Each unit: [id, label, factor-to-base]. Temperature is special-cased.
export const UNITS = {
  length: { label: 'Length', emoji: '📏', base: 'm', units: [
    ['mm', 'Millimetre', 0.001], ['cm', 'Centimetre', 0.01], ['m', 'Metre', 1], ['km', 'Kilometre', 1000],
    ['in', 'Inch', 0.0254], ['ft', 'Foot', 0.3048], ['yd', 'Yard', 0.9144], ['mi', 'Mile', 1609.344], ['nmi', 'Nautical mile', 1852]] },
  weight: { label: 'Weight', emoji: '⚖️', units: [
    ['mg', 'Milligram', 1e-6], ['g', 'Gram', 0.001], ['kg', 'Kilogram', 1], ['q', 'Quintal (100 kg)', 100], ['t', 'Tonne', 1000],
    ['oz', 'Ounce', 0.028349523125], ['lb', 'Pound', 0.45359237], ['st', 'Stone', 6.35029318],
    ['tola', 'Tola', 0.0116638038], ['ct', 'Carat', 0.0002]] },
  temperature: { label: 'Temperature', emoji: '🌡️', units: [['C', 'Celsius (°C)'], ['F', 'Fahrenheit (°F)'], ['K', 'Kelvin (K)']] },
  area: { label: 'Area', emoji: '🗺️', units: [
    ['cm2', 'Square centimetre', 1e-4], ['m2', 'Square metre', 1], ['ft2', 'Square foot', 0.09290304],
    ['yd2', 'Square yard (gaj)', 0.83612736], ['in2', 'Square inch', 0.00064516], ['cent', 'Cent', 40.468564224],
    ['guntha', 'Guntha', 101.17141056], ['acre', 'Acre', 4046.8564224], ['ha', 'Hectare', 10000],
    ['km2', 'Square kilometre', 1e6], ['mi2', 'Square mile', 2589988.110336]] },
  volume: { label: 'Volume', emoji: '🧪', units: [
    ['ml', 'Millilitre', 0.001], ['l', 'Litre', 1], ['m3', 'Cubic metre', 1000], ['tsp', 'Teaspoon (US)', 0.00492892159375],
    ['tbsp', 'Tablespoon (US)', 0.01478676478125], ['cup', 'Cup (US)', 0.2365882365], ['floz', 'Fluid ounce (US)', 0.0295735295625],
    ['pt', 'Pint (US)', 0.473176473], ['gal', 'Gallon (US)', 3.785411784], ['galuk', 'Gallon (UK)', 4.54609], ['ft3', 'Cubic foot', 28.316846592]] },
  speed: { label: 'Speed', emoji: '🚗', units: [
    ['ms', 'Metres / second', 1], ['kmh', 'Kilometres / hour', 1 / 3.6], ['mph', 'Miles / hour', 0.44704],
    ['kn', 'Knot', 1852 / 3600], ['fts', 'Feet / second', 0.3048]] },
  data: { label: 'Data', emoji: '💾', units: [
    ['bit', 'Bit', 1 / 8], ['B', 'Byte', 1], ['KB', 'Kilobyte (1024 B)', 1024], ['MB', 'Megabyte', 1024 ** 2],
    ['GB', 'Gigabyte', 1024 ** 3], ['TB', 'Terabyte', 1024 ** 4], ['PB', 'Petabyte', 1024 ** 5]] },
  time: { label: 'Time', emoji: '⏱️', units: [
    ['ms', 'Millisecond', 0.001], ['s', 'Second', 1], ['min', 'Minute', 60], ['h', 'Hour', 3600], ['d', 'Day', 86400],
    ['wk', 'Week', 604800], ['mo', 'Month (avg)', 2629800], ['yr', 'Year (365.25 d)', 31557600]] },
};
const SHORT = { C: '°C', F: '°F', K: 'K', m2: 'm²', cm2: 'cm²', ft2: 'sq ft', yd2: 'sq yd', in2: 'sq in', km2: 'km²', mi2: 'sq mi',
  m3: 'm³', ft3: 'cu ft', ms: 'm/s', kmh: 'km/h', fts: 'ft/s', kn: 'knots', floz: 'fl oz', galuk: 'UK gal', gal: 'US gal', l: 'L',
  ha: 'ha', q: 'quintal', d: 'days', wk: 'weeks', mo: 'months', yr: 'years', h: 'hours' };
const unitShort = (cat, id) => (cat === 'time' && id === 'ms') ? 'ms' : (SHORT[id] || id);

export function convertUnit(cat, value, from, to) {
  const v = +value, C = UNITS[cat];
  if (!C || !Number.isFinite(v)) return NaN;
  if (cat === 'temperature') {
    const c = from === 'C' ? v : from === 'F' ? (v - 32) * 5 / 9 : from === 'K' ? v - 273.15 : NaN;
    return to === 'C' ? c : to === 'F' ? c * 9 / 5 + 32 : to === 'K' ? c + 273.15 : NaN;
  }
  const f = C.units.find(u => u[0] === from), t = C.units.find(u => u[0] === to);
  if (!f || !t) return NaN;
  return v * f[2] / t[2];
}

// ── currency ────────────────────────────────────────────────────────
export const CURRENCIES = [
  ['INR', 'Indian rupee', '🇮🇳'], ['USD', 'US dollar', '🇺🇸'], ['AED', 'UAE dirham', '🇦🇪'], ['SAR', 'Saudi riyal', '🇸🇦'],
  ['EUR', 'Euro', '🇪🇺'], ['GBP', 'British pound', '🇬🇧'], ['QAR', 'Qatari riyal', '🇶🇦'], ['KWD', 'Kuwaiti dinar', '🇰🇼'],
  ['OMR', 'Omani rial', '🇴🇲'], ['BHD', 'Bahraini dinar', '🇧🇭'], ['SGD', 'Singapore dollar', '🇸🇬'], ['CAD', 'Canadian dollar', '🇨🇦'],
  ['AUD', 'Australian dollar', '🇦🇺'], ['NZD', 'New Zealand dollar', '🇳🇿'], ['MYR', 'Malaysian ringgit', '🇲🇾'], ['JPY', 'Japanese yen', '🇯🇵'],
  ['CNY', 'Chinese yuan', '🇨🇳'], ['HKD', 'Hong Kong dollar', '🇭🇰'], ['THB', 'Thai baht', '🇹🇭'], ['CHF', 'Swiss franc', '🇨🇭'],
  ['LKR', 'Sri Lankan rupee', '🇱🇰'], ['NPR', 'Nepalese rupee', '🇳🇵'], ['BDT', 'Bangladeshi taka', '🇧🇩'], ['PKR', 'Pakistani rupee', '🇵🇰'],
  ['MVR', 'Maldivian rufiyaa', '🇲🇻'], ['BTN', 'Bhutanese ngultrum', '🇧🇹'], ['ZAR', 'South African rand', '🇿🇦'], ['IDR', 'Indonesian rupiah', '🇮🇩'],
  ['PHP', 'Philippine peso', '🇵🇭'], ['KRW', 'South Korean won', '🇰🇷'], ['VND', 'Vietnamese dong', '🇻🇳'], ['SEK', 'Swedish krona', '🇸🇪'],
  ['NOK', 'Norwegian krone', '🇳🇴'], ['DKK', 'Danish krone', '🇩🇰'], ['RUB', 'Russian rouble', '🇷🇺'], ['TRY', 'Turkish lira', '🇹🇷'],
  ['BRL', 'Brazilian real', '🇧🇷'], ['MXN', 'Mexican peso', '🇲🇽'], ['EGP', 'Egyptian pound', '🇪🇬'], ['NGN', 'Nigerian naira', '🇳🇬'],
  ['KES', 'Kenyan shilling', '🇰🇪'], ['ILS', 'Israeli shekel', '🇮🇱'],
];

/** Normalise either API's JSON into {base, rates, updated(ms), source}; null if unusable. */
export function parseRates(json, base, source) {
  if (!json || typeof json !== 'object' || !json.rates || typeof json.rates !== 'object') return null;
  if (source === 'er' && json.result !== 'success') return null;
  const rates = {};
  for (const [k, v] of Object.entries(json.rates)) if (/^[A-Z]{3}$/.test(k) && Number.isFinite(+v) && +v > 0) rates[k] = +v;
  rates[base] = 1;
  if (Object.keys(rates).length < 2) return null;
  const updated = source === 'er' ? (+json.time_last_update_unix || 0) * 1000 : (Date.parse(json.date) || 0);
  return { base, rates, updated, source: source === 'er' ? 'open.er-api.com' : 'frankfurter.app' };
}

/** Rate from→to using any table that has both codes (cross rate via its base). */
export function crossRate(table, from, to) {
  if (!table || !table.rates) return NaN;
  if (from === to) return 1;
  const a = table.rates[from], b = table.rates[to];
  return a > 0 && b > 0 ? b / a : NaN;
}

/**
 * Pick the saved table to convert from→to with. The direct table (base = from) wins unless another
 * table that has both codes is more than 6 hours newer, judged by the provider's own date.
 */
export function bestTable(cache, from, to) {
  const age = e => e.updated || e.ts || 0;
  const all = Object.values(cache || {}).filter(e => e && e.rates && e.rates[from] > 0 && e.rates[to] > 0).sort((a, b) => age(b) - age(a));
  const direct = all.find(e => e.base === from);
  if (direct && all[0] && age(all[0]) - age(direct) <= 6 * 3.6e6) return direct;
  return all[0] || null;
}

// ═════════════════════════════ UI helpers ═════════════════════════════
const numField = (label, opts = {}) => field({ label, inputmode: 'decimal', placeholder: opts.placeholder ?? '0', value: opts.value ?? '', hint: opts.hint });
const val = f => parseNum(f.value);
const muted = t => h('p', { class: 'muted small', style: { margin: 0 } }, t);
const listen = (els, fn) => { for (const e of els) (e.input || e).addEventListener('input', fn); };

/** Save/restore field values per tool (only on this device). */
function remember(key, fields) {
  const saved = store.get('calc:' + key, null);
  if (saved && typeof saved === 'object') for (const [k, f] of Object.entries(fields)) if (saved[k] != null && typeof saved[k] === 'string') f.value = saved[k];
  const save = () => store.set('calc:' + key, Object.fromEntries(Object.entries(fields).map(([k, f]) => [k, String(f.value ?? '')])));
  for (const f of Object.values(fields)) (f.input || f).addEventListener?.('input', save);
  return save;
}

/** Live "₹12.5 lakh" helper under an amount field. */
function wordsUnder(f, sym = '₹') {
  const w = h('div', { class: 'hint', style: { minHeight: '1em' } });
  f.el.append(w);
  const upd = () => { w.textContent = inWords(val(f), sym); };
  f.input.addEventListener('input', upd); upd();
  return upd;
}

/** A checkbox styled to the app; 44 px tall tap target. */
function toggle(label, checked, onChange) {
  const input = h('input', { type: 'checkbox', style: { width: '22px', height: '22px', accentColor: 'var(--brand)', margin: 0, flex: 'none' } });
  input.checked = !!checked;
  input.addEventListener('change', () => onChange && onChange(input.checked));
  const el = h('label', { style: { display: 'flex', alignItems: 'center', gap: '10px', minHeight: '44px', cursor: 'pointer', fontSize: '15px' } }, input, h('span', {}, label));
  return { el, input, get checked() { return input.checked; }, set checked(v) { input.checked = v; } };
}

/** − n + stepper for counts like "people". */
function stepper(label, value, min, max, onChange) {
  const input = h('input', { type: 'text', inputmode: 'numeric', value: String(value), style: { textAlign: 'center', fontWeight: '650' } });
  const set = v => { v = Math.max(min, Math.min(max, Math.round(v) || min)); input.value = String(v); onChange(v); };
  const minus = button('−', () => set(parseNum(input.value) - 1), { variant: 'ghost' });
  const plus = button('+', () => set(parseNum(input.value) + 1), { variant: 'ghost' });
  for (const b of [minus, plus]) Object.assign(b.style, { flex: 'none', width: '52px', fontSize: '22px', padding: '0' });
  input.addEventListener('input', () => { const v = parseNum(input.value); if (v >= min && v <= max) onChange(Math.round(v)); });
  input.addEventListener('blur', () => set(parseNum(input.value)));
  const el = h('div', { class: 'field' }, h('label', {}, label), h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } }, minus, input, plus));
  return { el, input, get value() { return Math.max(min, Math.min(max, Math.round(parseNum(input.value)) || min)); } };
}

/** Rate chips + optional custom value. Returns {el, get value()}. */
function rateChips(rates, initial, onChange, { suffix = '%', customLabel = 'Custom rate (%)' } = {}) {
  const custom = numField(customLabel, { placeholder: 'e.g. 7.5' });
  let cur = rates.includes(+initial) ? String(+initial) : 'custom';
  if (cur === 'custom') custom.value = String(initial ?? '');
  const seg = segmented([...rates.map(r => [String(r), r + suffix]), ['custom', 'Other']], cur, v => {
    cur = v; custom.el.classList.toggle('hidden', v !== 'custom');
    if (v === 'custom') setTimeout(() => custom.input.focus(), 30);
    onChange();
  });
  custom.el.classList.toggle('hidden', cur !== 'custom');
  custom.input.addEventListener('input', onChange);
  return { el: h('div', { class: 'stack' }, seg, custom.el), get value() { return cur === 'custom' ? val(custom) : +cur; },
    get raw() { return cur === 'custom' ? 'c' + custom.value : cur; },
    set raw(r) { if (typeof r !== 'string') return; if (r.startsWith('c')) { cur = 'custom'; custom.value = r.slice(1); } else if (rates.includes(+r)) cur = r; seg.setValue(cur); custom.el.classList.toggle('hidden', cur !== 'custom'); } };
}

/** Two-part proportion bar with a legend. parts: [[label, value, cssColor], ...] */
function shareBar(parts) {
  const total = parts.reduce((a, p) => a + Math.max(0, p[1]), 0) || 1;
  return h('div', { class: 'stack', style: { gap: '8px' } },
    h('div', { style: { display: 'flex', height: '12px', borderRadius: '99px', overflow: 'hidden', background: 'var(--line)' } },
      parts.map(([, v, c]) => h('div', { style: { width: (Math.max(0, v) / total * 100).toFixed(2) + '%', background: c } }))),
    h('div', { class: 'small muted', style: { display: 'flex', gap: '16px', flexWrap: 'wrap' } },
      parts.map(([l, v, c]) => h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: '6px' } },
        h('span', { style: { width: '10px', height: '10px', borderRadius: '3px', background: c, display: 'inline-block' } }),
        `${l} ${Math.round(Math.max(0, v) / total * 100)}%`))));
}

function resultArea(title = 'Result') { const out = h('div', { class: 'stack' }); return { card: card({ title }, out), out }; }
const fmtDate = t => new Intl.DateTimeFormat('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(t);
const weekday = t => new Intl.DateTimeFormat('en-IN', { weekday: 'long', timeZone: 'UTC' }).format(t);
const plural = (n, w, ws = w + 's') => `${fmtNum(n, 0)} ${n === 1 ? w : ws}`;

// ═════════════════════════════ mount ═════════════════════════════
export async function mount(root, toolId) {
  try {
    const fn = {
      currency: mountCurrency, emi: mountEmi, gst: mountGst, percentage: mountPercentage, discount: mountDiscount,
      interest: mountInterest, age: mountAge, datediff: mountDateDiff, tip: r => mountSplit(r, 'tip'),
      billsplit: r => mountSplit(r, 'billsplit'), convert: mountConvert,
    }[toolId];
    if (!fn) { root.append(notice('This calculator isn’t available yet.', 'warn')); return; }
    await fn(root);
  } catch (e) {
    console.error(e);
    root.append(notice('Something went wrong setting up this calculator. Please reload the page.', 'err'));
  }
}

// ── EMI ─────────────────────────────────────────────────────────────
function mountEmi(root) {
  const P = numField('Loan amount (₹)', { placeholder: 'e.g. 10,00,000' });
  const R = numField('Interest rate (% per year)', { placeholder: 'e.g. 8.5' });
  const T = numField('Tenure', { placeholder: 'e.g. 20' });
  const unit = { value: 'y' };
  const seg = segmented([['y', 'Years'], ['m', 'Months']], 'y', v => { unit.value = v; save(); calc(); });
  const save = remember('emi', { P, R, T, unit });
  seg.setValue(unit.value === 'm' ? 'm' : 'y');
  wordsUnder(P);
  const res = resultArea('Your EMI');
  const sched = h('div');
  root.append(card({ title: 'Loan details' }, P.el, R.el, T.el, seg), res.card, sched);

  function calc() {
    const p = val(P), r = val(R), t = val(T);
    const months = unit.value === 'm' ? Math.round(t) : Math.round(t * 12);
    sched.replaceChildren();
    if (!(p > 0) || !(r >= 0) || !(t > 0)) { res.out.replaceChildren(muted('Enter the loan amount, interest rate and tenure.')); return; }
    if (months > 1200) { res.out.replaceChildren(notice('That tenure is too long — use up to 100 years.', 'warn')); return; }
    if (r > 60) { res.out.replaceChildren(notice('That interest rate looks too high. Enter the yearly rate, e.g. 8.5.', 'warn')); return; }
    const e = emi(p, r, months);
    if (!e) { res.out.replaceChildren(muted('Check the numbers above.')); return; }
    res.out.replaceChildren(
      answer(money(e.emi, 'INR', 2) + ' / month', `for ${plural(months, 'month')}${months >= 12 ? ` (${fmtNum(months / 12, 1)} years)` : ''}`),
      stats([['Total interest', money(e.interest, 'INR', 0)], ['Total payment', money(e.total, 'INR', 0)], ['Loan amount', money(p, 'INR', 0)]]),
      shareBar([['Principal', p, 'var(--brand)'], ['Interest', e.interest, 'var(--accent)']]));
    const cell = { padding: '7px 6px', textAlign: 'right', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' };
    const th = (t, left) => h('th', { style: { ...cell, textAlign: left ? 'left' : 'right', fontWeight: '650', color: 'var(--muted)', fontSize: '12px', borderBottom: '1px solid var(--line)' } }, t);
    const short = n => money(n, 'INR', 0);
    sched.append(card({ title: 'Year by year', sub: 'How each year’s EMIs split between principal and interest.' },
      h('div', { style: { overflowX: 'auto', margin: '0 -6px' } },
        h('table', { style: { width: '100%', borderCollapse: 'collapse', fontSize: '13px' } },
          h('thead', {}, h('tr', {}, th('Year', true), th('Principal'), th('Interest'), th('Balance'))),
          h('tbody', {}, e.years.map((y, i) => h('tr', { style: { background: i % 2 ? 'var(--surface-2)' : '' } },
            h('td', { style: { ...cell, textAlign: 'left', fontWeight: '600' } }, y.year),
            h('td', { style: cell }, short(y.principal)), h('td', { style: cell }, short(y.interest)), h('td', { style: cell }, short(y.balance)))))))));
  }
  listen([P, R, T], calc); calc();
}

// ── GST ─────────────────────────────────────────────────────────────
function mountGst(root) {
  const A = numField('Amount (₹)', { placeholder: 'e.g. 1,180' });
  let mode = 'add';
  const modeSeg = segmented([['add', 'Add GST'], ['remove', 'Remove GST']], mode, v => { mode = v; modeHint.textContent = hintFor(); store.set('calc:gst-mode', v); calc(); });
  const hintFor = () => mode === 'add' ? 'Amount is before tax — GST is added on top.' : 'Amount already includes GST — find the price before tax.';
  const modeHint = h('div', { class: 'hint small faint' });
  const rate = rateChips([0, 3, 5, 12, 18, 28, 40], 18, () => { store.set('calc:gst-rate', rate.raw); calc(); });
  remember('gst', { A });
  const m0 = store.get('calc:gst-mode', 'add'); if (m0 === 'remove') { mode = 'remove'; modeSeg.setValue('remove'); }
  rate.raw = store.get('calc:gst-rate', '18');
  modeHint.textContent = hintFor();
  wordsUnder(A);
  const res = resultArea();
  root.append(card({ title: 'Amount' }, A.el, modeSeg, modeHint), card({ title: 'GST rate' }, rate.el), res.card);

  function calc() {
    const a = val(A), r = rate.value;
    if (!(a >= 0) || !A.value.trim()) { res.out.replaceChildren(muted('Enter an amount to see the GST.')); return; }
    if (!(r >= 0) || r > 100) { res.out.replaceChildren(muted('Choose a GST rate.')); return; }
    const g = gst(a, r, mode);
    const half = fmtNum(r / 2, 3);
    res.out.replaceChildren(
      answer(mode === 'add' ? money(g.total, 'INR', 2) : money(g.base, 'INR', 2), mode === 'add' ? 'Total with GST' : 'Price before GST'),
      stats([['Before GST', money(g.base, 'INR', 2)], [`GST ${fmtNum(r, 3)}%`, money(g.tax, 'INR', 2)], ['Total', money(g.total, 'INR', 2)]]),
      h('div', { class: 'stack', style: { gap: '6px' } },
        h('div', { class: 'small' }, h('b', {}, 'Within the same state: '), `CGST ${half}% ${money(g.cgst, 'INR', 2)} + SGST ${half}% ${money(g.sgst, 'INR', 2)}`),
        h('div', { class: 'small' }, h('b', {}, 'Between states: '), `IGST ${fmtNum(r, 3)}% ${money(g.igst, 'INR', 2)}`)));
  }
  listen([A], calc); calc();
}

// ── Percentage ──────────────────────────────────────────────────────
function mountPercentage(root) {
  const mk = (title, l1, l2, fn) => {
    const a = numField(l1), b = numField(l2), out = h('div', { style: { minHeight: '44px' } });
    const upd = () => out.replaceChildren(fn(val(a), val(b), a.value.trim() && b.value.trim()));
    listen([a, b], upd); upd();
    root.append(card({ title }, row(a.el, b.el), out));
  };
  const big = (t, sub) => answer(t, sub);
  const wait = muted('Fill in both numbers.');
  mk('What is X% of Y?', 'X (%)', 'Y', (x, y, ok) => ok && Number.isFinite(x) && Number.isFinite(y)
    ? big(fmtNum(percentOf(x, y), 4), `${fmtNum(x, 4)}% of ${fmtNum(y, 4)}`) : wait.cloneNode(true));
  mk('X is what % of Y?', 'X', 'Y', (x, y, ok) => {
    if (!ok || !Number.isFinite(x) || !Number.isFinite(y)) return wait.cloneNode(true);
    if (y === 0) return muted('Y can’t be zero.');
    return big(fmtNum(whatPercent(x, y), 4) + '%', `${fmtNum(x, 4)} out of ${fmtNum(y, 4)}`);
  });
  mk('Percentage change', 'From', 'To', (a, b, ok) => {
    if (!ok || !Number.isFinite(a) || !Number.isFinite(b)) return wait.cloneNode(true);
    if (a === 0) return muted('The starting value can’t be zero.');
    const c = pctChange(a, b);
    const up = c > 0, same = Math.abs(c) < 1e-12;
    return h('div', {}, h('div', { class: 'big-answer', style: { color: same ? '' : up ? 'var(--ok)' : 'var(--err)' } },
      `${same ? '' : up ? '+' : '−'}${fmtNum(Math.abs(c), 2)}%`),
      h('div', { class: 'muted small' }, same ? 'No change' : `${up ? 'Increase' : 'Decrease'} of ${fmtNum(Math.abs(b - a), 4)}`));
  });
}

// ── Discount ────────────────────────────────────────────────────────
function mountDiscount(root) {
  const P = numField('Price (₹)', { placeholder: 'e.g. 2,499' });
  const D = numField('Discount (% off)', { placeholder: 'e.g. 30' });
  const X = numField('Extra discount (% off, optional)', { placeholder: 'e.g. 10', hint: 'Applied on the already-reduced price, like “extra 10% off” at checkout.' });
  remember('discount', { P, D, X });
  const res = resultArea();
  root.append(card({ title: 'Price' }, P.el, row(D.el, X.el)), res.card);
  const calc = () => {
    const p = val(P), d = D.value.trim() ? val(D) : 0, x = X.value.trim() ? val(X) : 0;
    if (!(p >= 0) || !P.value.trim()) { res.out.replaceChildren(muted('Enter the price and the discount.')); return; }
    if (!(d >= 0 && d <= 100) || !(x >= 0 && x <= 100)) { res.out.replaceChildren(notice('Discounts must be between 0 and 100%.', 'warn')); return; }
    const r = discount(p, d, x);
    res.out.replaceChildren(answer(money(r.final, 'INR'), 'You pay'),
      stats([['You save', money(r.saved, 'INR')], ['Total discount', fmtNum(r.effective, 2) + '%']]),
      x > 0 ? muted(`${fmtNum(d, 2)}% + ${fmtNum(x, 2)}% extra is ${fmtNum(r.effective, 2)}% in total, not ${fmtNum(d + x, 2)}%.`) : null);
  };
  listen([P, D, X], calc); calc();
}

// ── Interest ────────────────────────────────────────────────────────
function mountInterest(root) {
  let kind = store.get('calc:interest-kind', 'compound') === 'simple' ? 'simple' : 'compound';
  const kindSeg = segmented([['simple', 'Simple'], ['compound', 'Compound']], kind, v => { kind = v; store.set('calc:interest-kind', v); freq.el.classList.toggle('hidden', v !== 'compound'); calc(); });
  const P = numField('Principal (₹)', { placeholder: 'e.g. 1,00,000' });
  const R = numField('Interest rate (% per year)', { placeholder: 'e.g. 7' });
  const T = numField('Time', { placeholder: 'e.g. 5' });
  const unit = { value: 'y' };
  const tSeg = segmented([['y', 'Years'], ['m', 'Months']], 'y', v => { unit.value = v; save(); calc(); });
  const freq = field({ label: 'Interest added', options: [['1', 'Yearly'], ['2', 'Half-yearly'], ['4', 'Quarterly'], ['12', 'Monthly']], value: '4', hint: 'Most Indian bank FDs add interest quarterly.' });
  const save = remember('interest', { P, R, T, unit, freq });
  tSeg.setValue(unit.value === 'm' ? 'm' : 'y');
  freq.el.classList.toggle('hidden', kind !== 'compound');
  freq.input.addEventListener('change', () => { save(); calc(); });
  wordsUnder(P);
  const res = resultArea('Maturity');
  root.append(card({}, kindSeg, P.el, R.el, T.el, tSeg, freq.el), res.card);
  function calc() {
    const p = val(P), r = val(R), t0 = val(T);
    if (!(p > 0) || !(r >= 0) || !(t0 > 0)) { res.out.replaceChildren(muted('Enter the principal, rate and time.')); return; }
    const years = unit.value === 'm' ? t0 / 12 : t0;
    if (years > 200) { res.out.replaceChildren(notice('Use a time of up to 200 years.', 'warn')); return; }
    const k = +freq.value || 1;
    const x = kind === 'simple' ? simpleInterest(p, r, years) : compoundInterest(p, r, years, k);
    if (!x || !Number.isFinite(x.total)) { res.out.replaceChildren(muted('That’s too large to calculate.')); return; }
    const sub = `${kind === 'simple' ? 'Simple' : 'Compound'} interest for ${fmtNum(t0, 2)} ${unit.value === 'm' ? 'months' : 'years'}`;
    res.out.replaceChildren(answer(money(x.total, 'INR', 2), sub),
      inWords(x.total) ? muted(inWords(x.total)) : null,
      stats([['Interest earned', money(x.interest, 'INR', 2)], ['Principal', money(p, 'INR', 2)],
        kind === 'compound' ? ['Effective yearly rate', fmtNum(x.effectiveRate, 2) + '%'] : null].filter(Boolean)),
      shareBar([['Principal', p, 'var(--brand)'], ['Interest', x.interest, 'var(--ok)']]));
  }
  listen([P, R, T], calc); calc();
}

// ── Age ─────────────────────────────────────────────────────────────
function mountAge(root) {
  const D = field({ label: 'Date of birth', type: 'date' });
  const O = field({ label: 'Age on (optional)', type: 'date', hint: 'Leave empty for today — or pick a date like an exam cut-off.' });
  D.input.max = isoOf(todayUTC());
  const res = resultArea('Age');
  const reset = button('Use today', () => { O.value = ''; calc(); }, { variant: 'ghost', small: true });
  root.append(card({}, D.el, O.el, reset), res.card);
  function calc() {
    const dob = parseISODate(D.value), ref = O.value ? parseISODate(O.value) : todayUTC();
    reset.classList.toggle('hidden', !O.value);
    if (dob == null) { res.out.replaceChildren(muted('Pick a date of birth.')); return; }
    if (ref == null) { res.out.replaceChildren(muted('Pick a valid “age on” date.')); return; }
    const a = ageOn(dob, ref);
    if (!a) { res.out.replaceChildren(notice('The date of birth is after the “age on” date.', 'warn')); return; }
    const leap = D.value.slice(5) === '02-29';
    res.out.replaceChildren(
      answer(plural(a.years, 'year'), `${plural(a.months, 'month')}, ${plural(a.days, 'day')}${O.value ? ` · on ${fmtDate(ref)}` : ''}`),
      stats([['Total months', fmtNum(a.years * 12 + a.months, 0)], ['Total weeks', fmtNum(a.totalWeeks, 0)], ['Total days', fmtNum(a.totalDays, 0)]]),
      a.isBirthday ? notice(`Happy birthday! 🎉 Turning ${a.turning} today.`, 'ok')
        : h('div', { class: 'small' }, h('b', {}, '🎂 Next birthday: '),
          `in ${plural(a.daysToBirthday, 'day')} — ${fmtDate(a.nextBirthday)} (turns ${a.turning})`),
      muted(`Born on a ${weekday(dob)}.${leap ? ' In non-leap years we count the birthday on 28 Feb.' : ''}`));
  }
  listen([D, O], calc); D.input.addEventListener('change', calc); O.input.addEventListener('change', calc); calc();
}

// ── Date difference ─────────────────────────────────────────────────
function mountDateDiff(root) {
  const A = field({ label: 'From', type: 'date', value: isoOf(todayUTC()) });
  const B = field({ label: 'To', type: 'date' });
  const inc = toggle('Count both the start and end day', false, () => calc());
  const res = resultArea('Difference');
  root.append(card({}, row(A.el, B.el), inc.el), res.card);
  function calc() {
    const a = parseISODate(A.value), b = parseISODate(B.value);
    if (a == null || b == null) { res.out.replaceChildren(muted('Pick both dates.')); return; }
    const d = dateDiff(a, b, inc.checked);
    const ymdTxt = [d.years && plural(d.years, 'year'), d.months && plural(d.months, 'month'), (d.days || (!d.years && !d.months)) && plural(d.days, 'day')].filter(Boolean).join(', ');
    res.out.replaceChildren(
      answer(plural(d.totalDays, 'day'), ymdTxt),
      stats([['Weeks', `${fmtNum(d.weeks, 0)}${d.weekDays ? ` + ${d.weekDays} d` : ''}`],
        ['Months', `${fmtNum(d.totalMonths, 0)}${d.days ? ` + ${d.days} d` : ''}`],
        ['Weekdays (Mon–Fri)', fmtNum(d.weekdays, 0)], ['Years', fmtNum(d.totalDays / 365.2425, 2)]]),
      d.swapped ? muted('“To” is before “From” — showing the gap between them.') : null,
      muted(inc.checked ? 'Both the start and end day are counted.' : 'The end day isn’t counted (like counting nights).'));
  }
  listen([A, B], calc); A.input.addEventListener('change', calc); B.input.addEventListener('change', calc); calc();
}

// ── Tip & bill split ────────────────────────────────────────────────
function mountSplit(root, kind) {
  const B = numField('Bill amount (₹)', { placeholder: 'e.g. 2,450' });
  const tip = rateChips([0, 5, 10, 15, 20], kind === 'tip' ? 10 : 0, () => calc(), { customLabel: 'Tip (%)' });
  let people = kind === 'tip' ? 2 : 3;
  const ppl = stepper('People', people, 1, 100, v => { people = v; calc(); });
  let mode = 'equal';
  const shareRows = h('div', { class: 'stack' });
  const shares = [];
  const addShare = (name = '', w = '1') => {
    const n = field({ placeholder: `Person ${shares.length + 1}`, value: name });
    const s = field({ inputmode: 'decimal', value: w, placeholder: '1' });
    Object.assign(s.el.style, { flex: '0 0 76px' });
    const rm = button('×', () => { if (shares.length <= 2) return toast('Keep at least two people'); shares.splice(shares.indexOf(entry), 1); line.remove(); calc(); }, { variant: 'ghost', small: true });
    Object.assign(rm.style, { flex: 'none', width: '44px', minHeight: '44px', marginBottom: '1px' });
    const line = h('div', { style: { display: 'flex', gap: '8px', alignItems: 'flex-end' } }, h('div', { style: { flex: '1', minWidth: '0' } }, n.el), s.el, rm);
    const entry = { n, s };
    shares.push(entry); shareRows.append(line);
    listen([n, s], calc);
  };
  addShare('', '1'); addShare('', '1');
  const sharesCard = h('div', { class: 'stack hidden' },
    muted('Give each person a share — e.g. 2 for someone who ate twice as much, 0 to skip.'), shareRows,
    button('+ Add person', () => { addShare('', '1'); calc(); }, { variant: 'secondary', small: true }));
  const modeSeg = kind === 'billsplit' ? segmented([['equal', 'Equally'], ['shares', 'By shares']], mode, v => {
    mode = v; ppl.el.classList.toggle('hidden', v === 'shares'); sharesCard.classList.toggle('hidden', v !== 'shares'); calc();
  }) : null;
  remember(kind, { B });
  wordsUnder(B);
  const res = resultArea(kind === 'tip' ? 'Each person pays' : 'Who pays what');
  root.append(card({ title: 'Bill' }, B.el), card({ title: kind === 'tip' ? 'Tip' : 'Tip (optional)' }, tip.el),
    card({ title: 'Split' }, modeSeg, ppl.el, sharesCard), res.card);

  function calc() {
    const b = val(B), t = tip.value;
    if (!(b >= 0) || !B.value.trim()) { res.out.replaceChildren(muted('Enter the bill amount.')); return; }
    if (!(t >= 0) || t > 100) { res.out.replaceChildren(muted('Choose a tip between 0 and 100%.')); return; }
    if (mode === 'shares' && kind === 'billsplit') {
      const r = tipCalc(b, t, 1);
      const w = shares.map(x => (x.s.value.trim() === '' ? 0 : parseNum(x.s.value)));
      if (w.some(x => !(x >= 0))) { res.out.replaceChildren(muted('Shares must be numbers (0 or more).')); return; }
      const parts = splitByShares(Math.round(r.total * 100), w);
      if (!parts.some(Boolean)) { res.out.replaceChildren(muted('Give at least one person a share above 0.')); return; }
      res.out.replaceChildren(
        h('div', { class: 'stack', style: { gap: '0' } }, shares.map((x, i) => h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: '12px', padding: '10px 2px', borderBottom: '1px solid var(--line)' } },
          h('span', {}, x.n.value.trim() || `Person ${i + 1}`, h('span', { class: 'faint small' }, `  ·  ${fmtNum(w[i], 2)} share${w[i] === 1 ? '' : 's'}`)),
          h('b', { style: { fontVariantNumeric: 'tabular-nums' } }, money(parts[i] / 100, 'INR', 2))))),
        stats([['Bill', money(b, 'INR', 2)], ['Tip', money(r.tip, 'INR', 2)], ['Total', money(r.total, 'INR', 2)]]));
      return;
    }
    const r = tipCalc(b, t, people);
    const uneven = r.max !== r.per;
    res.out.replaceChildren(
      answer(money(uneven ? r.max : r.per, 'INR', 2), people === 1 ? 'Total to pay' : `per person · ${people} people`),
      uneven ? muted(`${r.parts.filter(p => p / 100 === r.max).length} ${r.parts.filter(p => p / 100 === r.max).length === 1 ? 'person pays' : 'people pay'} ${money(r.max, 'INR', 2)}, the rest pay ${money(r.per, 'INR', 2)} — so it adds up exactly.`) : null,
      stats([['Bill', money(b, 'INR', 2)], [`Tip ${fmtNum(t, 2)}%`, money(r.tip, 'INR', 2)], ['Total', money(r.total, 'INR', 2)]]));
  }
  listen([B], calc); calc();
}

// ── Unit converter ──────────────────────────────────────────────────
function mountConvert(root) {
  const cats = Object.keys(UNITS);
  const saved = store.get('calc:convert', {}) || {};
  let cat = UNITS[saved.cat] ? saved.cat : 'length';
  const pick = v => { cat = v; segA.setValue(v); segB.setValue(v); setUnits(true); calc(); };
  const segA = segmented(cats.slice(0, 4).map(c => [c, UNITS[c].label]), cat, pick);
  const segB = segmented(cats.slice(4).map(c => [c, UNITS[c].label]), cat, pick);
  const V = numField('Value', { value: saved.v ?? '1' });
  const F = field({ label: 'From', options: [] }), T = field({ label: 'To', options: [] });
  const swap = button('⇅', () => { const a = F.value; F.value = T.value; T.value = a; calc(); }, { variant: 'secondary' });
  Object.assign(swap.style, { flex: '0 0 52px', padding: '0', fontSize: '20px' });
  swap.setAttribute('aria-label', 'Swap units');
  const res = resultArea();
  const all = h('div');
  const defaults = { length: ['ft', 'm'], weight: ['kg', 'lb'], temperature: ['C', 'F'], area: ['ft2', 'm2'], volume: ['l', 'gal'], speed: ['kmh', 'mph'], data: ['GB', 'MB'], time: ['h', 'min'] };
  function setUnits(reset) {
    const opts = UNITS[cat].units.map(([id, label]) => h('option', { value: id }, `${label}${label.includes('(') || cat === 'time' ? '' : ` (${unitShort(cat, id)})`}`));
    F.input.replaceChildren(...opts); T.input.replaceChildren(...opts.map(o => o.cloneNode(true)));
    const d = defaults[cat];
    F.value = !reset && saved.cat === cat && saved.f ? saved.f : d[0];
    T.value = !reset && saved.cat === cat && saved.t ? saved.t : d[1];
    if (!F.value) F.value = d[0];
    if (!T.value) T.value = d[1];
  }
  setUnits(false);
  root.append(card({}, segA, segB, V.el,
    h('div', { style: { display: 'flex', gap: '8px', alignItems: 'flex-end' } }, h('div', { style: { flex: '1', minWidth: '0' } }, F.el), swap, h('div', { style: { flex: '1', minWidth: '0' } }, T.el))),
  res.card, all);
  function calc() {
    store.set('calc:convert', { cat, v: V.value, f: F.value, t: T.value });
    const v = val(V);
    all.replaceChildren();
    if (!Number.isFinite(v)) { res.out.replaceChildren(muted('Type a number to convert.')); return; }
    const r = convertUnit(cat, v, F.value, T.value);
    const one = convertUnit(cat, 1, F.value, T.value);
    res.out.replaceChildren(answer(`${fmtSmart(r)} ${unitShort(cat, T.value)}`, `${fmtSmart(v)} ${unitShort(cat, F.value)}`),
      cat === 'temperature' ? null : muted(`1 ${unitShort(cat, F.value)} = ${fmtSmart(one)} ${unitShort(cat, T.value)}`),
      cat === 'data' ? muted('Uses 1 KB = 1024 bytes, like phones and computers show storage.') : null);
    all.append(card({ title: `${fmtSmart(v)} ${unitShort(cat, F.value)} is also` },
      h('div', { class: 'stack', style: { gap: '0' } }, UNITS[cat].units.filter(u => u[0] !== F.value).map(([id, label]) =>
        h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: '12px', padding: '9px 2px', borderBottom: '1px solid var(--line)', fontSize: '14.5px' } },
          h('span', { class: 'muted' }, label), h('b', { style: { fontVariantNumeric: 'tabular-nums', textAlign: 'right', wordBreak: 'break-all' } }, `${fmtSmart(convertUnit(cat, v, F.value, id))} ${unitShort(cat, id)}`))))));
  }
  listen([V], calc); F.input.addEventListener('change', calc); T.input.addEventListener('change', calc); calc();
}

// ── Currency ────────────────────────────────────────────────────────
const FX_KEY = 'fx-rates';
const fxCache = () => { const c = store.get(FX_KEY, {}); return c && typeof c === 'object' ? c : {}; };
function fxSave(entry) {
  const c = fxCache(); c[entry.base] = { ...entry, ts: Date.now() };
  const keep = Object.values(c).sort((a, b) => b.ts - a.ts).slice(0, 6);
  store.set(FX_KEY, Object.fromEntries(keep.map(e => [e.base, e])));
}
async function fetchJSON(url, ms = 9000) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms);
  try { const r = await fetch(url, { signal: ctl.signal, cache: 'no-store' }); if (!r.ok) throw new Error('HTTP ' + r.status); return await r.json(); }
  finally { clearTimeout(t); }
}
async function fetchRates(base) {
  try { const e = parseRates(await fetchJSON(`https://open.er-api.com/v6/latest/${encodeURIComponent(base)}`), base, 'er'); if (e) return e; } catch { /* try fallback */ }
  try { const e = parseRates(await fetchJSON(`https://api.frankfurter.app/latest?from=${encodeURIComponent(base)}`), base, 'fr'); if (e) return e; } catch { /* give up */ }
  return null;
}

let displayNames = null;
try { displayNames = new Intl.DisplayNames(['en'], { type: 'currency' }); } catch { /* old browser */ }
const flagOf = code => (CURRENCIES.find(c => c[0] === code) || [])[2] || '💱';
const nameOf = code => (CURRENCIES.find(c => c[0] === code) || [])[1] || (displayNames && displayNames.of(code)) || code;

/** Searchable currency picker: a button that opens an inline filterable list. */
function currencyPicker(label, initial, extraCodes, onChange) {
  let value = initial;
  const face = h('span', { style: { display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0 } });
  const btn = h('button', { type: 'button', class: 'btn btn-ghost btn-full', style: { justifyContent: 'space-between', fontWeight: '600' } },
    face, h('span', { class: 'faint', 'aria-hidden': 'true' }, '▾'));
  const q = h('input', { type: 'search', placeholder: 'Search country or code…', autocomplete: 'off', spellcheck: 'false', enterkeyhint: 'search' });
  const list = h('div', { style: { maxHeight: '300px', overflowY: 'auto', WebkitOverflowScrolling: 'touch', borderRadius: '12px', border: '1px solid var(--line)' } });
  const panel = h('div', { class: 'field hidden', style: { marginTop: '8px' } }, q, list);
  const paint = () => face.replaceChildren(h('span', { style: { fontSize: '22px' } }, flagOf(value)), h('span', {}, value),
    h('span', { class: 'muted', style: { fontWeight: '500', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, nameOf(value)));
  const codes = () => { const base = CURRENCIES.map(c => c[0]); return base.concat([...extraCodes()].filter(c => !base.includes(c)).sort()); };
  const draw = () => {
    const s = q.value.trim().toLowerCase();
    const items = codes().filter(c => !s || c.toLowerCase().includes(s) || nameOf(c).toLowerCase().includes(s));
    list.replaceChildren(...items.slice(0, 200).map(c => h('button', {
      type: 'button', onclick: () => { value = c; paint(); close(); onChange(c); },
      style: { display: 'flex', alignItems: 'center', gap: '10px', width: '100%', minHeight: '48px', padding: '8px 12px', border: '0',
        borderBottom: '1px solid var(--line)', background: c === value ? 'var(--brand-soft)' : 'var(--surface)', textAlign: 'left', cursor: 'pointer' } },
      h('span', { style: { fontSize: '20px' } }, flagOf(c)), h('b', { style: { width: '44px' } }, c), h('span', { class: 'muted small' }, nameOf(c)))));
    if (!items.length) list.append(h('div', { class: 'empty', style: { padding: '18px' } }, 'No match'));
  };
  const close = () => { panel.classList.add('hidden'); q.value = ''; };
  btn.addEventListener('click', () => { const hidden = panel.classList.toggle('hidden'); if (!hidden) draw(); });
  q.addEventListener('input', draw);
  paint();
  return { el: h('div', { class: 'field' }, h('label', {}, label), btn, panel), get value() { return value; }, set value(v) { value = v; paint(); } };
}

function mountCurrency(root) {
  const saved = store.get('calc:currency', {}) || {};
  const A = numField('Amount', { value: saved.a ?? '1' });
  const known = () => { const s = new Set(); for (const e of Object.values(fxCache())) for (const k of Object.keys(e.rates || {})) s.add(k); return s; };
  const F = currencyPicker('From', /^[A-Z]{3}$/.test(saved.f) ? saved.f : 'USD', known, () => { save(); ensure(); calc(); });
  const T = currencyPicker('To', /^[A-Z]{3}$/.test(saved.t) ? saved.t : 'INR', known, () => { save(); ensure(); calc(); });
  const swap = button('⇅  Swap', () => { const a = F.value; F.value = T.value; T.value = a; save(); ensure(); calc(); }, { variant: 'secondary', small: true });
  const save = () => store.set('calc:currency', { a: A.value, f: F.value, t: T.value });
  const status = h('div');
  const res = resultArea();
  const refresh = button('Update rates', () => ensure(true), { variant: 'ghost', small: true });
  root.append(card({}, A.el, F.el, h('div', { style: { display: 'flex', justifyContent: 'center' } }, swap), T.el), res.card, status);
  A.input.addEventListener('input', () => { save(); calc(); });

  const tried = new Set();
  let loading = false;
  async function ensure(force = false) {
    const base = F.value;
    const have = fxCache()[base];
    const fresh = have && Date.now() - (have.ts || 0) < 60 * 60 * 1000;
    if ((!force && (fresh || tried.has(base))) || loading) return;
    if (!navigator.onLine) { calc(); return; }
    tried.add(base); loading = true; calc();
    try { const e = await fetchRates(base); if (e) fxSave(e); else if (force) toast('Couldn’t reach the rates service — showing saved rates', 'err'); }
    finally { loading = false; if (root.isConnected) calc(); }
  }

  function calc() {
    const a = val(A), from = F.value, to = T.value;
    const tbl = bestTable(fxCache(), from, to);
    status.replaceChildren();
    if (!tbl) {
      res.out.replaceChildren(loading ? h('div', { class: 'muted' }, 'Getting today’s rates…')
        : navigator.onLine ? notice('Couldn’t get rates right now. Check your connection and tap Update rates.', 'warn')
          : notice('You’re offline and no rates are saved yet. Open this once with internet — rates are then kept for offline use.', 'warn'));
      if (!loading && navigator.onLine) res.out.append(refresh);
      return;
    }
    const rate = crossRate(tbl, from, to);
    if (!Number.isFinite(a) || !A.value.trim()) { res.out.replaceChildren(muted('Enter an amount.')); }
    else {
      const out = a * rate;
      res.out.replaceChildren(answer(fxMoney(out, to), `${fxMoney(a, from)} ${from} → ${to}`),
        to === 'INR' && inWords(out) ? muted(inWords(out)) : null);
    }
    const updated = tbl.updated || tbl.ts;
    const when = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }).format(updated);
    const ageH = (Date.now() - (tbl.ts || 0)) / 3.6e6;
    const offline = !navigator.onLine;
    res.out.append(h('div', { class: 'small', style: { fontVariantNumeric: 'tabular-nums' } },
      `1 ${from} = ${fxRate(rate)} ${to}`, h('br'), h('span', { class: 'muted' }, `1 ${to} = ${fxRate(1 / rate)} ${from}`)));
    status.append(notice(offline ? `Rates from ${when} (offline).`
      : loading ? 'Updating rates…'
        : `Rates updated ${when} · ${tbl.source}${ageH > 24 ? ' — these may be out of date.' : ''}`, offline || ageH > 24 ? 'warn' : 'info'),
    h('p', { class: 'faint small', style: { margin: '10px 4px 0' } }, 'Mid-market rates for reference. Banks, cards and exchange counters add their own margin.'));
    if (!offline && !loading) status.append(h('div', { style: { marginTop: '10px' } }, refresh));
  }
  const onNet = () => { if (root.isConnected) { tried.clear(); ensure(); calc(); } };
  addEventListener('online', onNet); addEventListener('offline', onNet);
  addEventListener('hashchange', () => { removeEventListener('online', onNet); removeEventListener('offline', onNet); }, { once: true });
  calc(); ensure();
}

function fxMoney(n, cur) {
  if (!Number.isFinite(n)) return '—';
  try {
    const std = nf({ style: 'currency', currency: cur }).resolvedOptions().maximumFractionDigits;
    const a = Math.abs(n);
    const dp = a > 0 && a < 1 ? Math.max(std, Math.min(6, 1 - Math.floor(Math.log10(a)) + 1)) : std;
    return nf({ style: 'currency', currency: cur, minimumFractionDigits: Math.min(std, dp), maximumFractionDigits: dp }).format(n);
  } catch { return `${fmtNum(n, 2)} ${cur}`; }
}
function fxRate(r) {
  if (!Number.isFinite(r)) return '—';
  return nf({ maximumSignificantDigits: r >= 1000 ? 8 : 6 }).format(r);
}
