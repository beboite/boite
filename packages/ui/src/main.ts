import { mount } from 'svelte';
import App from './App.svelte';
import './app.css';
import { registerServiceWorker } from './lib/sw';

const target = document.getElementById('app');
if (!target) throw new Error('index.html is missing the #app element');

registerServiceWorker();

export default mount(App, { target });
