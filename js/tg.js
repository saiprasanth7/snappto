// Telegram Mini App support. Opened from the bot's menu button, Telegram puts its launch
// data in the URL hash (#tgWebAppData=…&tgWebAppPlatform=…), which is not an app route.
// This module runs before the router: it reads that once, remembers it for this tab, and
// leaves a clean '#/'. It talks to Telegram through the raw web-events bridge, so the app
// loads no script from telegram.org and still starts with no network.
const KEY = 'snappto:tg';

function detect() {
  const hp = new URLSearchParams(location.hash.slice(1));
  const qp = new URLSearchParams(location.search);
  if (hp.has('tgWebAppData') || hp.has('tgWebAppPlatform') || qp.has('tgWebAppStartParam')) {
    const platform = hp.get('tgWebAppPlatform') || 'unknown';
    try { sessionStorage.setItem(KEY, platform); } catch { /* private mode */ }
    history.replaceState(null, '', location.pathname + location.search + '#/');
    return platform;
  }
  try { return sessionStorage.getItem(KEY); } catch { return null; }
}

export const tgPlatform = detect();
// Only the launch data counts: Telegram's in-app browser for ordinary links also has the
// bridge object, and there these events would go nowhere.
export const inTelegram = !!tgPlatform;

/** Send one event to the Telegram client. False when there is no Telegram around. */
export function tgPost(type, data = {}) {
  if (!inTelegram) return false;
  try {
    if (window.TelegramWebviewProxy?.postEvent) {             // iOS and Android apps
      window.TelegramWebviewProxy.postEvent(type, JSON.stringify(data));
      return true;
    }
    if (window.parent !== window) {                            // Telegram Web and Desktop (iframe)
      window.parent.postMessage(JSON.stringify({ eventType: type, eventData: data }), '*');
      return true;
    }
  } catch { /* fall through to the browser's own handling */ }
  return false;
}

/** This page, without Telegram's data, as a link for the phone's own browser. */
export const pageUrl = () => location.origin + location.pathname + (location.hash || '#/');

/** Open a link outside the Mini App: t.me links inside Telegram, the rest in the browser. */
export function openOutside(url) {
  const u = new URL(url, location.href);
  if (u.hostname === 't.me' && tgPost('web_app_open_tg_link', { path_full: u.pathname + u.search })) return;
  if (tgPost('web_app_open_link', { url: u.href })) return;
  window.open(u.href, '_blank', 'noopener');
}

if (inTelegram) {
  tgPost('web_app_ready');
  tgPost('web_app_expand');
  // Inside Telegram's view a plain link would load in place of the app (or do nothing on
  // iOS), so send every link that leaves the app to Telegram to open.
  addEventListener('click', e => {
    const a = e.target.closest?.('a[href]');
    if (!a || a.hasAttribute('download') || e.defaultPrevented) return;
    const u = new URL(a.getAttribute('href'), location.href);
    if (!/^https?:$/.test(u.protocol) || u.origin === location.origin) return;
    e.preventDefault();
    openOutside(u.href);
  }, true);
}
