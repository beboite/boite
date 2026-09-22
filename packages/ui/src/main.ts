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

export default mount(new URLSearchParams(location.search).get('view') === 'quotas' ? QuotaApp : App, { target });
