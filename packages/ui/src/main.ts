import { mount } from 'svelte';
import App from './App.svelte';
import QuotaApp from './QuotaApp.svelte';
import './app.css';
import { registerServiceWorker } from './lib/sw';
import { startLocale } from './lib/i18n.svelte';

const target = document.getElementById('app');
if (!target) throw new Error('index.html is missing the #app element');

// The language before the first frame, so nothing is drawn in English and
// swapped a tick later, and `<html lang>` is right for the first paint.
startLocale();
registerServiceWorker();

const quotas = new URLSearchParams(location.search).get('view') === 'quotas';
const app = mount(quotas ? QuotaApp : App, { target });
export default app;

// The shell builds its window hidden and shows it once this page has painted,
// so a slow core start shows the page's own "Starting" instead of nothing and
// a fast one never flashes an empty frame. Two frames: the first is when the
// mount is laid out, the second when it has reached the screen.
if (!quotas && window.__TAURI_INTERNALS__ !== undefined) {
  requestAnimationFrame(() => requestAnimationFrame(() => {
    void import('@tauri-apps/api/core').then(({ invoke }) => invoke('shell_ready')).catch(() => {
      // An older shell without the command shows its window on its own.
    });
  }));
}
