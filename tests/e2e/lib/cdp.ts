import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { killProcessTree, removeDirectory } from './core.ts';

const CONNECT_TIMEOUT_MS = 30_000;
const CALL_TIMEOUT_MS = 20_000;
const POLL_MS = 100;

/** Candidates in order; `BOITE_E2E_BROWSER` overrides all of them. */
function browserCandidates(): string[] {
  const local = process.env.LOCALAPPDATA ?? '';
  const programs = process.env.ProgramFiles ?? '';
  const programsX86 = process.env['ProgramFiles(x86)'] ?? '';
  if (process.platform === 'win32') {
    return [
      join(local, 'imput', 'Helium', 'Application', 'chrome.exe'),
      join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(programs, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(programsX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(programsX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    ].filter((path) => path.length > 0);
  }
  return ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
}

export function findBrowser(): string {
  const override = process.env.BOITE_E2E_BROWSER;
  if (override !== undefined && override !== '') return override;
  for (const candidate of browserCandidates()) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    `no Chromium was found. Looked at:\n${browserCandidates().join('\n')}\nSet BOITE_E2E_BROWSER to one.`,
  );
}

export function freePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close();
        reject(new Error('the OS did not report a port'));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

interface TargetInfo {
  type: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface BrowserOptions {
  url: string;
  executable?: string;
  userDataDir?: string;
  debugPort?: number;
  windowSize?: { width: number; height: number };
}

export class BrowserPage {
  #socket: WebSocket;
  #pid: number | null;
  #userDataDir: string | null;
  #nextId = 1;
  #pending = new Map<number, Pending>();
  #closed = false;
  #pageErrors: string[] = [];

  private constructor(socket: WebSocket, pid: number | null, userDataDir: string | null) {
    this.#socket = socket;
    this.#pid = pid;
    this.#userDataDir = userDataDir;
    socket.addEventListener('message', (event: MessageEvent) => {
      this.#receive(typeof event.data === 'string' ? event.data : '');
    });
    socket.addEventListener('close', () => {
      for (const pending of this.#pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error('the devtools socket closed'));
      }
      this.#pending.clear();
    });
  }

  static async launch(options: BrowserOptions): Promise<BrowserPage> {
    const executable = options.executable ?? findBrowser();
    const ownsUserDataDir = options.userDataDir === undefined;
    const userDataDir = options.userDataDir ?? mkdtempSync(join(tmpdir(), 'boite-e2e-browser-'));
    const port = options.debugPort ?? (await freePort());
    const size = options.windowSize ?? { width: 1440, height: 900 };

    const proc = Bun.spawn({
      cmd: [
        executable,
        '--headless=new',
        '--use-gl=angle',
        '--use-angle=d3d11',
        '--mute-audio',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-networking',
        // Keep hidden test pages responsive when another browser owns the active page.
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--remote-allow-origins=*',
        `--window-size=${size.width},${size.height}`,
        `--user-data-dir=${userDataDir}`,
        `--remote-debugging-port=${port}`,
        'about:blank',
      ],
      stdout: 'ignore',
      stderr: 'ignore',
      windowsHide: true,
    });

    try {
      const target = await waitForPageTarget(port);
      const socket = await openSocket(target);
      const page = new BrowserPage(socket, proc.pid, ownsUserDataDir ? userDataDir : null);
      await page.send('Page.enable', {});
      await page.send('Runtime.enable', {});
      await page.navigate(options.url);
      return page;
    } catch (error) {
      killProcessTree(proc.pid);
      if (ownsUserDataDir) await removeDirectory(userDataDir);
      throw error;
    }
  }

  /**
   * Drives a page that something else launched, such as the shell's WebView2
   * started with `--remote-debugging-port`. Closing it kills nothing.
   */
  static async attach(port: number, urlIncludes = ''): Promise<BrowserPage> {
    const socket = await openSocket(await waitForPageTarget(port, urlIncludes));
    const page = new BrowserPage(socket, null, null);
    await page.send('Page.enable', {});
    await page.send('Runtime.enable', {});
    return page;
  }

  /** The one place raw devtools JSON is handled. */
  send(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (this.#closed) return Promise.reject(new Error('the browser is closed'));
    const id = this.#nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, CALL_TIMEOUT_MS);
      this.#pending.set(id, { resolve, reject, timer });
      this.#socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate<T>(expression: string): Promise<T> {
    const raw = (await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })) as {
      result?: { value?: unknown };
      exceptionDetails?: {
        text?: string;
        exception?: { description?: string; value?: unknown };
      };
    };
    const failure = raw.exceptionDetails;
    if (failure !== undefined) {
      // A Tauri command rejects with a plain string, which devtools reports as a
      // value and not as a description: without this line every refusal read
      // "Uncaught (in promise)" and said nothing about what was refused.
      const thrown = failure.exception?.value;
      const detail =
        failure.exception?.description ??
        (thrown === undefined ? undefined : JSON.stringify(thrown)) ??
        failure.text ??
        'unknown';
      throw new Error(`evaluate failed: ${detail}\nexpression: ${expression}`);
    }
    return raw.result?.value as T;
  }

  async waitFor(expression: string, timeoutMs = 15_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let last = '';
    for (;;) {
      try {
        const ok = await this.evaluate<boolean>(`(async () => !!(await (${expression})))()`);
        if (ok) return;
        last = 'it stayed false';
      } catch (error) {
        last = error instanceof Error ? error.message : String(error);
      }
      if (Date.now() > deadline) {
        const state = await this.evaluate(`({ location: location.origin + location.pathname, ready: document.readyState, title: document.title, text: document.body?.innerText.slice(0, 500) })`).catch(() => 'page unresponsive');
        throw new Error(`waitFor timed out on ${expression}: ${last}\nPage: ${JSON.stringify(state)}\nErrors: ${JSON.stringify(this.#pageErrors)}`);
      }
      await Bun.sleep(POLL_MS);
    }
  }

  async navigate(url: string): Promise<void> {
    const result = await this.send('Page.navigate', { url }) as { errorText?: string; loaderId?: string };
    if (result.errorText) throw new Error(`navigation failed: ${result.errorText}`);
    if (result.loaderId) {
      const deadline = Date.now() + CONNECT_TIMEOUT_MS;
      for (;;) {
        const tree = await this.send('Page.getFrameTree', {}) as { frameTree: { frame: { loaderId: string } } };
        if (tree.frameTree.frame.loaderId === result.loaderId) break;
        if (Date.now() > deadline) throw new Error('the requested navigation never committed');
        await Bun.sleep(POLL_MS);
      }
    }
    await this.waitFor("document.readyState === 'complete'");
  }

  async click(selector: string): Promise<void> {
    await this.waitFor(`document.querySelector(${JSON.stringify(selector)})`);
    await this.evaluate<null>(
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.click(); return null; })()`,
    );
  }

  /** Sets the value and fires `input`, which is what a Svelte binding listens to. */
  async type(selector: string, text: string): Promise<void> {
    await this.waitFor(`document.querySelector(${JSON.stringify(selector)})`);
    await this.evaluate<null>(
      `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        el.focus();
        el.value = ${JSON.stringify(text)};
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return null;
      })()`,
    );
  }

  /** Same idea for a `<select>`, which reacts to `change`. */
  async choose(selector: string, value: string): Promise<void> {
    await this.waitFor(`document.querySelector(${JSON.stringify(selector)})`);
    await this.evaluate<null>(
      `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        el.value = ${JSON.stringify(value)};
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return null;
      })()`,
    );
  }

  text(selector: string): Promise<string> {
    return this.evaluate<string>(
      `(document.querySelector(${JSON.stringify(selector)})?.textContent ?? '')`,
    );
  }

  async screenshot(path: string): Promise<void> {
    const raw = (await this.send('Page.captureScreenshot', { format: 'png' })) as { data?: string };
    if (typeof raw.data !== 'string') throw new Error('the screenshot came back empty');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, Buffer.from(raw.data, 'base64'));
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    try {
      this.#socket.close();
    } catch {
      /* already gone */
    }
    if (this.#pid !== null) killProcessTree(this.#pid);
    if (this.#userDataDir !== null) await removeDirectory(this.#userDataDir);
  }

  #receive(raw: string): void {
    if (raw === '') return;
    let frame: { id?: unknown; method?: string; params?: { exceptionDetails?: { text?: string; exception?: { description?: string } } }; result?: unknown; error?: { message?: string } };
    try {
      frame = JSON.parse(raw) as typeof frame;
    } catch {
      return;
    }
    if (typeof frame.id !== 'number') {
      if (frame.method === 'Runtime.exceptionThrown') {
        const detail = frame.params?.exceptionDetails;
        this.#pageErrors.push(detail?.exception?.description ?? detail?.text ?? 'unknown page exception');
        if (this.#pageErrors.length > 10) this.#pageErrors.shift();
      }
      return;
    }
    const pending = this.#pending.get(frame.id);
    if (pending === undefined) return;
    this.#pending.delete(frame.id);
    clearTimeout(pending.timer);
    if (frame.error !== undefined) pending.reject(new Error(frame.error.message ?? 'devtools error'));
    else pending.resolve(frame.result);
  }
}

async function waitForPageTarget(port: number, urlIncludes = ''): Promise<TargetInfo> {
  const deadline = Date.now() + CONNECT_TIMEOUT_MS;
  let last = 'the debugging port never answered';
  for (;;) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = (await response.json()) as TargetInfo[];
      const page = targets.find(
        (target) => target.type === 'page' && target.url.includes(urlIncludes) && typeof target.webSocketDebuggerUrl === 'string',
      );
      if (page !== undefined) return page;
      last = `no page target among ${targets.length}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    if (Date.now() > deadline) throw new Error(`the browser never exposed a page: ${last}`);
    await Bun.sleep(POLL_MS);
  }
}

function openSocket(target: TargetInfo): Promise<WebSocket> {
  const url = target.webSocketDebuggerUrl;
  if (url === undefined) throw new Error('the page target has no debugger url');
  return new Promise<WebSocket>((resolve, reject) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(() => reject(new Error('the devtools socket did not open')), CONNECT_TIMEOUT_MS);
    socket.addEventListener('open', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error('the devtools socket failed to open'));
    });
  });
}
