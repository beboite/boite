import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freePort } from '../tests/e2e/lib/cdp.ts';
import { killProcessTree, removeDirectory } from '../tests/e2e/lib/core.ts';
import { findByExecutable, snapshot, sumByName, tree, treeBytes, workingSet } from './lib/proc.ts';

export const LEGACY_ROOT = 'D:\\Dev\\Collab\\boite-legacy';
export const LEGACY_SERVER = join(LEGACY_ROOT, 'target', 'release', 'boite-server.exe');
export const LEGACY_APP = 'C:\\Users\\mtsu\\AppData\\Local\\Boite Legacy\\boite.exe';

const BOOTSTRAP = 'bench';
const SCOPES = ['read', 'write', 'terminal', 'approve', 'admin'];
const START_TIMEOUT_MS = 30_000;

export interface RunningServer {
  pid: number;
  port: number;
  http: string;
  ws: string;
  dataDir: string;
  workspaceDir: string;
  stop(): Promise<void>;
}

/** Any status counts: the server answering at all is what is being timed. */
async function waitForHttp(base: string): Promise<void> {
  const deadline = Date.now() + START_TIMEOUT_MS;
  for (;;) {
    try {
      await fetch(`${base}/`, { signal: AbortSignal.timeout(1_000) });
      return;
    } catch {
      /* not listening yet */
    }
    if (Date.now() > deadline) throw new Error(`${base}/ never answered`);
    await Bun.sleep(5);
  }
}

export async function startServer(): Promise<{ server: RunningServer; startMs: number }> {
  const port = await freePort();
  const dataDir = mkdtempSync(join(tmpdir(), 'boite-bench-legacy-data-'));
  const workspaceDir = mkdtempSync(join(tmpdir(), 'boite-bench-legacy-ws-'));
  const http = `http://127.0.0.1:${port}`;

  const startedAt = performance.now();
  const proc = Bun.spawn({
    cmd: [LEGACY_SERVER],
    env: {
      ...process.env,
      BOITE_BIND: `127.0.0.1:${port}`,
      BOITE_DATA_DIR: dataDir,
      BOITE_TOKEN: BOOTSTRAP,
      BOITE_WORKSPACE_DIR: workspaceDir,
    },
    stdout: 'ignore',
    stderr: 'ignore',
    windowsHide: true,
  });
  try {
    await waitForHttp(http);
  } catch (error) {
    killProcessTree(proc.pid);
    await removeDirectory(dataDir);
    await removeDirectory(workspaceDir);
    throw error;
  }
  const startMs = performance.now() - startedAt;

  return {
    server: {
      pid: proc.pid,
      port,
      http,
      ws: `ws://127.0.0.1:${port}/ws`,
      dataDir,
      workspaceDir,
      async stop(): Promise<void> {
        killProcessTree(proc.pid);
        await proc.exited;
        await removeDirectory(dataDir);
        await removeDirectory(workspaceDir);
      },
    },
    startMs,
  };
}

export async function serverColdStart(runs = 5): Promise<number[]> {
  const times: number[] = [];
  for (let index = 0; index < runs; index += 1) {
    const started = await startServer();
    times.push(started.startMs);
    await started.server.stop();
  }
  return times;
}

export async function serverIdleRss(): Promise<number> {
  const started = await startServer();
  await Bun.sleep(3_000);
  const bytes = workingSet(started.server.pid);
  await started.server.stop();
  return bytes;
}

// ---------------------------------------------------------------------------
// The four steps `scripts/server-smoke.mjs` documents: a bootstrap token mints a
// pairing, the pairing buys a device credential, the credential buys a ticket,
// the ticket opens one socket.
// ---------------------------------------------------------------------------

async function json(url: string, init: RequestInit): Promise<Record<string, unknown>> {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return (await response.json()) as Record<string, unknown>;
}

async function pairDevice(http: string): Promise<string> {
  const minted = await json(`${http}/api/pairings`, {
    method: 'POST',
    headers: { authorization: `Bearer ${BOOTSTRAP}`, 'content-type': 'application/json' },
    body: JSON.stringify({ label: 'bench', kind: 'cli', scopes: SCOPES }),
  });
  const token = minted.token;
  if (typeof token !== 'string') throw new Error('the pairing answer carried no token');
  const paired = await json(`${http}/api/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token, label: 'bench', kind: 'cli' }),
  });
  const credential = paired.credential;
  if (typeof credential !== 'string') throw new Error('the pair answer carried no credential');
  return credential;
}

class LegacyClient {
  #socket: WebSocket;
  #nextId = 1;
  #pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

  private constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.binaryType = 'arraybuffer';
    socket.addEventListener('message', (event: MessageEvent) => {
      if (typeof event.data !== 'string') return;
      let frame: { id?: unknown; ok?: unknown; result?: unknown; error?: unknown };
      try {
        frame = JSON.parse(event.data) as typeof frame;
      } catch {
        return;
      }
      if (typeof frame.id !== 'number') return;
      const waiter = this.#pending.get(frame.id);
      if (waiter === undefined) return;
      this.#pending.delete(frame.id);
      if (frame.ok === false) waiter.reject(new Error(String(frame.error)));
      else waiter.resolve(frame.result);
    });
  }

  static async open(server: RunningServer): Promise<LegacyClient> {
    const credential = await pairDevice(server.http);
    const bought = await json(`${server.http}/api/ticket`, {
      method: 'POST',
      headers: { authorization: `Bearer ${credential}` },
    });
    const ticket = bought.ticket;
    if (typeof ticket !== 'string') throw new Error('the ticket answer carried no ticket');

    const socket = new WebSocket(server.ws);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('the legacy socket did not open')), 10_000);
      socket.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      });
      socket.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('the legacy socket failed to open'));
      });
    });
    const client = new LegacyClient(socket);
    await client.rpc('auth', { ticket });
    return client;
  }

  rpc(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = this.#nextId;
    this.#nextId += 1;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`legacy rpc timed out: ${method}`));
      }, 15_000);
      this.#pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.#socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close(): void {
    this.#socket.close();
  }
}

export interface LegacyThreads {
  baseBytes: number;
  afterBytes: number;
  perThreadBytes: number;
  terminals: number;
  processesAfter: { name: string; count: number }[];
}

/** Ten `cmd` terminals that stay alive, so the PTY cost is what is measured. */
export async function threadsIdle(terminals = 10): Promise<LegacyThreads> {
  const started = await startServer();
  const server = started.server;
  const client = await LegacyClient.open(server);
  await client.rpc('project.create', {
    project: { id: 'bench', name: 'bench', cwd: server.workspaceDir, icon: null, archived: false },
  });

  await Bun.sleep(2_000);
  const baseBytes = treeBytes(server.pid);

  const ids: string[] = [];
  for (let index = 0; index < terminals; index += 1) {
    const id = crypto.randomUUID();
    ids.push(id);
    await client.rpc('thread.spawn', {
      thread: {
        id,
        projectId: 'bench',
        label: `bench ${index}`,
        cmd: 'cmd',
        args: ['/c', 'ping -n 600 127.0.0.1 >NUL'],
        iconKey: null,
      },
      cwd: server.workspaceDir,
      cols: 80,
      rows: 24,
    });
  }

  await Bun.sleep(3_000);
  const table = snapshot();
  const members = tree(server.pid, table);
  const afterBytes = members.reduce((total, info) => total + info.workingSetBytes, 0);
  const names = new Map<string, number>();
  for (const info of members) names.set(info.name, (names.get(info.name) ?? 0) + 1);

  for (const id of ids) {
    await client.rpc('thread.kill', { threadId: id, wait: false }).catch(() => undefined);
  }
  client.close();
  await server.stop();

  return {
    baseBytes,
    afterBytes,
    perThreadBytes: (afterBytes - baseBytes) / terminals,
    terminals,
    processesAfter: [...names.entries()].map(([name, count]) => ({ name, count })),
  };
}

export interface LiveApp {
  found: boolean;
  appBytes: number;
  webviewBytes: number;
  webviewCount: number;
  claudeBytes: number;
  claudeCount: number;
  mcpBytes: number;
  mcpCount: number;
  /** app + WebView2 + claude.exe + boite-mcp.exe, the four the app owns. */
  namedTotalBytes: number;
  /** Everything under the app, the user's own terminal workloads included. */
  treeTotalBytes: number;
  otherProcesses: { name: string; count: number; bytes: number }[];
}

/** Read only. The user's own Boite Legacy is never launched, signalled or killed. */
export function liveApp(): LiveApp {
  const table = snapshot();
  const roots = findByExecutable(LEGACY_APP, table);
  const empty: LiveApp = {
    found: false,
    appBytes: 0,
    webviewBytes: 0,
    webviewCount: 0,
    claudeBytes: 0,
    claudeCount: 0,
    mcpBytes: 0,
    mcpCount: 0,
    namedTotalBytes: 0,
    treeTotalBytes: 0,
    otherProcesses: [],
  };
  if (roots.length === 0) return empty;

  const seen = new Map<number, ReturnType<typeof tree>[number]>();
  for (const root of roots) {
    for (const info of tree(root.pid, table)) seen.set(info.pid, info);
  }
  const members = [...seen.values()];
  const app = sumByName(members, 'boite.exe');
  const webview = sumByName(members, 'msedgewebview2.exe');
  const claude = sumByName(members, 'claude.exe');
  const mcp = sumByName(members, 'boite-mcp.exe');
  const counted = new Set(['boite.exe', 'msedgewebview2.exe', 'claude.exe', 'boite-mcp.exe']);
  const others = new Map<string, { count: number; bytes: number }>();
  for (const info of members) {
    if (counted.has(info.name.toLowerCase())) continue;
    const entry = others.get(info.name) ?? { count: 0, bytes: 0 };
    entry.count += 1;
    entry.bytes += info.workingSetBytes;
    others.set(info.name, entry);
  }

  return {
    found: true,
    appBytes: app.bytes,
    webviewBytes: webview.bytes,
    webviewCount: webview.count,
    claudeBytes: claude.bytes,
    claudeCount: claude.count,
    mcpBytes: mcp.bytes,
    mcpCount: mcp.count,
    namedTotalBytes: app.bytes + webview.bytes + claude.bytes + mcp.bytes,
    treeTotalBytes: members.reduce((total, info) => total + info.workingSetBytes, 0),
    otherProcesses: [...others.entries()].map(([name, entry]) => ({ name, ...entry })),
  };
}

export function serverBuilt(): boolean {
  return existsSync(LEGACY_SERVER);
}
