import { cpus, freemem, totalmem } from 'node:os';

/**
 * TEMPORARY diagnostics for the Windows E2E stalls. With BOITE_E2E_PROBE=1 the
 * preload starts it: event-loop lag of this test process, machine CPU and
 * memory, TCP states and process counts every few seconds.
 */
export const probing = process.env.BOITE_E2E_PROBE === '1';

const started = Date.now();
const stamp = () => `${((Date.now() - started) / 1000).toFixed(1)}s`;

export function probeLog(text: string): void {
  if (probing) console.log(`[probe ${stamp()}] ${text}`);
}

/** Logs a phase that took over `floorMs`. */
export function probePhase(label: string, since: number, floorMs = 3_000): void {
  const ms = Math.round(performance.now() - since);
  if (probing && ms >= floorMs) probeLog(`${label} took ${ms} ms`);
}

function cpuTimes(): { idle: number; total: number } {
  let idle = 0;
  let total = 0;
  for (const cpu of cpus()) {
    idle += cpu.times.idle;
    total += cpu.times.idle + cpu.times.user + cpu.times.sys + cpu.times.irq + cpu.times.nice;
  }
  return { idle, total };
}

async function run(cmd: string[]): Promise<string> {
  const proc = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'ignore', windowsHide: true });
  const text = await new Response(proc.stdout).text();
  await proc.exited;
  return text;
}

async function snapshot(previous: { idle: number; total: number }): Promise<{ idle: number; total: number }> {
  const now = cpuTimes();
  const busy = now.total > previous.total ? 100 - (100 * (now.idle - previous.idle)) / (now.total - previous.total) : 0;
  let tcp = '';
  let procs = '';
  if (process.platform === 'win32') {
    const states = new Map<string, number>();
    for (const line of (await run(['netstat', '-an', '-p', 'tcp'])).split('\n')) {
      const state = line.trim().split(/\s+/)[3];
      if (state && /^[A-Z_]+$/.test(state)) states.set(state, (states.get(state) ?? 0) + 1);
    }
    tcp = [...states].map(([name, count]) => `${name}=${count}`).join(' ');
    const images = new Map<string, number>();
    for (const line of (await run(['tasklist', '/fo', 'csv', '/nh'])).split('\n')) {
      const image = /^"([^"]+)"/.exec(line)?.[1]?.toLowerCase();
      if (image && /^(chrome|bun|node|taskkill|conhost|cmd|msedge|crashpad_handler)\.exe$/.test(image)) images.set(image, (images.get(image) ?? 0) + 1);
    }
    procs = [...images].map(([name, count]) => `${name}=${count}`).join(' ');
  }
  const rss = Math.round(process.memoryUsage().rss / 1e6);
  probeLog(`cpu=${busy.toFixed(0)}% free=${Math.round(freemem() / 1e6)}/${Math.round(totalmem() / 1e6)}MB rss=${rss}MB ${tcp} ${procs}`);
  return now;
}

export function startProbe(): void {
  if (!probing) return;
  probeLog(`cpus=${cpus().length}`);
  let expected = Date.now() + 200;
  const lag = setInterval(() => {
    const late = Date.now() - expected;
    if (late > 1_000) probeLog(`event loop blocked ${late} ms`);
    expected = Date.now() + 200;
  }, 200);
  lag.unref();
  let previous = cpuTimes();
  let busy = false;
  const machine = setInterval(() => {
    if (busy) return;
    busy = true;
    void snapshot(previous).then((now) => { previous = now; }).catch((error) => probeLog(`snapshot failed: ${String(error)}`)).finally(() => { busy = false; });
  }, 5_000);
  machine.unref();
}

interface Tracked { url: string; at: number; }
const servers = new Map<number, { inFlight: Set<Tracked>; sockets: number; received: number; reported: Set<Tracked> }>();

/** A Vite plugin that records what the dev server on `port` received and has not answered. */
export function probeServer(port: number): { name: string; configureServer(server: { middlewares: { use(fn: (req: { url?: string }, res: { once(event: string, fn: () => void): void }, next: () => void) => void): void }; httpServer: { on(event: string, fn: (socket: { once(event: string, fn: () => void): void }) => void): void } | null }): void } {
  const state = { inFlight: new Set<Tracked>(), sockets: 0, received: 0, reported: new Set<Tracked>() };
  servers.set(port, state);
  return {
    name: 'boite-e2e-probe',
    configureServer(server) {
      if (!probing) return;
      server.httpServer?.on('connection', (socket) => {
        state.sockets += 1;
        socket.once('close', () => { state.sockets -= 1; });
      });
      server.middlewares.use((req, res, next) => {
        const entry = { url: req.url ?? '', at: Date.now() };
        state.received += 1;
        state.inFlight.add(entry);
        const done = () => state.inFlight.delete(entry);
        res.once('finish', done);
        res.once('close', done);
        next();
      });
    },
  };
}

export function probeServerClosed(port: number): void {
  servers.delete(port);
}

function checkServers(): void {
  const now = Date.now();
  for (const [port, state] of servers) {
    const stuck = [...state.inFlight].filter((entry) => now - entry.at > 5_000);
    const fresh = stuck.filter((entry) => !state.reported.has(entry));
    if (fresh.length === 0) continue;
    for (const entry of stuck) state.reported.add(entry);
    probeLog(`dev server ${port}: ${stuck.length} of ${state.inFlight.size} in flight over 5 s, ${state.sockets} sockets, ${state.received} received: ${stuck.slice(0, 6).map((entry) => `${entry.url} ${now - entry.at}ms`).join(', ')}`);
    const url = `http://127.0.0.1:${port}${stuck[0]?.url ?? '/'}`;
    const curl = process.platform === 'win32' ? 'curl.exe' : 'curl';
    void run([curl, '-s', '-o', process.platform === 'win32' ? 'NUL' : '/dev/null', '-w', '%{http_code} %{time_total}s', '--max-time', '8', url])
      .then((answer) => probeLog(`dev server ${port}: curl from another process ${stuck[0]?.url}: ${answer || 'no answer'}`));
  }
}

if (probing) setInterval(checkServers, 1_000).unref();
