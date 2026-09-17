import { strings } from './i18n.svelte';
interface InstallPrompt extends Event { prompt(): Promise<{ outcome: string }> }
let prompt: InstallPrompt | null = null;
export function listenForInstall(): () => void {
  const before = (event: Event) => { event.preventDefault(); prompt = event as InstallPrompt; };
  window.addEventListener('beforeinstallprompt', before);
  return () => { window.removeEventListener('beforeinstallprompt', before); prompt = null; };
}
export async function installApp(): Promise<boolean> {
  if (!prompt) return false;
  const current = prompt;
  prompt = null;
  return (await current.prompt()).outcome === 'accepted';
}
export function installed(): boolean {
  return window.matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}
export const PUSH_ENABLED_KEY = 'boite.web-push';

export async function worker(): Promise<ServiceWorkerRegistration> {
  const registration = await navigator.serviceWorker.getRegistration('/');
  if (!registration?.active) throw new Error(strings.phone.preparing);
  return registration;
}
