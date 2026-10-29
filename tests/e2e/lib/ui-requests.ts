import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

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
interface Listening { listening: boolean; address(): AddressInfo | string | null; once(event: 'listening', listener: () => void): unknown }
interface WithMiddlewares { middlewares: { use(handler: Middleware): unknown }; httpServer?: Listening | null }

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

/**
 * Added first, so it sees every request, the ones Vite's own middlewares answer
 * included. The port is known once the server listens, not at its first
 * request: a server that got nothing yet is still told apart from a core.
 */
function track(server: WithMiddlewares): void {
  server.middlewares.use(record);
  const http = server.httpServer;
  if (!http) return;
  const register = () => { const address = http.address(); if (address !== null && typeof address === 'object') ports.add(address.port); };
  if (http.listening) register();
  else http.once('listening', register);
}

export const requestLog = {
  name: 'boite-e2e-request-log',
  configureServer: track,
  configurePreviewServer: track,
};

/** Chrome's `wallTime` and `Date.now()` read the same system clock, in ticks that can be coarse on Windows. */
const CLOCK_SLACK_MS = 50;

function relative(time: number, reference: number, what: string): string {
  const ms = time - reference;
  return `${Math.abs(ms)} ms ${ms < 0 ? 'before' : 'after'} ${what}`;
}

function describe(entry: Served, reference: number, what: string): string {
  if (entry.finished !== undefined) return `the UI server answered ${entry.status} ${relative(entry.finished, reference, what)}`;
  if (entry.closed !== undefined) return `the UI server's connection closed ${relative(entry.closed, reference, what)}, before the answer was written`;
  return `the UI server got it ${relative(entry.at, reference, what)} and is still answering`;
}

/**
 * The UI server's side of a request Chrome sent at `sentAt` (its `wallTime`),
 * or null when no server of this process listens on its port (a core serves
 * that page). Without a send time, only the newest record of the path can be
 * told, against `receivedAt`, when its devtools event reached us: that event
 * can come after the server answered, so no window can rule the server out.
 * Matching a path and time window cannot identify a CDP request: concurrent
 * same-URL requests can share a record, so every candidate is labelled.
 */
export function uiServerSide(url: string, sentAt: number | null, receivedAt: number): string | null {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return null; }
  const port = Number(parsed.port);
  if (!ports.has(port)) return null;
  const path = parsed.pathname + parsed.search;
  if (sentAt === null) {
    const newest = served.findLast((candidate) => candidate.port === port && candidate.path === path);
    if (newest === undefined) return 'the UI server has no record of it';
    return `no send time; newest record (request identity unverified): ${describe(newest, receivedAt, 'devtools reported it')}`;
  }
  // The server cannot see it before Chrome sent it.
  const entry = served.findLast((candidate) => candidate.port === port && candidate.path === path && candidate.at >= sentAt - CLOCK_SLACK_MS);
  if (entry === undefined) return 'the UI server never got it';
  return `possible server match (request identity unverified): ${describe(entry, sentAt, 'it was sent')}`;
}
