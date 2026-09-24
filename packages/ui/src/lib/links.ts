/**
 * External links leave the app. In the shell WebView2 does nothing with
 * `target="_blank"`, so the click is caught here and the url is handed to the
 * system browser through the opener plugin. In a browser the same click keeps
 * the normal `window.open`, which is what the PWA already did.
 *
 * The markup keeps its `href`, its `target` and its `rel`: a right click still
 * copies the address, and nothing changes for a page rendered outside the shell.
 */

function insideTauri(): boolean {
  return window.__TAURI_INTERNALS__ !== undefined;
}

/** Opens a url where the user expects it: the system browser, never this window. */
export async function openExternal(url: string): Promise<void> {
  if (insideTauri()) {
    const { openUrl } = await import('@tauri-apps/plugin-opener');
    await openUrl(url);
    return;
  }
  window.open(url, '_blank', 'noopener,noreferrer');
}

/**
 * Shows a file in the system file manager, selected. Only the shell on its own
 * core can: the path is on this computer, and the opener plugin allows this
 * one command. Nothing is opened or run, so a file an agent wrote cannot
 * execute through here.
 */
export async function revealFile(path: string): Promise<void> {
  if (!insideTauri()) throw new Error('showing a file in its folder needs the desktop app');
  const { revealItemInDir } = await import('@tauri-apps/plugin-opener');
  await revealItemInDir(path);
}

/**
 * One capture-phase listener on the app root for every `http(s)` link the UI
 * shows, the markdown answers and the account login link included. A modified
 * click (ctrl, shift, meta or the middle button) is left to the browser, and so
 * is a link that points back at this same origin.
 */
export function installExternalLinks(root: HTMLElement): () => void {
  const onclick = (event: MouseEvent): void => {
    if (event.defaultPrevented) return;
    if (event.button !== 0 || (!insideTauri() && (event.ctrlKey || event.shiftKey || event.metaKey))) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    const anchor = target.closest('a[href]');
    if (!(anchor instanceof HTMLAnchorElement)) return;

    const href = anchor.getAttribute('href') ?? '';
    if (!/^https?:\/\//i.test(href) && !/^mailto:/i.test(href)) return;
    let origin: string;
    try {
      origin = new URL(href).origin;
    } catch {
      return;
    }
    if (origin === window.location.origin && !insideTauri()) return;

    event.preventDefault();
    void openExternal(href);
  };

  root.addEventListener('click', onclick, true);
  return () => root.removeEventListener('click', onclick, true);
}
