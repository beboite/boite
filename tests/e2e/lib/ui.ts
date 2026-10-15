import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Subprocess } from 'bun';
import { killProcessTreeAsync } from './cleanup.ts';
import { probeLog } from './probe.ts';
import { fixtureBridge, transformAll, uiRoot as root } from './ui-fixture.ts';

export { fixtureBridge };

const requireUi = createRequire(join(root, 'package.json'));
const { build, createServer, preview } = await import(requireUi.resolve('vite'));
// One directory per process: `bun test --parallel` runs files in several
// workers, and a shared one would be emptied under another worker's server.
const fixtureDir = join(import.meta.dir, `../.artifacts/fake-ui-${process.pid}`);
let fixtureBuild: Promise<unknown> | undefined;

type UiServer = { close(): Promise<void> };

/**
 * Which runtime serves the test UI. On the Windows runner a Vite server inside
 * `bun test` stopped delivering responses on Chrome's keep-alive connections:
 * pages waited 15 to 60 s on modules the server had already answered, while a
 * fresh connection got the same file in milliseconds (2026-10-15, PR #513). A
 * Node process of its own serves them instead, also out of reach of the test
 * process's own pauses. `BOITE_E2E_UI_RUNTIME=bun` keeps the server in process;
 * `node` refuses to fall back. Node needs 22.18 or later, which runs
 * `ui-server.ts` by stripping its types.
 */
let nodeRuntime: Promise<string | null> | undefined;
function uiNode(): Promise<string | null> {
  nodeRuntime ??= (async () => {
    const wanted = process.env.BOITE_E2E_UI_RUNTIME ?? '';
    if (wanted === 'bun') return null;
    if (wanted !== '' && wanted !== 'node') throw new Error(`BOITE_E2E_UI_RUNTIME=${wanted}: expected node or bun`);
    const node = Bun.which('node');
    let version = '';
    if (node !== null) {
      const proc = Bun.spawn([node, '-p', 'process.versions.node'], { stdout: 'pipe', stderr: 'ignore', windowsHide: true });
      version = (await new Response(proc.stdout).text()).trim();
      await proc.exited;
    }
    const [major = 0, minor = 0] = version.split('.').map(Number);
    if (node !== null && (major > 22 || (major === 22 && minor >= 18))) {
      probeLog(`test UI served by Node ${version}`);
      return node;
    }
    const why = node === null ? 'no node on PATH' : `node ${version || 'unknown'} is older than 22.18`;
    if (wanted === 'node') throw new Error(`BOITE_E2E_UI_RUNTIME=node: ${why}`);
    console.warn(`[e2e] the test UI runs inside bun test: ${why}`);
    return null;
  })();
  return nodeRuntime;
}

const SERVER_READY_MS = 50_000;

/** Starts `ui-server.ts` under Node and returns once it serves. */
async function serveInNode(node: string, args: string[]): Promise<UiServer> {
  const proc: Subprocess<'pipe', 'pipe', 'pipe'> = Bun.spawn([node, join(import.meta.dir, 'ui-server.ts'), ...args], {
    stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', windowsHide: true,
  });
  let output = '';
  const drain = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) output = (output + decoder.decode(chunk, { stream: true })).slice(-16_384);
  };
  void drain(proc.stderr).catch(() => undefined);
  const stop = async (): Promise<void> => {
    try { proc.stdin.end(); } catch { /* already closed */ }
    const exited = await Promise.race([proc.exited.then(() => true), Bun.sleep(5_000).then(() => false)]);
    // Its own pid, captured at spawn.
    if (!exited) await killProcessTreeAsync(proc.pid);
  };
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let text = '';
  const deadline = setTimeout(() => { void stop(); }, SERVER_READY_MS);
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error(`the test UI server (${args.join(' ')}) exited with code ${await proc.exited} before it served. Output:\n${text}${output}`);
      text += decoder.decode(chunk.value, { stream: true });
      const ready = /^ready (\d+)$/m.exec(text);
      if (ready) {
        process.stdout.write(text.slice(0, ready.index));
        probeLog(`UI server ${args.slice(0, 2).join(' ')} ready${ready[1] === '0' ? '' : `, ${ready[1]} modules`}`);
        break;
      }
    }
  } catch (error) {
    await stop();
    throw error;
  } finally {
    clearTimeout(deadline);
  }
  // Vite's own log lines, as an in-process server prints them.
  const rest = text.slice(text.indexOf('\n', text.search(/^ready /m)) + 1);
  if (rest.trim() !== '') process.stdout.write(rest);
  void (async () => {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return;
      process.stdout.write(decoder.decode(chunk.value, { stream: true }));
    }
  })().catch(() => undefined);
  return { close: stop };
}

/** Build fake-client fixtures once in CI, keeping cold transforms outside browser interaction deadlines. */
export async function startUi(port: number, options: { development?: boolean } = {}): Promise<UiServer> {
  const address = { host: '127.0.0.1', port, strictPort: true };
  const shared = process.env.BOITE_E2E_FAKE_UI;
  if (shared && !options.development) {
    // Built once by `lib/warm.ts` before a parallel run.
    if (!existsSync(join(shared, 'index.html'))) throw new Error(`BOITE_E2E_FAKE_UI=${shared} holds no index.html; build it with bun tests/e2e/lib/warm.ts ${shared}`);
    const node = await uiNode();
    if (node !== null) return serveInNode(node, ['preview', String(port), resolve(shared)]);
    return preview({ root, build: { outDir: resolve(shared) }, preview: address, clearScreen: false });
  }
  if (process.env.BOITE_E2E_PREBUILT_UI === '1' && !options.development) {
    // Production intentionally excludes ?fake=1. This separate test bundle
    // enables it without changing the UI staged in the installer.
    fixtureBuild ??= build({ root, plugins: [fixtureBridge], define: { 'import.meta.env.DEV': 'true' }, build: { outDir: fixtureDir, emptyOutDir: true }, logLevel: 'warn' });
    await fixtureBuild;
    const node = await uiNode();
    if (node !== null) return serveInNode(node, ['preview', String(port), fixtureDir]);
    return preview({ root, build: { outDir: fixtureDir }, preview: address, clearScreen: false });
  }
  return startDevUi(port);
}

/**
 * A dev server, for a file whose page imports `/src/...` at run time: a built
 * bundle has no such URL. Every module the page can load is transformed before
 * this returns, so the cost lands in `beforeAll` and not in the first browser
 * launch. Cold, on a loaded Windows runner, that launch outran the 30 s a test
 * hook gets.
 */
export async function startDevUi(port: number): Promise<UiServer> {
  const node = await uiNode();
  if (node !== null) return serveInNode(node, ['dev', String(port)]);
  const server = await createServer({ root, plugins: [fixtureBridge], server: { host: '127.0.0.1', port, strictPort: true }, clearScreen: false });
  try {
    await server.listen();
    await transformAll(server, '/src/main.ts');
  } catch (error) {
    await server.close();
    throw error;
  }
  return server;
}
