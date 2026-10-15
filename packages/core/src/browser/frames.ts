import { REMOTE_URL_MAX, type RemoteBrowserFrame } from '@boite/contracts';
import { refused } from '../errors.ts';
import { PAGE_INFO_SCRIPT } from './scripts.ts';

/** What a viewer's frame says about the page it shows; input aimed at it is checked against the page now. */
export interface PageInfo { width: number; height: number; title: string; href: string; origin: number; dpr: number }

interface FramePage {
  evaluate(script: string, timeoutMs: number): Promise<unknown>;
  send(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
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
  const info = await page.evaluate(PAGE_INFO_SCRIPT, 5000) as PageInfo | null;
  // Between two documents the page answers nothing yet.
  if (!info) throw refused('the page is loading; ask for the next frame');
  const dpr = info.dpr > 0 ? info.dpr : 1;
  const scale = maxWidth && info.width * dpr > maxWidth ? maxWidth / (info.width * dpr) : 1;
  // Headless, a scaled clip shows nobody a flash: the frame is shrunk by the browser itself.
  const metrics = scale < 1 ? await page.send('Page.getLayoutMetrics', {}, 5000) as { cssVisualViewport: { pageX: number; pageY: number; clientWidth: number; clientHeight: number } } : null;
  const view = metrics?.cssVisualViewport;
  // Never more pixels than the viewer asked for: a slow link asked small for a reason.
  if (scale < 1 && !view) throw refused('the browser did not report the page layout; ask for the next frame');
  const shot = await page.send('Page.captureScreenshot', {
    format: 'jpeg', quality, captureBeyondViewport: false,
    ...(view ? { clip: { x: view.pageX, y: view.pageY, width: view.clientWidth, height: view.clientHeight, scale: scale * dpr } } : {}),
  }, 10_000) as { data?: string };
  if (typeof shot.data !== 'string') throw refused('the browser returned no frame');
  const frame: RemoteBrowserFrame = { id: crypto.randomUUID(), tabId, title: String(info.title ?? '').slice(0, 200), width: info.width, height: info.height, base64: shot.data, at: Date.now(), url: String(info.href ?? '').slice(0, REMOTE_URL_MAX) };
  return { frame, page: info };
}

/** What a screencast needs of the browser: the connection its tab's page is attached on. */
interface StreamCdp {
  send<T = Record<string, unknown>>(method: string, params?: Record<string, unknown>, sessionId?: string, timeoutMs?: number): Promise<T>;
  on(method: string, listener: (params: Record<string, unknown>, sessionId: string | undefined) => void): () => void;
}

/** One picture of the screencast, numbered across every stream so a held number never meets a newer stream's. */
export interface StreamFrame { seq: number; data: string; info: Promise<PageInfo | null> | null }

export interface StreamOptions { maxWidth: number | undefined; quality: number }

let streamSeq = 0;
/** Chrome draws no new picture while this many wait for an acknowledgement. */
const IN_FLIGHT_MAX = 2;
/** After a resize or a held-back stretch, the screencast has this long to send a picture before it is restarted. */
const CATCH_UP_MS = 300;

/**
 * The frames viewers of one tab are shown, from a screencast on a session of
 * its own: the recorder's screencast runs on the page's session, beside it.
 * Chrome sends a picture only when the page draws something new, so a still
 * page costs nothing. Only the newest picture is kept, and it is acknowledged
 * when a viewer takes it: Chrome never draws faster than the fastest viewer.
 * Chrome skips the paints it makes while held back, and sends nothing for the
 * last size of a quick run of resizes (measured with Chrome 153), so a page
 * that stops then would keep showing an older picture: a restart, which always
 * sends the page as it is, follows when no picture comes (`#catchUp`).
 */
export class ViewerStream {
  #session: string | null = null;
  #options: StreamOptions | null = null;
  #latest: StreamFrame | null = null;
  /** Pictures Chrome sent that nobody acknowledged yet, and the screencast they belong to. */
  #unacked = 0;
  #screencast = -1;
  /** Pictures of a screencast started before the last restart are of the old size: they are dropped. */
  #stale = -1;
  #waiters = new Set<() => void>();
  #off: (() => void) | null = null;
  #turn: Promise<unknown> = Promise.resolve();
  #catchUp?: ReturnType<typeof setTimeout>;
  /** Pictures received since the stream began, and their count when the page last had to draw a new one. */
  #received = 0;
  #expected = 0;
  closed = false;

  constructor(private cdp: StreamCdp, private targetId: string, private pageInfo: () => Promise<PageInfo | null>) {}

  /**
   * Starts the screencast, or restarts it when the options change or `force`
   * asks; the pictures of other options are dropped, and kept with `keep`.
   */
  configure(options: StreamOptions, force = false, keep = false): Promise<void> {
    const run = this.#turn.then(async () => {
      if (this.closed) return;
      if (!this.#session) {
        const { sessionId } = await this.cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId: this.targetId, flatten: true });
        if (this.closed) { void this.cdp.send('Target.detachFromTarget', { sessionId }).catch(() => {}); return; }
        this.#session = sessionId;
        this.#off = this.cdp.on('Page.screencastFrame', (params, session) => { if (session === sessionId) this.#frame(params); });
      }
      if (!force && this.#options && this.#options.maxWidth === options.maxWidth && this.#options.quality === options.quality) return;
      if (this.#options) await this.cdp.send('Page.stopScreencast', {}, this.#session).catch(() => {});
      this.#stale = this.#screencast; this.#unacked = 0; this.#options = options;
      if (!keep) this.#latest = null;
      await this.cdp.send('Page.startScreencast', { format: 'jpeg', quality: options.quality, everyNthFrame: 1, ...(options.maxWidth ? { maxWidth: options.maxWidth } : {}) }, this.#session);
    });
    this.#turn = run.catch(() => {});
    return run;
  }

  #frame(params: Record<string, unknown>): void {
    const screencast = Number(params.sessionId);
    if (this.closed || screencast <= this.#stale || typeof params.data !== 'string') return;
    this.#screencast = screencast; this.#unacked++; this.#received++;
    this.#latest = { seq: ++streamSeq, data: params.data, info: null };
    for (const wake of [...this.#waiters]) wake();
  }

  /** The newest picture after `held`, waiting up to `waitMs` for one; null when none came. */
  async next(held: number, waitMs: number): Promise<StreamFrame | null> {
    const found = () => (this.#latest && this.#latest.seq > held ? this.#latest : null);
    if (found() || this.closed) return found();
    await new Promise<void>(resolve => {
      const done = () => { clearTimeout(timer); this.#waiters.delete(done); resolve(); };
      const timer = setTimeout(done, waitMs);
      this.#waiters.add(done);
    });
    return this.closed ? null : found();
  }

  /** What the page was when a viewer first takes the picture, read once for every viewer of it. */
  info(frame: StreamFrame): Promise<PageInfo | null> {
    // A page between two documents answers nothing: the next viewer asks again.
    frame.info ??= this.pageInfo().catch(() => null).then(page => { if (!page) frame.info = null; return page; });
    return frame.info;
  }

  /**
   * A viewer took the newest picture: Chrome may draw the next. Held back, one
   * picture stays unacknowledged, so Chrome encodes one picture per take
   * rather than two; `all` releases every one.
   */
  take(all = false): void {
    const session = this.#session, count = this.#unacked;
    if (!session || !count) return;
    const release = all || count < IN_FLIGHT_MAX ? count : count - 1;
    this.#unacked = count - release;
    for (let i = 0; i < release; i++) void this.cdp.send('Page.screencastFrameAck', { sessionId: this.#screencast }, session).catch(() => {});
    // Held back, Chrome may have skipped the page's last paints.
    if (count >= IN_FLIGHT_MAX) this.#awaitPicture();
  }

  /** The page moved to another document or size: its last picture shows what was there before, and Chrome may draw the next. */
  forget(): void {
    this.take(true);
    this.#latest = null;
    this.#awaitPicture();
  }

  /** Restarts the screencast when no picture comes within `CATCH_UP_MS` of the last reason to expect one. */
  #awaitPicture(): void {
    this.#expected = this.#received;
    if (this.#catchUp !== undefined || this.closed) return;
    this.#catchUp = setTimeout(() => {
      this.#catchUp = undefined;
      if (!this.closed && this.#options && this.#received === this.#expected) void this.configure(this.#options, true, true).catch(() => {});
    }, CATCH_UP_MS);
    (this.#catchUp as { unref?: () => void }).unref?.();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.#latest = null;
    clearTimeout(this.#catchUp);
    for (const wake of [...this.#waiters]) wake();
    this.#off?.(); this.#off = null;
    const session = this.#session;
    void this.#turn.then(async () => {
      const last = session ?? this.#session;
      if (!last) return;
      await this.cdp.send('Page.stopScreencast', {}, last).catch(() => {});
      await this.cdp.send('Target.detachFromTarget', { sessionId: last }).catch(() => {});
    });
  }
}
