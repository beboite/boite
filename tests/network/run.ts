// Runs inside netns.sh: a core on the fake server, then every client
// scenario, each in its own namespace. bun run.ts <outDir>
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const here = import.meta.dir;
const root = join(here, '..', '..');
const outDir = process.argv[2] ?? join(here, '.artifacts');
const only = process.env.BENCH_ONLY?.split(',') ?? null;
const PORT = 7337;
let threadId = '';
let srvDataDir = '';
const results: unknown[] = [];
const procs: { kill(): void; exited: Promise<number> }[] = [];

function inNs(ns: string, cmd: string[], env: Record<string, string> = {}) {
  return Bun.spawn({ cmd: ['ip', 'netns', 'exec', ns, ...cmd], env: { ...process.env, ...env }, stdout: 'pipe', stderr: 'pipe' });
}
async function run(ns: string, cmd: string[], env: Record<string, string> = {}): Promise<string> {
  const proc = inNs(ns, cmd, env);
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  for (const line of err.split('\n')) if (line.startsWith('[client]')) console.error(line);
  if (code !== 0) throw new Error(`${ns}: ${cmd.join(' ')} exited ${code}\n${err}\n${out}`);
  return out.trim().split('\n').at(-1) ?? '';
}
async function startCore(ns: string, args: string[], port: number) {
  const dataDir = mkdtempSync(join(tmpdir(), `boite-netbench-${ns}-`));
  const proc = inNs(ns, ['bun', 'run', join(root, 'packages/core/src/main.ts'), '--port', String(port), ...args], {
    BOITE_UI_DIR: '', BOITE_DATA_DIR: dataDir, BOITE_DRAFTS_DIR: join(dataDir, 'Documents'), BOITE_ECHO: '1', BOITE_HOST_AGENTS: '0', BOITE_TELEMETRY_URL: '',
  });
  procs.push(proc);
  let text = '';
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  const deadline = Date.now() + 30_000;
  while (!/boite-core ready/.test(text)) {
    if (Date.now() > deadline) throw new Error(`${ns} core never ready:\n${text}`);
    const chunk = await reader.read();
    if (chunk.done) throw new Error(`${ns} core exited:\n${text}\n${await new Response(proc.stderr).text()}`);
    text += decoder.decode(chunk.value, { stream: true });
  }
  void (async () => { for (;;) { const c = await reader.read(); if (c.done) return; } })();
  const token = JSON.parse(readFileSync(join(dataDir, 'core.json'), 'utf8')).token as string;
  return { dataDir, token, ready: text.trim() };
}
const rpc = async (ns: string, dataDir: string, method: string, params: object = {}) =>
  JSON.parse(await run(ns, ['bun', join(here, 'rpc.ts'), dataDir, method, JSON.stringify(params)]));
const withHost = (url: string, host: string) => { const u = new URL(url); u.hostname = host; return u.toString(); };
const wanted = (label: string) => only === null || only.some((o) => label.includes(o));

const devOf = (ns: string) => ({ BENCH_DEV: ns.startsWith('ts-') ? 'tailscale0' : 'eth0' });
async function phone(ns: string, label: string, url: string) {
  if (!wanted(label)) return;
  const line = await run(ns, ['bun', join(here, 'client.ts'), 'phone', label, outDir, threadId, url], devOf(ns)).catch((e) => JSON.stringify({ label, ok: false, error: String(e) }));
  results.push({ url, ...JSON.parse(line) });
  console.error(`[bench] ${label}: ${JSON.parse(line).ok ? 'OK' : 'FAIL'}`);
}
async function desktop(ns: string, label: string, localPort: number, extra: Record<string, string> = {}) {
  if (!wanted(label)) return;
  const local = await startCore(ns, [], localPort);
  const env = { ...devOf(ns), ...extra, BENCH_RESOLVER_RULES: `MAP tauri.localhost 127.0.0.1:${localPort}` };
  const marker = `/run/bench-watching-${label}`;
  const watcher = (async () => {
    for (let i = 0; i < 600 && !(await Bun.file(marker).exists()); i++) await Bun.sleep(100);
    // Shown only once the client watches the thread: on a slow tailnet its subscription lands later.
    for (let i = 0; i < 20; i++) {
      const { shown } = await rpc('srv', srvDataDir, 'panel.open', { threadId, surface: { kind: 'file', path: join(srvDataDir, 'capture.png') } });
      if (shown) break;
      await Bun.sleep(500);
    }
  })().catch((e) => console.error(`[bench] panel.open: ${e}`));
  const { invite } = await rpc('srv', srvDataDir, 'group.invite');
  const line = await run(ns, ['bun', join(here, 'client.ts'), 'desktop', label, outDir, threadId, 'http://tauri.localhost', local.token, invite], env)
    .catch((e) => JSON.stringify({ label, ok: false, error: String(e) }));
  await watcher;
  results.push(JSON.parse(line));
  console.error(`[bench] ${label}: ${JSON.parse(line).ok ? 'OK' : 'FAIL'}`);
}

try {
  const srv = await startCore('srv', ['--lan'], PORT);
  console.error(`[bench] server: ${srv.ready}`);
  srvDataDir = srv.dataDir;
  await Bun.write(join(srv.dataDir, 'capture.png'), Bun.file(join(root, 'packages/ui/public/icons/icon-192.png')));
  const project = await rpc('srv', srv.dataDir, 'projects.add', { path: srv.dataDir, name: 'Projet réseau' });
  const account = (await rpc('srv', srv.dataDir, 'accounts.list')).find((a: { providerId: string }) => a.providerId === 'echo');
  threadId = (await rpc('srv', srv.dataDir, 'threads.create', { projectId: project.id, providerId: 'echo', accountId: account.id, title: 'Projet réseau' })).id;
  const grant = async (role = 'device') => (await rpc('srv', srv.dataDir, 'pairing.grant', { role })) as { url: string; links?: { url: string; network: string }[] };
  const offered = async (network: string, role = 'device') => {
    const minted = await grant(role);
    const link = minted.links?.find((l) => l.network === network);
    if (link) return link.url;
    // A core that offers one address only: the user types the tailnet one.
    console.error(`[bench] no ${network} link offered, typing the tailnet address by hand`);
    return withHost(minted.url, '100.80.1.10');
  };
  const shown = await grant();
  console.error(`[bench] the device link the app shows: ${shown.url} links=${JSON.stringify(shown.links?.map((l) => l.network + ' ' + new URL(l.url).host))}`);
  results.push({ shownDeviceLink: shown });

  await phone('lan-phone', 'phone-lan-as-shown', (await grant()).url);
  await phone('ts-phone', 'phone-ts-offered', await offered('tailscale'));
  await phone('ts-phone', 'phone-ts-magicdns', withHost((await grant()).url, 'boite-srv.tail-fake.ts.net'));
  await phone('ts-phone', 'phone-ts-shortname', withHost((await grant()).url, 'boite-srv'));
  await rpc('srv', srv.dataDir, 'group.create', { name: 'Maison' });
  await desktop('lan-desk', 'desktop-lan', 7400);
  await desktop('ts-desk', 'desktop-ts', 7402);
  await desktop('both-desk', 'desktop-both', 7404, { BENCH_SWITCH: '1' });
} finally {
  for (const p of procs) p.kill();
  await Promise.all(procs.map((p) => p.exited));
  console.log(JSON.stringify(results, null, 1));
}
