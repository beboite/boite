import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * What the Vite servers of this test process did with each request, for a
 * browser wait that fails with requests still in flight: whether the UI server
 * got the request, answered it and when. `lib/ui.ts` and `lib/warm.ts` put
 * `requestLog` on every server they start; `BrowserPage` reads `uiServerSide`.
 */
interface Served { port: number; path: string; at: number; status?: number; finished?: number; closed?: number }

/** The newest requests across every server of the process: a shard's files run in one. */
const MAX_SERVED = 4_000;
const served: Served[] = [];
const ports = new Set<number>();

type Middleware = (req: IncomingMessage, res: ServerResponse, next: () => void) => void;
interface WithMiddlewares { middlewares: { use(handler: Middleware): unknown } }

function record(req: IncomingMessage, res: ServerResponse, next: () => void): void {
  const port = req.socket.localPort ?? 0;
  const entry: Served = { port, path: req.url ?? '', at: Date.now() };
  ports.add(port);
  served.push(entry);
  if (served.length > MAX_SERVED) served.splice(0, served.length - MAX_SERVED);
  res.once('finish', () => { entry.finished = Date.now(); entry.status = res.statusCode; });
  res.once('close', () => { entry.closed = Date.now(); });
  next();
}

/** Added first, so it sees every request, the ones Vite's own middlewares answer included. */
export const requestLog = {
  name: 'boite-e2e-request-log',
  configureServer(server: WithMiddlewares) { server.middlewares.use(record); },
  configurePreviewServer(server: WithMiddlewares) { server.middlewares.use(record); },
};

/**
 * The UI server's side of a request the browser sent at `sentAt`, or null when
 * no server of this process listens on its port (a core serves that page).
 */
export function uiServerSide(url: string, sentAt: number): string | null {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return null; }
  const port = Number(parsed.port);
  if (!ports.has(port)) return null;
  const path = parsed.pathname + parsed.search;
  // Same process, same clock: the server cannot see it before the browser sent it.
  const entry = served.findLast((candidate) => candidate.port === port && candidate.path === path && candidate.at >= sentAt - 5);
  if (entry === undefined) return 'the UI server never got it';
  if (entry.finished !== undefined) return `the UI server answered ${entry.status} ${entry.finished - sentAt} ms after it was sent`;
  if (entry.closed !== undefined) return `the UI server's connection closed ${entry.closed - sentAt} ms after it was sent, before the answer was written`;
  return `the UI server got it ${entry.at - sentAt} ms after it was sent and is still answering`;
}
