import { REMOTE_URL_MAX, type RemoteBrowserFrame } from '@boite/contracts';
import { refused } from '../errors.ts';
import { PAGE_INFO_SCRIPT } from './scripts.ts';

/** What a viewer's frame says about the page it shows; input aimed at it is checked against the page now. */
export interface PageInfo { width: number; height: number; title: string; href: string; origin: number; dpr: number }

interface FramePage {
  evaluate(script: string, timeoutMs: number): Promise<unknown>;
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
}

/**
 * One JPEG of a tab for a viewer, no wider than `maxWidth` device pixels.
 *
 * A scaled clip makes Chrome set the page's size for the shot and restore the
 * size it found afterwards, so a preset or resize applied while a capture runs
 * is undone when it finishes. The caller runs captures and size changes of a
 * tab in turn (`AgentBrowser.#screen`).
 */
export async function captureFrame(tabId: string, page: FramePage, maxWidth: number | undefined, quality: number): Promise<{ frame: RemoteBrowserFrame; page: PageInfo }> {
  const info = await page.evaluate(PAGE_INFO_SCRIPT, 5000) as PageInfo;
  const dpr = info.dpr > 0 ? info.dpr : 1;
  const scale = maxWidth && info.width * dpr > maxWidth ? maxWidth / (info.width * dpr) : 1;
  // Headless, a scaled clip shows nobody a flash: the frame is shrunk by the browser itself.
  const metrics = scale < 1 ? await page.send('Page.getLayoutMetrics') as { cssVisualViewport: { pageX: number; pageY: number; clientWidth: number; clientHeight: number } } : null;
  const view = metrics?.cssVisualViewport;
  const shot = await page.send('Page.captureScreenshot', {
    format: 'jpeg', quality, captureBeyondViewport: false,
    ...(view ? { clip: { x: view.pageX, y: view.pageY, width: view.clientWidth, height: view.clientHeight, scale: scale * dpr } } : {}),
  }) as { data?: string };
  if (typeof shot.data !== 'string') throw refused('the browser returned no frame');
  const frame: RemoteBrowserFrame = { id: crypto.randomUUID(), tabId, title: String(info.title ?? '').slice(0, 200), width: info.width, height: info.height, base64: shot.data, at: Date.now(), url: String(info.href ?? '').slice(0, REMOTE_URL_MAX) };
  return { frame, page: info };
}
