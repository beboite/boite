import { mount } from 'svelte';
import App from './App.svelte';
import './app.css';
import { registerServiceWorker } from './lib/sw';
import { startLocale } from './lib/i18n.svelte';
import { applyChatWidth, readChatWidth } from './lib/chat-width';
import { startZoom } from './lib/zoom';

// Every import above parsed and ran: index.html's too-old-browser notice stands down.
(window as { __boiteBooted?: boolean }).__boiteBooted = true;

const target = document.getElementById('app');
if (!target) throw new Error('index.html is missing the #app element');

registerServiceWorker();
// The stored column width, before the first frame lays the chat out.
applyChatWidth(readChatWidth());

const view = new URLSearchParams(location.search).get('view');
const quotas = view === 'quotas';
// The desktop companion is a webview of its own too, transparent and small.
const companion = view === 'companion';
const popup = quotas || companion;

// The stored interface zoom, asked of the shell beside the language: the
// window stays hidden until both have landed, so it never shows at 100 % and
// jumps. The quota popup is its own webview and keeps its size.
const zoomed = popup ? Promise.resolve() : startZoom();

// The language before the first frame, so nothing is drawn in English and
// swapped a tick later, and `<html lang>` is right for the first paint. A
// language other than English is its own chunk, which index.html preloaded.
// A promise chain rather than a top-level await: with one, Rolldown split the
// entry into twice as many startup files. The quota window and the companion
// are chunks of their own.
void startLocale()
  .then(async () => mount(
    quotas ? (await import('./QuotaApp.svelte')).default
      : companion ? (await import('./CompanionApp.svelte')).default
      : App,
    { target },
  ))
  .then(async () => {
    // The shell builds its window hidden and shows it once this page has painted,
    // so a slow core start shows the page's own "Starting" instead of nothing and
    // a fast one never flashes an empty frame. Two frames: the first is when the
    // mount is laid out, the second when it has reached the screen.
    if (popup || window.__TAURI_INTERNALS__ === undefined) return;
    await zoomed;
    let sent = false;
    const ready = () => {
      if (sent) return;
      sent = true;
      void import('@tauri-apps/api/core').then(({ invoke }) => invoke('shell_ready')).catch(() => {
        // An older shell without the command shows its window on its own.
      });
    };
    // WebView2 keeps painting in a hidden window. WebKit, on macOS and Linux,
    // runs no frame callback for a window that is not on screen, so waiting on
    // one held the window back until the shell's ten-second fallback.
    if (document.visibilityState === 'hidden') ready();
    else if (!navigator.userAgent.includes('Windows')) setTimeout(ready, 100);
    requestAnimationFrame(() => requestAnimationFrame(ready));
  });
