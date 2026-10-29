/*
 * The user's stdio MCP servers, started when a conversation first needs one.
 *
 * Claude Code starts every server of the user's config with each session,
 * whether the agent calls it or not. On 2026-10-17, 18 Claude sessions on one
 * Windows machine ran 38 Python processes for a Blender bridge, 22 for a code
 * search and 19 SSH bridges: 3 GB of private memory for tools most sessions
 * never called. Here a session reaches each of those servers over Streamable
 * HTTP at the core instead. The core answers the handshake and the lists from
 * what the same server answered last time, and starts the real server, under
 * the thread, on the first call that needs it. The session keeps that server
 * until the session ends, so a server's own state (a shell, a connection)
 * lasts as long as it did when the CLI ran it.
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { AGENT_ENV, type ThreadId } from '@boite/contracts';
import type { Core } from '../core.ts';
import { agentEnvOf } from '../agent.ts';
import type { SpawnedChild } from '../procs.ts';
import { LineSplitter, STDOUT_LINE_MAX } from '../drivers/lines.ts';

/** Where the sessions reach the servers: `<route><registration>/<server name>`. */
export const LAZY_MCP_ROUTE = '/mcp/lazy/';
/** Set to `0` in the core's environment to give sessions the servers as configured. */
export const LAZY_MCP_ENV = 'BOITE_LAZY_MCP';

/** A server of the user's config that runs as a child process speaking MCP on stdio. */
export interface StdioServer { command: string; args: string[]; env: Record<string, string> }
/** What the CLI is given in its place. */
export interface LazyServerEntry { type: 'http'; url: string; headers: Record<string, string> }

type Id = string | number;
interface Message {
  jsonrpc?: string;
  id?: Id | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** What a server answered, kept between sessions under its command line. */
interface Manifest {
  /** The version the client asked for; another one gets the real server's answer again. */
  protocolVersion: string;
  initialize: Record<string, unknown>;
  lists: Partial<Record<ListMethod, unknown>>;
}

const LIST_METHODS = ['tools/list', 'prompts/list', 'resources/list', 'resources/templates/list'] as const;
type ListMethod = typeof LIST_METHODS[number];
/** The capability a list belongs to: a server without it is never asked. */
const LIST_CAPABILITY: Record<ListMethod, string> = {
  'tools/list': 'tools',
  'prompts/list': 'prompts',
  'resources/list': 'resources',
  'resources/templates/list': 'resources',
};
const MANIFEST_KEY = 'mcp-manifest:';
/** An SSE comment this often keeps a long call's response under the server's 60 s idle timeout. */
const KEEPALIVE_MS = 15_000;
/** How long a starting server has to answer `initialize`. */
const START_TIMEOUT_MS = 60_000;
/** A server that does not leave once its stdin closed is stopped after this. */
const EXIT_GRACE_MS = 3_000;
/** The stderr a failed start reports, its end. */
const STDERR_TAIL = 2_000;

const encoder = new TextEncoder();

/** One `text/event-stream` response: messages, keepalive comments, an end. */
class EventStream {
  readonly response: Response;
  /** Requests this stream still owes an answer to. */
  owed = 0;
  closed = false;
  onClose: (() => void) | null = null;
  #controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  #keepalive: ReturnType<typeof setInterval>;

  constructor(headers: Record<string, string>) {
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => { this.#controller = controller; },
      cancel: () => this.end(),
    });
    this.#keepalive = setInterval(() => this.#write(': keepalive\n\n'), KEEPALIVE_MS);
    this.response = new Response(body, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', ...headers } });
  }

  send(message: Message): void { this.#write(`event: message\ndata: ${JSON.stringify(message)}\n\n`); }

  /** One owed answer went out; the stream of a POST ends with its last. */
  settle(): void {
    this.owed -= 1;
    if (this.owed <= 0) this.end();
  }

  end(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.#keepalive);
    try { this.#controller?.close(); } catch { /* the client left first */ }
    this.onClose?.();
  }

  #write(text: string): void {
    if (this.closed) return;
    try { this.#controller?.enqueue(encoder.encode(text)); } catch { this.end(); }
  }
}

/** The real server of one session, once started. */
interface Upstream {
  child: SpawnedChild;
  exited: boolean;
  stderr: string;
  initialize: Record<string, unknown> | null;
}

interface Waiting {
  /** The client's id, or null for a request the core makes itself. */
  clientId: Id | null;
  stream: EventStream | null;
  internal?: (message: Message) => void;
}

interface Registration {
  id: string;
  threadId: ThreadId;
  cwd: string;
  env: Record<string, string | undefined>;
  servers: Map<string, StdioServer>;
}

interface Session {
  id: string;
  registration: Registration;
  name: string;
  server: StdioServer;
  fingerprint: string;
  /** The client's `initialize` parameters, given to the real server when it starts. */
  clientInit: Record<string, unknown> | null;
  logLevel: unknown;
  upstream: Upstream | null;
  starting: Promise<Upstream> | null;
  pending: Map<number, Waiting>;
  /** Calls waiting for the server's start, by the client's id: a cancel that comes meanwhile drops the call. */
  queued: Map<Id, { cancelled: boolean }>;
  /** The client's GET streams, for what the server says outside any call. */
  listeners: Set<EventStream>;
  /** Open POST streams, newest last: a server request during a call goes to the call's stream. */
  calls: Set<EventStream>;
  /** The tools the client was given from the manifest, compared once the server runs. */
  servedTools: string | null;
}

/**
 * The servers of the user's config that run on stdio, by name, read from the
 * CLI's own user config: `.claude.json` under `CLAUDE_CONFIG_DIR`, else in
 * the home directory. A server the project turned off stays off.
 */
export function userStdioServers(configDir: string | undefined, cwd: string): Map<string, StdioServer> {
  const file = configDir ? join(configDir, '.claude.json') : join(homedir(), '.claude.json');
  const config = readConfig(file);
  const servers = new Map<string, StdioServer>();
  if (config === null || !isRecord(config.mcpServers)) return servers;
  const project = isRecord(config.projects) ? config.projects[resolve(cwd)] ?? config.projects[resolve(cwd).replaceAll('\\', '/')] : undefined;
  const disabled = new Set(isRecord(project) && Array.isArray(project.disabledMcpServers) ? project.disabledMcpServers.filter((name): name is string => typeof name === 'string') : []);
  for (const [name, entry] of Object.entries(config.mcpServers)) {
    if (!isRecord(entry) || disabled.has(name)) continue;
    if (entry.type !== undefined && entry.type !== 'stdio') continue;
    if (typeof entry.command !== 'string' || entry.command.length === 0) continue;
    const args = Array.isArray(entry.args) && entry.args.every((arg) => typeof arg === 'string') ? entry.args as string[] : [];
    const env = isRecord(entry.env) ? Object.fromEntries(Object.entries(entry.env).filter((pair): pair is [string, string] => typeof pair[1] === 'string')) : {};
    // The CLI expands `${VAR}` in a server's command, arguments and environment: such a server stays with it.
    if ([entry.command, ...args, ...Object.values(env)].some((value) => value.includes('${'))) continue;
    servers.set(name, { command: entry.command, args, env });
  }
  return servers;
}

/** The user's config holds every project's history and can weigh megabytes: read again only when it changed. */
const configCache = new Map<string, { stamp: string; config: Record<string, unknown> | null }>();
function readConfig(file: string): Record<string, unknown> | null {
  let stamp: string;
  try {
    const stat = statSync(file);
    stamp = `${stat.mtimeMs}:${stat.size}`;
  } catch { return null; }
  const cached = configCache.get(file);
  if (cached?.stamp === stamp) return cached.config;
  let config: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    config = isRecord(parsed) ? parsed : null;
  } catch { config = null; }
  configCache.set(file, { stamp, config });
  return config;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The same command line is the same server: its answers are reused under this key. */
export function fingerprintOf(server: StdioServer): string {
  return createHash('sha256').update(JSON.stringify([server.command, server.args, Object.entries(server.env).sort()])).digest('hex').slice(0, 32);
}

function bearer(header: string | null): string | null {
  const match = header === null ? null : /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

function failure(id: Id | null | undefined, code: number, message: string): Message {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

/** Why a server did not start, as the session's client reads it: the error's message, never its stack. */
function startFailure(session: Session, error: unknown): string {
  return error instanceof Error && error.message ? error.message : `the MCP server ${session.name} did not start`;
}

function isRequest(message: Message): boolean { return typeof message.method === 'string' && message.id !== undefined && message.id !== null; }
function isNotification(message: Message): boolean { return typeof message.method === 'string' && (message.id === undefined || message.id === null); }

export class LazyMcp {
  readonly #core: Core;
  readonly #registrations = new Map<string, Registration>();
  readonly #sessions = new Map<string, Session>();
  #ids = 0;
  /** The longest line a server may write on stdout. A test seam. */
  lineMax = STDOUT_LINE_MAX;

  constructor(core: Core) { this.#core = core; }

  /** Whether sessions get these servers through the core. */
  static enabled(env: Record<string, string | undefined> = process.env): boolean {
    return env[LAZY_MCP_ENV] !== '0';
  }

  /**
   * The servers a session is given in place of `servers`: one HTTP entry
   * each, reached with the thread's own agent token, which the CLI reads
   * from its environment so it never appears on a command line. `env` is the
   * environment the CLI itself gets; a server started later gets the same,
   * with its own variables on top, as the CLI would have given it.
   */
  register(threadId: ThreadId, cwd: string, env: Record<string, string | undefined>, servers: Map<string, StdioServer>): { id: string; entries: Record<string, LazyServerEntry> } {
    const id = randomUUID();
    this.#registrations.set(id, { id, threadId, cwd, env, servers });
    const base = this.#core.baseUrl();
    const entries: Record<string, LazyServerEntry> = {};
    for (const name of servers.keys()) {
      entries[name] = {
        type: 'http',
        url: `${base}${LAZY_MCP_ROUTE}${id}/${encodeURIComponent(name)}`,
        headers: { Authorization: `Bearer \${${AGENT_ENV.token}}` },
      };
    }
    return { id, entries };
  }

  /** The session that used this registration ended: its servers go with it. */
  release(id: string): void {
    if (!this.#registrations.delete(id)) return;
    for (const session of [...this.#sessions.values()]) if (session.registration.id === id) this.#end(session);
  }

  close(): void {
    for (const session of [...this.#sessions.values()]) this.#end(session);
    this.#registrations.clear();
  }

  /** How many real servers run now, for tests and diagnostics. */
  running(): number {
    let count = 0;
    for (const session of this.#sessions.values()) if (session.upstream !== null && !session.upstream.exited) count += 1;
    return count;
  }

  async http(request: Request, path: string): Promise<Response> {
    const token = bearer(request.headers.get('authorization'));
    const threadId = token === null ? null : this.#core.agents.authenticate(token);
    if (threadId === null) return new Response('a lazy MCP server answers only the agent token of its thread', { status: 401 });
    const slash = path.indexOf('/');
    const registration = slash < 0 ? undefined : this.#registrations.get(path.slice(0, slash));
    if (registration === undefined || registration.threadId !== threadId) return new Response('this MCP registration ended with its session', { status: 404 });
    let name: string;
    try { name = decodeURIComponent(path.slice(slash + 1)); } catch { return new Response('the server name is not URL-encoded', { status: 400 }); }
    const server = registration.servers.get(name);
    if (server === undefined) return new Response(`no MCP server named ${name} in this session`, { status: 404 });
    if (request.method === 'POST') return this.#post(request, registration, name, server);
    const session = this.#session(request, registration, name);
    if (request.method === 'GET') {
      if (session === null) return new Response('unknown or ended MCP session', { status: 404 });
      return this.#listen(session);
    }
    if (request.method === 'DELETE') {
      if (session !== null) this.#end(session);
      return new Response(null, { status: 204 });
    }
    return new Response('method not allowed', { status: 405, headers: { allow: 'GET, POST, DELETE' } });
  }

  #session(request: Request, registration: Registration, name: string): Session | null {
    const id = request.headers.get('mcp-session-id');
    const session = id === null ? undefined : this.#sessions.get(id);
    return session !== undefined && session.registration === registration && session.name === name ? session : null;
  }

  async #post(request: Request, registration: Registration, name: string, server: StdioServer): Promise<Response> {
    let body: unknown;
    try { body = await request.json(); } catch { return json(failure(null, -32700, 'the body is not JSON'), 400); }
    // The session may have ended while its body came: nothing starts for a released registration.
    if (this.#registrations.get(registration.id) !== registration) return new Response('this MCP registration ended with its session', { status: 404 });
    const messages = (Array.isArray(body) ? body : [body]).filter(isRecord) as Message[];
    if (messages.length === 0) return json(failure(null, -32600, 'expected a JSON-RPC message'), 400);

    const init = messages.find((message) => message.method === 'initialize');
    if (init !== undefined) return this.#initialize(registration, name, server, init);
    // The stateless handshake of the 2026 protocol: this proxy speaks the session one, which the client falls back to.
    if (messages.length === 1 && messages[0]!.method === 'server/discover') return json(failure(messages[0]!.id, -32601, 'Method not found'));

    const session = this.#session(request, registration, name);
    if (session === null) return json(failure(null, -32001, 'unknown or ended MCP session'), 404);

    for (const message of messages) if (!isRequest(message)) this.#fromClient(session, message);
    const requests = messages.filter(isRequest);
    if (requests.length === 0) return new Response(null, { status: 202 });

    const answers: Message[] = [];
    const forwarded: Message[] = [];
    for (const message of requests) {
      const answer = this.#answer(session, message);
      if (answer === null) forwarded.push(message); else answers.push(answer);
    }
    const headers = { 'mcp-session-id': session.id };
    if (forwarded.length === 0) return json(Array.isArray(body) ? answers : answers[0], 200, headers);

    const stream = new EventStream(headers);
    session.calls.add(stream);
    stream.onClose = () => session.calls.delete(stream);
    for (const answer of answers) stream.send(answer);
    stream.owed = forwarded.length;
    for (const message of forwarded) void this.#forward(session, message, stream);
    return stream.response;
  }

  async #initialize(registration: Registration, name: string, server: StdioServer, message: Message): Promise<Response> {
    const session: Session = {
      id: randomUUID(),
      registration,
      name,
      server,
      fingerprint: fingerprintOf(server),
      clientInit: isRecord(message.params) ? message.params : {},
      logLevel: undefined,
      upstream: null,
      starting: null,
      pending: new Map(),
      queued: new Map(),
      listeners: new Set(),
      calls: new Set(),
      servedTools: null,
    };
    // A CLI that starts again for the same thread opens a new session: the old one's server goes.
    for (const old of [...this.#sessions.values()]) if (old.registration === registration && old.name === name) this.#end(old);
    this.#sessions.set(session.id, session);
    const headers = { 'mcp-session-id': session.id };
    const manifest = this.#manifest(session.fingerprint);
    if (manifest !== null && manifest.protocolVersion === session.clientInit?.protocolVersion) {
      return json({ jsonrpc: '2.0', id: message.id, result: manifest.initialize }, 200, headers);
    }
    // Never seen with this protocol version: the real server answers, and stays.
    try {
      const upstream = await this.#ensure(session);
      return json({ jsonrpc: '2.0', id: message.id, result: upstream.initialize }, 200, headers);
    } catch (error) {
      this.#end(session);
      return json(failure(message.id, -32603, startFailure(session, error)), 200);
    }
  }

  /** What the core answers without the server: a ping and the lists, while the server is not running. */
  #answer(session: Session, message: Message): Message | null {
    if (this.#live(session)) return null;
    const method = message.method as string;
    if (method === 'ping') return { jsonrpc: '2.0', id: message.id!, result: {} };
    if (method === 'logging/setLevel') {
      session.logLevel = message.params?.level;
      return { jsonrpc: '2.0', id: message.id!, result: {} };
    }
    if ((LIST_METHODS as readonly string[]).includes(method) && message.params?.cursor === undefined) {
      const manifest = this.#manifest(session.fingerprint);
      const result = manifest?.lists[method as ListMethod];
      if (result === undefined) return null;
      if (method === 'tools/list') session.servedTools = JSON.stringify(result);
      return { jsonrpc: '2.0', id: message.id!, result };
    }
    return null;
  }

  /** A notification, or the client's answer to a server request. */
  #fromClient(session: Session, message: Message): void {
    // The core says it to the real server itself, right after its handshake.
    if (message.method === 'notifications/initialized') return;
    const requestId = message.params?.requestId;
    if (message.method === 'notifications/cancelled' && (typeof requestId === 'string' || typeof requestId === 'number')) {
      const queued = session.queued.get(requestId);
      if (queued !== undefined) { queued.cancelled = true; return; }
    }
    if (!this.#live(session)) return;
    if (message.method === 'notifications/cancelled') {
      for (const [internal, waiting] of session.pending) {
        if (waiting.clientId !== requestId) continue;
        this.#send(session, { ...message, params: { ...message.params, requestId: internal } });
        return;
      }
      return;
    }
    if (isNotification(message) || message.result !== undefined || message.error !== undefined) this.#send(session, message);
  }

  async #forward(session: Session, message: Message, stream: EventStream): Promise<void> {
    const queued = { cancelled: false };
    session.queued.set(message.id!, queued);
    try { await this.#ensure(session); } catch (error) {
      if (!queued.cancelled) stream.send(failure(message.id, -32603, startFailure(session, error)));
      stream.settle();
      return;
    } finally {
      if (session.queued.get(message.id!) === queued) session.queued.delete(message.id!);
    }
    // A cancelled request gets no answer, and the server never sees it.
    if (queued.cancelled) { stream.settle(); return; }
    const internal = ++this.#ids;
    session.pending.set(internal, { clientId: message.id!, stream });
    this.#send(session, { ...message, id: internal });
  }

  /** A server is live once its handshake ended: a call that comes during it waits for `starting`. */
  #live(session: Session): boolean { return session.upstream !== null && !session.upstream.exited && session.upstream.initialize !== null; }

  #ensure(session: Session): Promise<Upstream> {
    if (this.#live(session)) return Promise.resolve(session.upstream!);
    session.starting ??= this.#start(session).finally(() => { session.starting = null; });
    return session.starting;
  }

  async #start(session: Session): Promise<Upstream> {
    const { registration, server } = session;
    const child = this.#core.procs.spawnChild(registration.threadId, server.command, server.args, {
      cwd: registration.cwd,
      env: agentEnvOf(this.#core, registration.threadId, { ...registration.env, ...server.env }),
      agentRoot: false,
    });
    const upstream: Upstream = { child, exited: false, stderr: '', initialize: null };
    session.upstream = upstream;
    const gone = (reason = `the MCP server ${session.name} exited${upstream.stderr.trim() ? `: ${upstream.stderr.trim().slice(-500)}` : ''}`): void => {
      if (upstream.exited) return;
      upstream.exited = true;
      // A server that failed its start and was replaced leaves its successor's calls alone.
      if (session.upstream !== null && session.upstream !== upstream) return;
      for (const [internal, waiting] of session.pending) {
        session.pending.delete(internal);
        if (waiting.internal) waiting.internal(failure(internal, -32603, reason));
        else if (waiting.stream) { waiting.stream.send(failure(waiting.clientId, -32603, reason)); waiting.stream.settle(); }
      }
    };
    child.once('exit', () => gone());
    child.once('error', () => gone());
    // A line past the bound is no protocol line: the server is done, and so are the calls it owed.
    let faulted = false;
    const lines = new LineSplitter((line) => {
      let message: unknown;
      try { message = JSON.parse(line); } catch { return; } // a server that logs on stdout
      if (isRecord(message)) this.#fromServer(session, upstream, message as Message);
    }, {
      maxLine: this.lineMax,
      onOverflow: () => {
        faulted = true;
        gone(`the MCP server ${session.name} wrote a line past ${this.lineMax} characters on stdout`);
        void this.#core.procs.stopChild(child);
      },
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { if (!faulted) lines.feed(chunk); });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { upstream.stderr = (upstream.stderr + chunk).slice(-STDERR_TAIL); });
    child.stdin.on('error', () => { /* the server left; its exit says so */ });

    const answer = await this.#call(session, 'initialize', session.clientInit ?? {}, START_TIMEOUT_MS);
    if (answer.error !== undefined || !isRecord(answer.result)) {
      this.#stop(upstream);
      throw new Error(`the MCP server ${session.name} did not start: ${answer.error?.message ?? 'no initialize result'}`);
    }
    upstream.initialize = answer.result;
    this.#send(session, { jsonrpc: '2.0', method: 'notifications/initialized' });
    if (session.logLevel !== undefined) void this.#call(session, 'logging/setLevel', { level: session.logLevel });
    void this.#refresh(session, answer.result);
    return upstream;
  }

  /** Reads the lists of a server that just started, keeps them for the next sessions, and tells this one when its tools changed. */
  async #refresh(session: Session, initialize: Record<string, unknown>): Promise<void> {
    const capabilities = isRecord(initialize.capabilities) ? initialize.capabilities : {};
    const lists: Manifest['lists'] = {};
    for (const method of LIST_METHODS) {
      if (capabilities[LIST_CAPABILITY[method]] === undefined) continue;
      const answer = await this.#call(session, method, {});
      // A list in pages is not kept: the client asks the running server for the rest.
      if (answer.error === undefined && isRecord(answer.result) && answer.result.nextCursor === undefined) lists[method] = answer.result;
    }
    const protocolVersion = session.clientInit?.protocolVersion;
    if (typeof protocolVersion === 'string') this.#save(session.fingerprint, { protocolVersion, initialize, lists });
    if (session.servedTools !== null && lists['tools/list'] !== undefined && JSON.stringify(lists['tools/list']) !== session.servedTools) {
      this.#notify(session, { jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
    }
  }

  #call(session: Session, method: string, params: Record<string, unknown>, timeoutMs = 0): Promise<Message> {
    const internal = ++this.#ids;
    return new Promise((done) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const finish = (message: Message): void => {
        if (timer !== null) clearTimeout(timer);
        session.pending.delete(internal);
        done(message);
      };
      session.pending.set(internal, { clientId: null, stream: null, internal: finish });
      if (timeoutMs > 0) timer = setTimeout(() => finish(failure(internal, -32603, `no answer to ${method} within ${timeoutMs / 1000} s`)), timeoutMs);
      if (!this.#send(session, { jsonrpc: '2.0', id: internal, method, params })) finish(failure(internal, -32603, `the MCP server ${session.name} is not running`));
    });
  }

  #send(session: Session, message: Message): boolean {
    const upstream = session.upstream;
    if (upstream === null || upstream.exited || !upstream.child.stdin.writable) return false;
    upstream.child.stdin.write(`${JSON.stringify(message)}\n`);
    return true;
  }

  #fromServer(session: Session, upstream: Upstream, message: Message): void {
    if (message.method === undefined && message.id !== undefined && message.id !== null) {
      const waiting = typeof message.id === 'number' ? session.pending.get(message.id) : undefined;
      if (waiting === undefined) return;
      session.pending.delete(message.id as number);
      if (waiting.internal) { waiting.internal(message); return; }
      waiting.stream?.send({ ...message, id: waiting.clientId! });
      waiting.stream?.settle();
      return;
    }
    if (typeof message.method !== 'string') return;
    if (message.method === 'notifications/tools/list_changed' && session.upstream === upstream) void this.#relist(session);
    if (!this.#notify(session, message) && isRequest(message)) this.#send(session, failure(message.id, -32601, 'the client has no stream open for server requests'));
  }

  /** The server's tools changed while it runs: the next sessions get the new list. */
  async #relist(session: Session): Promise<void> {
    const manifest = this.#manifest(session.fingerprint);
    if (manifest === null) return;
    const answer = await this.#call(session, 'tools/list', {});
    if (answer.error === undefined && isRecord(answer.result) && answer.result.nextCursor === undefined) {
      this.#save(session.fingerprint, { ...manifest, lists: { ...manifest.lists, 'tools/list': answer.result } });
    }
  }

  /** What the server says outside an answer goes to the client's GET stream, else to the newest open call. */
  #notify(session: Session, message: Message): boolean {
    const target = [...session.listeners].find((stream) => !stream.closed) ?? [...session.calls].reverse().find((stream) => !stream.closed);
    if (target === undefined) return false;
    target.send(message);
    return true;
  }

  #listen(session: Session): Response {
    const stream = new EventStream({ 'mcp-session-id': session.id });
    session.listeners.add(stream);
    stream.onClose = () => session.listeners.delete(stream);
    return stream.response;
  }

  #end(session: Session): void {
    this.#sessions.delete(session.id);
    for (const stream of [...session.listeners, ...session.calls]) stream.end();
    if (session.upstream !== null) this.#stop(session.upstream);
    session.upstream = null;
  }

  /** Closing stdin is how an MCP client says goodbye; a server still there after the grace is stopped. */
  #stop(upstream: Upstream): void {
    if (upstream.exited) return;
    try { upstream.child.stdin.end(); } catch { /* already closed */ }
    const timer = setTimeout(() => { if (!upstream.exited) void this.#core.procs.stopChild(upstream.child); }, EXIT_GRACE_MS);
    timer.unref?.();
  }

  #manifest(fingerprint: string): Manifest | null {
    const value = this.#core.journal.getSetting(`${MANIFEST_KEY}${fingerprint}`);
    if (!isRecord(value) || typeof value.protocolVersion !== 'string' || !isRecord(value.initialize) || !isRecord(value.lists)) return null;
    return value as unknown as Manifest;
  }

  #save(fingerprint: string, manifest: Manifest): void {
    if (this.#core.journal.isClosed()) return;
    this.#core.journal.setSetting(`${MANIFEST_KEY}${fingerprint}`, manifest);
  }
}
