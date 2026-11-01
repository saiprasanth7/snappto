import { CATEGORIES, CAT, TOOL, TOOLS, PASSPORT, PASSPORT_ITEMS, QUICK, search, botLink, BOT_USERNAME } from './catalog.js';
import { GUIDES, DISCLAIMER } from './guidance.js';
import { h, card, button, notice, toast, segmented, fmtBytes } from './ui.js';
import { OFFLINE_PACKS, vendorUrl } from './lib.js';
import * as store from './store.js';

export const VERSION = '1.0.0';
const view = document.getElementById('view');
const topbar = document.querySelector('.topbar');

// ── icons ───────────────────────────────────────────────────────────
const I = {
  back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg>',
  chev: '<svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5l7 7-7 7"/></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>',
  star: on => `<svg viewBox="0 0 24 24" width="24" height="24" fill="${on ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z"/></svg>`,
  share: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-3px"><path d="M12 15V3M8 7l4-4 4 4"/><path d="M5 12v7a2 2 0 002 2h10a2 2 0 002-2v-7"/></svg>',
};
const svg = s => { const d = document.createElement('span'); d.innerHTML = s; d.style.display = 'contents'; return d; };

// ── routing ─────────────────────────────────────────────────────────
const ROUTES = [
  [/^#\/?$/, home, 'home'],
  [/^#\/tools$/, toolsPage, 'tools'],
  [/^#\/cat\/([\w-]+)$/, categoryPage, 'tools'],
  [/^#\/tool\/([\w-]+)$/, toolPage, 'tools'],
  [/^#\/passport$/, passportPage, 'passport'],
  [/^#\/guide\/([\w-]+)$/, guidePage, 'passport'],
  [/^#\/search$/, searchPage, 'search'],
  [/^#\/more$/, morePage, 'more'],
  [/^#\/privacy$/, privacyPage, 'more'],
];
const ROOTS = new Set(['#/', '#', '', '#/tools', '#/passport', '#/search', '#/more']);
function parentOf(hash) {
  let m;
  if ((m = hash.match(/^#\/tool\/([\w-]+)$/))) return TOOL[m[1]] ? `#/cat/${TOOL[m[1]].cat}` : '#/tools';
  if (hash.startsWith('#/cat/')) return '#/tools';
  if (hash.startsWith('#/guide/')) return '#/passport';
  if (hash === '#/privacy') return '#/more';
  return '#/';
}
const stack = [];
let mountToken = 0;

async function render() {
  const hash = location.hash || '#/';
  if (stack.length >= 2 && stack[stack.length - 2] === hash) stack.pop();
  else if (stack[stack.length - 1] !== hash) stack.push(hash);

  const [, fn, tab] = ROUTES.find(([re]) => re.test(hash)) || ROUTES[0];
  const arg = (hash.match(ROUTES.find(([re]) => re.test(hash))?.[0] || /$^/) || [])[1];
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));

  const isRoot = ROOTS.has(hash);
  setTopbar({ back: !isRoot, title: '' });
  const token = ++mountToken;
  view.replaceChildren();
  view.classList.remove('view-enter'); void view.offsetWidth; view.classList.add('view-enter');
  window.scrollTo(0, 0);
  try { await fn(arg, () => token === mountToken); }
  catch (e) { console.error(e); view.replaceChildren(notice('Something went wrong loading this page. ' + (e.message || ''), 'err')); }
}

function setTopbar({ back, title, right }) {
  const inner = topbar.querySelector('.topbar-inner');
  const left = h('div', { class: 'side' });
  if (back) left.append(h('button', { class: 'back', 'aria-label': 'Back', onclick: goBack }, svg(I.back), 'Back'));
  const mid = h('div', { class: 'title' }, title || '');
  const r = h('div', { class: 'side' }, right || statusPill());
  inner.replaceChildren(left, mid, r);
}
function setTitle(t) { const el = topbar.querySelector('.title'); if (el) el.textContent = t; }
function setRight(node) { const s = topbar.querySelectorAll('.side')[1]; if (s) s.replaceChildren(node); }
function goBack() {
  if (stack.length >= 2) history.back();
  else location.replace(parentOf(location.hash || '#/'));
}
addEventListener('scroll', () => topbar.classList.toggle('scrolled', scrollY > 24), { passive: true });

// ── offline status ──────────────────────────────────────────────────
let offlineReady = false;
function statusPill() {
  if (!navigator.onLine) return h('span', { class: 'pill warn', title: 'No connection — on-device tools still work' }, h('span', { class: 'dot' }), 'Offline');
  if (offlineReady) return h('span', { class: 'pill ok', title: 'Installed for offline use' }, h('span', { class: 'dot' }), 'Offline-ready');
  return h('span', { class: 'pill' }, h('span', { class: 'dot' }), 'Online');
}
const refreshPill = () => { const s = topbar.querySelectorAll('.side')[1]; if (s && s.querySelector('.pill')) s.replaceChildren(statusPill()); };
addEventListener('online', refreshPill); addEventListener('offline', refreshPill);

// ── reusable list pieces ────────────────────────────────────────────
const WHERE = { device: ['Offline', 'device'], online: ['Online', 'online'], bot: ['Telegram', 'bot'], soon: ['Soon', 'online'] };
function toolItem(t) {
  const [lbl, cls] = WHERE[t.where] || WHERE.device;
  return h('a', { class: 'item', href: `#/tool/${t.id}` },
    h('span', { class: `ic hue-${t.cat}` }, t.emoji),
    h('span', { class: 'txt' }, h('div', { class: 't' }, t.label), h('div', { class: 'd' }, t.desc)),
    h('span', { class: `tag ${cls}` }, lbl), svg(I.chev));
}
function passportItem(p) {
  const href = p.id === 'pp_photo' ? '#/tool/passportphoto' : `#/guide/${p.id}`;
  return h('a', { class: 'item', href },
    h('span', { class: 'ic hue-passport' }, p.emoji),
    h('span', { class: 'txt' }, h('div', { class: 't' }, p.title), h('div', { class: 'd' }, p.desc)), svg(I.chev));
}
const label = t => h('div', { class: 'section-label' }, t);
const logoImg = () => h('img', { src: 'assets/logo-mark.svg', alt: '' });

// ── pages ───────────────────────────────────────────────────────────
function home() {
  const deviceCount = TOOLS.filter(t => t.where === 'device').length;
  view.append(
    h('div', { class: 'hero' },
      h('div', { class: 'brandrow' }, h('div', { class: 'logo' }, logoImg()),
        h('div', { class: 'wordmark' }, 'Snapp', h('b', {}, 'To'))),
      h('p', {}, 'Everything you need, right inside your phone. Even with no network.'),
      h('span', { class: 'pill' }, h('span', { class: 'dot' }), `${deviceCount} tools work offline · nothing uploaded`)),
    h('div', { class: 'duo' },
      h('a', { class: 'entry', href: '#/passport' }, h('div', { class: 'badge hue-passport' }, '🪪'),
        h('h3', {}, 'Passport Services'), h('span', {}, 'Photo, apply, renew, track & documents')),
      h('a', { class: 'entry', href: '#/tools' }, h('div', { class: 'badge hue-util' }, '🧰'),
        h('h3', {}, 'Tools'), h('span', {}, `${TOOLS.length} tools in 12 categories`))),
    installBanner(),
    label('Quick actions'),
    h('div', { class: 'chips' }, QUICK.map(id => TOOL[id]).filter(Boolean).map(t =>
      h('a', { class: 'chip', href: `#/tool/${t.id}` }, h('span', { class: 'e' }, t.emoji), t.label))),
  );
  const favs = store.favs().map(id => TOOL[id]).filter(Boolean);
  if (favs.length) view.append(label('Favorites'), h('div', { class: 'group' }, favs.map(toolItem)));
  const rec = store.recent().map(id => TOOL[id]).filter(Boolean).slice(0, 5);
  if (rec.length) view.append(label('Recent'), h('div', { class: 'group' }, rec.map(toolItem)));
  view.append(label('Also on Telegram'),
    h('a', { class: 'item group', href: `https://t.me/${BOT_USERNAME}`, target: '_blank', rel: 'noopener' },
      h('span', { class: 'ic', style: { background: '#2AABEE' } }, '✈️'),
      h('span', { class: 'txt' }, h('div', { class: 't' }, 'Open SnappTo in Telegram'),
        h('div', { class: 'd' }, 'PDF → Word, AI tools, video & more')), svg(I.chev)));
}

function toolsPage() {
  const off = TOOLS.filter(t => t.where === 'device').length;
  setTitle('Tools');
  view.append(h('h1', { class: 'large-title' }, 'Tools'),
    h('p', { class: 'subtitle' }, `${TOOLS.length} tools · ${off} work fully offline`),
    h('div', { class: 'tiles' }, CATEGORIES.map(c =>
      h('a', { class: 'tile', href: `#/cat/${c.id}` },
        h('div', { class: `icon hue-${c.id}` }, c.emoji),
        h('div', { class: 'name' }, c.title),
        h('div', { class: 'count' }, `${c.tools.length} tools`)))));
}

function categoryPage(id) {
  const c = CAT[id];
  if (!c) return void (location.hash = '#/tools');
  setTitle(c.title);
  const off = c.tools.filter(t => t.where === 'device').length;
  view.append(h('h1', { class: 'large-title' }, `${c.emoji} ${c.title}`),
    h('p', { class: 'subtitle' }, `${c.tools.length} tools${off ? ` · ${off} offline` : ''}`),
    h('div', { class: 'group' }, c.tools.map(t => toolItem({ ...t, cat: c.id, emoji: c.emoji }))));
}

async function toolPage(id, alive) {
  const t = TOOL[id];
  if (!t) return void (location.hash = '#/tools');
  setTitle(t.label);
  const fav = h('button', { class: 'back', 'aria-label': 'Favorite', style: { color: 'var(--accent)' } });
  const paint = () => { fav.innerHTML = I.star(store.isFav(id)); };
  fav.onclick = () => { const on = store.toggleFav(id); paint(); toast(on ? 'Added to Favorites' : 'Removed from Favorites'); };
  paint(); setRight(fav);
  store.pushRecent(id);
  view.append(h('h1', { class: 'large-title' }, t.label), h('p', { class: 'subtitle' }, t.desc));

  if (t.where === 'bot' || !t.module) {
    view.append(card({ title: 'Runs in the SnappTo Telegram bot' },
      h('p', { class: 'muted', style: { margin: 0 } },
        'This tool needs heavy server software that can’t run inside a phone browser. The free SnappTo bot does it for you — tap below and send your file there.'),
      h('a', { class: 'btn btn-primary btn-full', href: botLink(id), target: '_blank', rel: 'noopener' }, '✈️  Open in Telegram'),
      notice('Needs internet. Your file is processed and then deleted from the server within about a minute.', 'info')));
    return;
  }
  const root = h('div', { class: 'tool-root' });
  const loading = h('div', { class: 'empty' }, h('div', { class: 'e' }, '⏳'), 'Loading tool…');
  view.append(root); root.append(loading);
  try {
    const mod = await import(`./tools/${t.module}`);
    if (!alive()) return;
    loading.remove();
    await mod.mount(root, id, t);
  } catch (e) {
    console.error(e);
    if (!alive()) return;
    root.replaceChildren(notice(navigator.onLine
      ? `This tool failed to load: ${e.message || e}`
      : 'This tool isn’t downloaded for offline use yet. Open it once while online.', 'err'));
  }
}

function passportPage() {
  setTitle('Passport');
  view.append(h('h1', { class: 'large-title' }, 'Passport Services'),
    h('p', { class: 'subtitle' }, 'India · step-by-step guidance and official links'));
  for (const s of PASSPORT) {
    view.append(label(s.title), h('div', { class: 'group' },
      s.items.map(([id, emoji, title, desc]) => passportItem({ id, emoji, title, desc }))));
  }
  view.append(h('p', { class: 'faint small', style: { margin: '18px 6px' } }, DISCLAIMER));
}

function guidePage(id) {
  const g = GUIDES[id];
  if (!g) return void (location.hash = '#/passport');
  setTitle(g.title);
  const p = PASSPORT_ITEMS.find(x => x.id === id);
  view.append(h('h1', { class: 'large-title' }, `${p ? p.emoji + ' ' : ''}${g.title}`),
    h('div', { class: 'card prose', html: g.body }),
    notice(DISCLAIMER, 'warn'));
  if (['new_passport', 'renew', 'minor', 'tatkaal', 'senior'].includes(id)) {
    view.append(h('div', { style: { marginTop: '14px' } },
      h('a', { class: 'btn btn-accent btn-full', href: '#/tool/passportphoto' }, '🪪  Make your passport photo')));
  }
}

function searchPage() {
  setTitle('Search');
  view.append(h('h1', { class: 'large-title' }, 'Search'));
  const results = h('div');
  const input = h('input', { type: 'search', placeholder: 'Try “compress pdf”, “passport”, “emi”…', autocomplete: 'off', enterkeyhint: 'search' });
  const draw = () => {
    const r = search(input.value);
    if (!input.value.trim()) {
      results.replaceChildren(label('Popular'), h('div', { class: 'group' }, QUICK.map(id => TOOL[id]).filter(Boolean).map(toolItem)));
      return;
    }
    if (!r.length) { results.replaceChildren(h('div', { class: 'empty' }, h('div', { class: 'e' }, '🔍'), 'No matches. Try a simpler word like “pdf” or “photo”.')); return; }
    results.replaceChildren(h('div', { class: 'group' }, r.map(x => x.kind === 'tool' ? toolItem(x.item) : passportItem(x.item))));
  };
  input.addEventListener('input', draw);
  view.append(h('label', { class: 'search' }, svg(I.search), input), results);
  draw();
  setTimeout(() => input.focus(), 60);
}

async function morePage() {
  setTitle('More');
  view.append(h('h1', { class: 'large-title' }, 'More'));

  // Offline packs
  const packList = h('div', { class: 'group' });
  view.append(label('Use offline'), packList,
    h('p', { class: 'faint small', style: { margin: '8px 6px 0' } },
      'The app itself is saved for offline use automatically. Download these extras so text recognition and background removal also work with no network.'));
  for (const [key, pack] of Object.entries(OFFLINE_PACKS)) {
    const state = h('span', { class: 'tag online' }, '…');
    const btn = button('Download', null, { variant: 'secondary', small: true });
    btn.style.flex = 'none';
    const it = h('div', { class: 'item' },
      h('span', { class: 'ic hue-soft', style: { color: 'var(--brand)' } }, key.startsWith('ocr') ? '🔤' : '🙂'),
      h('span', { class: 'txt' }, h('div', { class: 't' }, pack.label), h('div', { class: 'd' }, '')), state, btn);
    packList.append(it);
    const setState = async () => {
      const ok = await packCached(pack);
      state.className = 'tag ' + (ok ? 'device' : 'online'); state.textContent = ok ? 'Saved' : 'Not saved';
      btn.classList.toggle('hidden', ok);
    };
    btn.onclick = async () => {
      if (!navigator.onLine) return toast('Connect to the internet to download', 'err');
      btn.disabled = true; const d = it.querySelector('.d');
      let done = 0;
      try {
        for (const f of pack.files) { await fetch(vendorUrl(f), { cache: 'reload' }); d.textContent = `${++done}/${pack.files.length} files`; }
        await setState(); d.textContent = 'Ready offline'; toast('Saved for offline use', 'ok');
      } catch { d.textContent = 'Download failed — try again'; }
      btn.disabled = false;
    };
    setState();
  }

  // Appearance
  const cur = store.get('theme', 'auto');
  view.append(label('Appearance'), h('div', { class: 'card' },
    segmented([['auto', 'Automatic'], ['light', 'Light'], ['dark', 'Dark']], cur, v => { store.set('theme', v); applyTheme(); })));

  view.append(label('SnappTo'), h('div', { class: 'group' },
    h('a', { class: 'item', href: `https://t.me/${BOT_USERNAME}`, target: '_blank', rel: 'noopener' },
      h('span', { class: 'ic', style: { background: '#2AABEE' } }, '✈️'),
      h('span', { class: 'txt' }, h('div', { class: 't' }, 'Telegram bot'), h('div', { class: 'd' }, '@' + BOT_USERNAME)), svg(I.chev)),
    h('a', { class: 'item', href: '#/privacy' },
      h('span', { class: 'ic hue-sign' }, '🔒'),
      h('span', { class: 'txt' }, h('div', { class: 't' }, 'Privacy'), h('div', { class: 'd' }, 'Your files never leave your phone')), svg(I.chev)),
    h('button', { class: 'item', onclick: () => { store.set('recent', []); store.set('favs', []); toast('Cleared', 'ok'); } },
      h('span', { class: 'ic', style: { background: '#94A3B8' } }, '🧹'),
      h('span', { class: 'txt' }, h('div', { class: 't' }, 'Clear favorites & recent'), h('div', { class: 'd' }, 'Stored only on this device')))));
  const usage = navigator.storage?.estimate ? await navigator.storage.estimate().catch(() => null) : null;
  view.append(h('p', { class: 'faint small', style: { margin: '18px 6px', textAlign: 'center' } },
    `SnappTo ${VERSION}${usage ? ` · ${fmtBytes(usage.usage)} saved on this device` : ''}`, h('br'),
    'Built with open-source libraries: pdf-lib, PDF.js, Tesseract.js, MediaPipe, jsQR, JsBarcode, fflate.'));
}

async function packCached(pack) {
  if (!('caches' in window)) return false;
  for (const f of pack.files) { if (!(await caches.match(vendorUrl(f)))) return false; }
  return true;
}

function privacyPage() {
  setTitle('Privacy');
  view.append(h('h1', { class: 'large-title' }, 'Privacy'), h('div', { class: 'card prose', html: `
    <p><b>Your files stay on your phone.</b> Every tool marked <b>Offline</b> runs entirely inside your browser. Photos, PDFs, signatures and documents are never uploaded to any server.</p>
    <p><b>No accounts, no tracking.</b> SnappTo has no sign-in, no analytics and no ads. Favorites, recent tools and your theme choice are saved only in this browser’s local storage, and you can clear them any time from More.</p>
    <p><b>Internet use.</b> The currency converter fetches public exchange rates. Tools marked <b>Telegram</b> open the SnappTo Telegram bot; files you send there are processed on our server and deleted about a minute later.</p>
    <p><b>Passport guidance</b> is general information with links to official government portals. SnappTo is not a government service and cannot approve, speed up or submit applications.</p>
    <p class="faint">Last updated October 2026.</p>` }));
}

// ── install prompt ──────────────────────────────────────────────────
let deferredInstall = null;
addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferredInstall = e; if ((location.hash || '#/') === '#/') render(); });
const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = () => /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
function installBanner() {
  // '' not null: native Element.append() would print the text "null".
  if (standalone() || store.get('installDismissed', false)) return '';
  if (!deferredInstall && !isIOS()) return '';
  const close = h('button', { class: 'x', 'aria-label': 'Dismiss', onclick: () => { store.set('installDismissed', true); el.remove(); } }, '×');
  const body = isIOS()
    ? h('div', { class: 'it' }, h('b', {}, 'Install SnappTo'), 'Tap ', svg(I.share), ' Share, then “Add to Home Screen” — it then works with no network.')
    : h('div', { class: 'it' }, h('b', {}, 'Install SnappTo'), 'Add it to your home screen to use it offline like an app.');
  const el = h('div', { class: 'install' }, h('div', { class: 'ii' }, h('img', { src: 'assets/icon-192.png', alt: '' })), body,
    !isIOS() && button('Install', async () => { deferredInstall.prompt(); await deferredInstall.userChoice; deferredInstall = null; el.remove(); }, { small: true }),
    close);
  return el;
}

// ── theme ───────────────────────────────────────────────────────────
function applyTheme() {
  const t = store.get('theme', 'auto');
  if (t === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
  const dark = t === 'dark' || (t === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.querySelector('meta[name=theme-color]')?.setAttribute('content', dark ? '#0B0A10' : '#F4F3F9');
}

// ── service worker ──────────────────────────────────────────────────
async function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.register('./sw.js');
    const ready = () => { offlineReady = true; refreshPill(); };
    if (navigator.serviceWorker.controller) ready();
    navigator.serviceWorker.addEventListener('controllerchange', ready);
    navigator.serviceWorker.addEventListener('message', e => { if (e.data === 'precached') ready(); });
    reg.addEventListener('updatefound', () => {
      const nw = reg.installing;
      nw && nw.addEventListener('statechange', () => {
        if (nw.state === 'installed' && navigator.serviceWorker.controller) toast('SnappTo updated — reopen to use the new version', 'ok');
      });
    });
  } catch (e) { console.warn('SW registration failed', e); }
}

applyTheme();
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', applyTheme);
addEventListener('hashchange', render);
render();
registerSW();
