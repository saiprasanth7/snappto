// Passport / ID photo presets, ported 1:1 from the Telegram bot engine:
//   engine/passport_photo.py  INDIA_PRESETS
//   engine/photo_specs.py     COUNTRY_PRESETS  (mm sizes rendered at 300 dpi: px = round(mm / 25.4 * 300))
//
// Fields: w, h (pixels), max_kb (file-size cap), head_frac (head height / photo height,
// used for framing), sheet (true = offer a 300 dpi print sheet).
// COMMUNITY PRESETS: sizes follow widely published spec tables, but portals change
// rules. The UI always tells people to verify on the official source.
// Do not add or "correct" specs here without updating the bot engine too.

export const PRINT_DPI = 300;

/** mm → px at 300 dpi, exactly like photo_specs._mm (no .5 ties occur in this table). */
export const mmToPx = mm => Math.round(mm / 25.4 * PRINT_DPI);

const P = (label, w, h, max_kb, head_frac, sheet, extra = {}) => ({ label, w, h, max_kb, head_frac, sheet, ...extra });

// ── India (INDIA_PRESETS) ─────────────────────────────────────────────
export const INDIA_PRESETS = {
  seva:     P('🇮🇳 Passport Seva upload (630×810, ≤240 KB)', 630, 810, 240, 0.68, false),
  print2x2: P('🇮🇳 2×2 inch print (Indian passport)', 600, 600, 900, 0.62, true),
  std3545:  P('🌍 35×45 mm (visa / most forms)', 413, 531, 300, 0.70, true),
  exam:     P('📝 Exam portal (200×230, ≤50 KB)', 200, 230, 50, 0.70, false),
};

// ── Other countries (COUNTRY_PRESETS) ────────────────────────────────
// _spec(label, w_mm, h_mm, px=None, max_kb=400, head_frac=0.70, sheet=True)
const C = (label, wmm, hmm, { max_kb = 400, head_frac = 0.70, sheet = true } = {}) =>
  P(label, mmToPx(wmm), mmToPx(hmm), max_kb, head_frac, sheet, { mm: [wmm, hmm] });

export const COUNTRY_PRESETS = {
  // Gulf
  uae:         C('🇦🇪 UAE (43×55 mm)', 43, 55),
  saudi:       C('🇸🇦 Saudi Arabia (40×60 mm)', 40, 60),
  qatar:       C('🇶🇦 Qatar (38×48 mm)', 38, 48),
  kuwait:      C('🇰🇼 Kuwait (44×54 mm)', 44, 54),
  oman:        C('🇴🇲 Oman (40×60 mm)', 40, 60),
  bahrain:     C('🇧🇭 Bahrain (40×60 mm)', 40, 60),
  // Americas
  usa:         C('🇺🇸 USA passport (2×2 in)', 50.8, 50.8, { head_frac: 0.62 }),
  usvisa:      P('🇺🇸 US visa digital (600×600)', 600, 600, 240, 0.62, false),
  canada:      C('🇨🇦 Canada (50×70 mm)', 50, 70, { head_frac: 0.62 }),
  brazil:      C('🇧🇷 Brazil (50×70 mm)', 50, 70),
  // Europe
  uk:          C('🇬🇧 UK (35×45 mm)', 35, 45),
  schengen:    C('🇪🇺 Schengen/EU visa (35×45 mm)', 35, 45),
  russia:      C('🇷🇺 Russia (35×45 mm)', 35, 45),
  // Asia-Pacific (+ South Africa, as in the bot)
  australia:   C('🇦🇺 Australia (35×45 mm)', 35, 45),
  nz:          C('🇳🇿 New Zealand (35×45 mm)', 35, 45),
  singapore:   C('🇸🇬 Singapore (35×45 mm)', 35, 45),
  malaysia:    C('🇲🇾 Malaysia (35×50 mm)', 35, 50),
  japan:       C('🇯🇵 Japan (35×45 mm)', 35, 45),
  korea:       C('🇰🇷 South Korea (35×45 mm)', 35, 45),
  china:       C('🇨🇳 China (33×48 mm)', 33, 48),
  srilanka:    C('🇱🇰 Sri Lanka (35×45 mm)', 35, 45),
  nepal:       C('🇳🇵 Nepal (35×45 mm)', 35, 45),
  pakistan:    C('🇵🇰 Pakistan (35×45 mm)', 35, 45),
  philippines: C('🇵🇭 Philippines (35×45 mm)', 35, 45),
  southafrica: C('🇿🇦 South Africa (35×45 mm)', 35, 45),
};

/** Every preset by key (India first, then countries — same order as the bot menus). */
export const PRESETS = Object.fromEntries(
  Object.entries({ ...INDIA_PRESETS, ...COUNTRY_PRESETS }).map(([key, p]) => [key, { key, ...p }]));

/** Picker groups (India first, then countries by region, as in photo_specs.py). */
export const PRESET_GROUPS = [
  { label: '🇮🇳 India', keys: Object.keys(INDIA_PRESETS) },
  { label: 'Gulf', keys: ['uae', 'saudi', 'qatar', 'kuwait', 'oman', 'bahrain'] },
  { label: 'Americas', keys: ['usa', 'usvisa', 'canada', 'brazil'] },
  { label: 'Europe', keys: ['uk', 'schengen', 'russia'] },
  { label: 'Asia-Pacific & Africa', keys: ['australia', 'nz', 'singapore', 'malaysia', 'japan', 'korea',
    'china', 'srilanka', 'nepal', 'pakistan', 'philippines', 'southafrica'] },
];

export const DEFAULT_PRESET = 'seva';
export const EXAM_PRESET = 'exam';

/** Framing used for a "Custom size" exam photo (same as the exam preset; not an official spec). */
export const CUSTOM_DEFAULTS = { w: 200, h: 230, max_kb: 50, head_frac: 0.70 };
export const CUSTOM_LIMITS = { minPx: 100, maxPx: 2400, minKb: 5, maxKb: 2000 };

/** Validate a custom exam size. Returns {ok, preset?, error?}. */
export function customPreset(w, h, kb) {
  const W = Math.round(Number(w)), H = Math.round(Number(h)), K = Math.round(Number(kb));
  const L = CUSTOM_LIMITS;
  if (!Number.isFinite(W) || !Number.isFinite(H) || W < L.minPx || H < L.minPx || W > L.maxPx || H > L.maxPx)
    return { ok: false, error: `Width and height must be between ${L.minPx} and ${L.maxPx} pixels.` };
  if (!Number.isFinite(K) || K < L.minKb || K > L.maxKb)
    return { ok: false, error: `Max size must be between ${L.minKb} and ${L.maxKb} KB.` };
  return {
    ok: true,
    preset: { key: 'custom', label: `Custom size (${W}×${H}, ≤${K} KB)`, w: W, h: H, max_kb: K,
      head_frac: CUSTOM_DEFAULTS.head_frac, sheet: false },
  };
}

/** One-line human summary of a preset, e.g. "413 × 531 px · up to 300 KB · print sheet". */
export function specLine(p) {
  const parts = [`${p.w} × ${p.h} px`, `up to ${p.max_kb} KB`];
  if (p.sheet) parts.push(`prints at ${physical(p)}`);
  else parts.push('for online upload');
  return parts.join(' · ');
}
/** Printed size at 300 dpi: "2 × 2 in" for whole inches, else "35 × 45 mm". */
export function physical(p) {
  if (p.w % PRINT_DPI === 0 && p.h % PRINT_DPI === 0) return `${p.w / PRINT_DPI} × ${p.h / PRINT_DPI} in`;
  return `${fmtMm(p.w)} × ${fmtMm(p.h)} mm`;
}
const fmtMm = px => {
  const mm = px / PRINT_DPI * 25.4;
  return Math.abs(mm - Math.round(mm)) < 0.06 ? String(Math.round(mm)) : mm.toFixed(1);
};
