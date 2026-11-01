// Tiny localStorage wrapper. Every access is guarded: private mode, cleared
// storage or blocked site data must never break the app.
const K = 'snappto:';
export function get(key, dflt) {
  try { const v = localStorage.getItem(K + key); return v == null ? dflt : JSON.parse(v); } catch { return dflt; }
}
export function set(key, val) { try { localStorage.setItem(K + key, JSON.stringify(val)); } catch { /* ignore */ } }

export const recent = () => get('recent', []);
export function pushRecent(id) { const r = recent().filter(x => x !== id); r.unshift(id); set('recent', r.slice(0, 8)); }
export const favs = () => get('favs', []);
export const isFav = id => favs().includes(id);
export function toggleFav(id) { const f = favs(); const i = f.indexOf(id); i >= 0 ? f.splice(i, 1) : f.unshift(id); set('favs', f); return i < 0; }
