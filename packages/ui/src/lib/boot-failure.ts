import { activeLocale, type Locale } from './i18n.svelte';
import { retryOrReload } from './retry-load';

/**
 * What the page shows instead of the app when no catalogue could load
 * (`main.ts`): a first open that went offline, or a core that went away
 * mid-boot. The catalogues are what failed, so these sentences live here, once
 * per language of LOCALES, like the too-old-browser notice in index.html.
 */
const WORDS: Record<Locale, { message: string; retry: string }> = {
  en: { message: 'Boite could not load. Check the connection to this machine, then try again.', retry: 'Try again' },
  fr: { message: "Boite n'a pas pu se charger. Vérifiez la connexion à cette machine, puis réessayez.", retry: 'Réessayer' }
};

/**
 * Draws the notice in `target`. A click on its button, or the browser coming
 * back online, takes it down and boots again through `retryOrReload`: a fresh
 * page once the core answers, the notice again while it does not.
 */
export function showBootFailure(target: HTMLElement, retry: () => Promise<void>, reload?: () => void): void {
  const words = WORDS[activeLocale()];
  const note = document.createElement('div');
  note.className = 'boot-failure';
  note.setAttribute('role', 'alert');
  note.dataset.testid = 'boot-failure';
  const message = document.createElement('p');
  message.textContent = words.message;
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = words.retry;
  note.append(message, button);
  target.replaceChildren(note);

  const again = (): void => {
    window.removeEventListener('online', again);
    note.remove();
    void retryOrReload(retry, () => showBootFailure(target, retry, reload), reload);
  };
  button.addEventListener('click', again);
  window.addEventListener('online', again);
}
