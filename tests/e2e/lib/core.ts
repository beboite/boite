import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PAIR_QUERY_PARAM } from '../../../packages/contracts/src/index.ts';

const MAIN = join(import.meta.dir, '..', '..', '..', 'packages', 'core', 'src', 'main.ts');
/** The default: the end to end suite proves the sources, a bench may point elsewhere. */
export const CORE_SOURCE_COMMAND: readonly string[] = ['bun', 'run', MAIN];
const READY = /boite-core ready (\S+) pairing (\S+)/;
const READY_TIMEOUT_MS = 30_000;

export interface StartCoreOptions {
  /** 0 asks the OS for a free port, which the ready line then reports. */
  port?: number;
  /** Reused across a restart so the same journal comes back. */
  dataDir?: string;
  env?: Record<string, string>;
  /** Argv before `--port`: the sources, the bundle, or the compiled core. */
  command?: readonly string[];
  /** Flags appended after `--port`, `--channel dev` being the one that has a caller. */
  args?: readonly string[];
}

export interface RunningCore {
  url: string;
  token: string;
  port: number;
  dataDir: string;
  pid: number;
  output(): string;
  stop(options?: { keepDataDir?: boolean }): Promise<void>;
}

export function freshDataDir(): string {
  return mkdtempSync(join(tmpdir(), 'boite-e2e-'));
}

export function killProcessTree(pid: number): void {
  if (process.platform === 'win32') {
    Bun.spawnSync(['taskkill', '/pid', String(pid), '/T', '/F'], { stdout: 'ignore', stderr: 'ignore', windowsHide: true });
    return;
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    /* already gone */
  }
}

export async function removeDirectory(path: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      rmSync(path, { recursive: true, force: true });
      return;
    } catch {
      await Bun.sleep(100);
    }
  }
}

export async function startCore(options: StartCoreOptions = {}): Promise<RunningCore> {
  const dataDir = options.dataDir ?? freshDataDir();
  const port = options.port ?? 0;
  const proc = Bun.spawn({
    windowsHide: true,
    cmd: [
      ...(options.command ?? CORE_SOURCE_COMMAND),
      '--port',
      String(port),
      ...(options.args ?? []),
    ],
    env: { ...process.env, BOITE_DATA_DIR: dataDir, BOITE_ECHO: '1', ...(options.env ?? {}) },
    stdout: 'pipe',
    stderr: 'pipe',
  });

  let text = '';
  const decoder = new TextDecoder();
  const reader = proc.stdout.getReader();

  const drainErrors = (async (): Promise<void> => {
    const errorReader = proc.stderr.getReader();
    const errorDecoder = new TextDecoder();
    for (;;) {
      const chunk = await errorReader.read();
      if (chunk.done) return;
      text += errorDecoder.decode(chunk.value, { stream: true });
    }
  })();
  void drainErrors.catch(() => undefined);

  let timedOut = false;
  const guard = setTimeout(() => {
    timedOut = true;
    killProcessTree(proc.pid);
  }, READY_TIMEOUT_MS);

  let match: RegExpMatchArray | null = null;
  while (match === null) {
    const chunk = await reader.read();
    if (chunk.done) {
      clearTimeout(guard);
      killProcessTree(proc.pid);
      await removeDirectory(dataDir);
      const why = timedOut ? 'never printed its ready line' : 'exited before it was ready';
      throw new Error(`the core ${why}. Output:\n${text}`);
    }
    text += decoder.decode(chunk.value, { stream: true });
    match = READY.exec(text);
  }
  clearTimeout(guard);

  void (async (): Promise<void> => {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return;
      text += decoder.decode(chunk.value, { stream: true });
    }
  })().catch(() => undefined);

  const url = match[1] ?? '';
  const pairingUrl = match[2] ?? '';
  const token = new URL(pairingUrl).searchParams.get(PAIR_QUERY_PARAM) ?? '';
  if (token === '') throw new Error(`the pairing url carries no token: ${pairingUrl}`);

  return {
    url,
    token,
    port: Number(new URL(url).port),
    dataDir,
    pid: proc.pid,
    output: () => text,
    async stop(stopOptions: { keepDataDir?: boolean } = {}): Promise<void> {
      killProcessTree(proc.pid);
      await proc.exited;
      if (stopOptions.keepDataDir !== true) await removeDirectory(dataDir);
    },
  };
}

export function pairingUrlOf(core: Pick<RunningCore, 'url' | 'token'>): string {
  return `${core.url}/?${PAIR_QUERY_PARAM}=${core.token}`;
}
