import {randomBytes} from 'node:crypto';
import {mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, symlinkSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {rm} from 'node:fs/promises';
import {join} from 'node:path';
import type {SessionContext, TurnContext} from './types.ts';
import {PROTECTED_TOOL, PROTECTED_COMMIT, PROTECTED_DESCRIPTION, PROTECTED_SCHEMA, PROTECTED_COMMIT_DESCRIPTION, protectedTool, protectedCommit} from './protected.ts';

export const protectedDefinitions = [
  {name: PROTECTED_TOOL, description: PROTECTED_DESCRIPTION, inputSchema: PROTECTED_SCHEMA},
  {name: PROTECTED_COMMIT, description: PROTECTED_COMMIT_DESCRIPTION, inputSchema: {type: 'object', additionalProperties: false, properties: {message: {type: 'string', minLength: 1, maxLength: 500}}, required: ['message']}},
];
export type ProtectedHead = () => {ctx: TurnContext; stopped: Promise<unknown>} | null;

/** A private native-extension channel. Model tools have neither its token nor host networking. */
export function protectedBridge(ctx: SessionContext, head: ProtectedHead) {
  if (!ctx.protectedExecution) throw new Error('execution.bridge: requires a captured capability');
  ctx.protectedExecution.check();
  const token = randomBytes(32).toString('base64url');
  const directory = mkdtempSync(join(tmpdir(), 'boite-native-control-'));
  mkdirSync(join(directory, 'workspace'));
  let closed = false, ready = false, mcpReady = false;
  const definitions = ctx.protectedExecution.toolsAllowed === false ? [] : protectedDefinitions;
  const server = Bun.serve({hostname: '127.0.0.1', port: 0, maxRequestBodySize: 16 * 1024 * 1024, async fetch(request) {
    if (closed || request.method !== 'POST' || request.headers.has('origin') || request.headers.get('authorization') !== `Bearer ${token}`) return new Response(null, {status: 403});
    let envelope: Record<string, unknown> | undefined;
    try {
      ctx.protectedExecution!.check();
      const body = await request.json() as Record<string, unknown>;
      envelope = body;
      if (new URL(request.url).pathname === '/ready') {
        if (body['fingerprint'] !== ctx.protectedExecution!.fingerprint) throw new Error('execution.bridge: stale native extension');
        ready = true; return Response.json({ready: true});
      }
      const mcp = new URL(request.url).pathname === '/mcp';
      const reply = (result: unknown) => Response.json({jsonrpc: '2.0', id: body['id'], result});
      if (mcp) {
        if (body['method'] === 'initialize') return reply({protocolVersion: '2025-03-26', capabilities: {tools: {}}, serverInfo: {name: 'boite_protected', version: '1.0.0'}});
        if (body['method'] === 'notifications/initialized' || body['method'] === 'notifications/cancelled') return new Response(null, {status: 202});
        if (body['method'] === 'tools/list') {mcpReady = true; return reply({tools: definitions});}
        if (body['method'] === 'ping') return reply({});
        if (body['method'] !== 'tools/call') return Response.json({jsonrpc: '2.0', id: body['id'], error: {code: -32601, message: 'Protected MCP method unavailable'}});
      }
      const turn = head();
      if (!turn || turn.ctx.protectedExecution?.fingerprint !== ctx.protectedExecution!.fingerprint) throw new Error('execution.bridge: no matching active protected turn');
      const params = mcp ? body['params'] as Record<string, unknown> : body;
      const input = params?.[mcp ? 'arguments' : 'input'];
      const result = params?.['name'] === PROTECTED_TOOL ? await protectedTool(turn.ctx, input, turn.stopped)
        : params?.['name'] === PROTECTED_COMMIT ? await protectedCommit(turn.ctx, input, turn.stopped)
        : {success: false, contentItems: [{type: 'inputText', text: 'execution.bridge: unprotected tool refused'}]};
      if (mcp) return reply({isError: !result.success, content: result.contentItems.map(item => ({type: 'text', text: item.text}))});
      return Response.json(result);
    } catch (error) {
      if (new URL(request.url).pathname === '/mcp') return Response.json({jsonrpc: '2.0', id: envelope?.['id'] ?? null, error: {code: -32000, message: error instanceof Error ? error.message : 'execution.bridge: refused'}});
      return Response.json({success: false, contentItems: [{type: 'inputText', text: error instanceof Error ? error.message : 'execution.bridge: refused'}]});
    }
  }});
  return {
    directory, cwd: join(directory, 'workspace'), definitions,
    url: `http://127.0.0.1:${server.port}`, token,
    /** Only fixed core code is written here; no model text becomes executable control code. */
    asset(name: string, code: string) {const path = join(directory, name); writeFileSync(path, code, {mode: 0o600}); return path;},
    assertReady() {ctx.protectedExecution!.check(); if (!ready) throw new Error('execution.extension: native protection extension did not initialize; no unprotected fallback');},
    assertMcpReady() {ctx.protectedExecution!.check(); if (!mcpReady) throw new Error('execution.mcp: native host did not initialize protected tools; no unprotected fallback');},
    close(released?: Promise<unknown>) {
      if (closed) return;
      closed = true; server.stop(true);
      // Windows retains a native process's cwd until exit. Revoke the channel
      // now, then remove its files after the captured control process releases it.
      if (released) void released.catch(() => {}).then(() => rm(directory, {recursive: true, force: true, maxRetries: 10, retryDelay: 50}))
        .catch(error => ctx.log('error', `execution.bridge.cleanup: ${error instanceof Error ? error.message : String(error)}`));
      else rmSync(directory, {recursive: true, force: true});
    },
  };
}
export type ProtectedBridge = ReturnType<typeof protectedBridge>;

/** A preload can execute a model-edited project file before a native extension can gate it. */
export function protectedControlEnvironment(ctx: SessionContext): Record<string, string | undefined> {
  const env = {...process.env, ...ctx.accountEnv};
  for (const name of ['NODE_OPTIONS', 'BUN_OPTIONS', 'BUN_PRELOAD', 'NODE_PATH', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'DYLD_INSERT_LIBRARIES']) {
    if (env[name]) throw new Error(`execution.control.env.${name}: executable preloads and module search overrides require an explicitly protected control implementation`);
  }
  return env;
}

/** Native auth stays on the selected account, while discovery sees only core-owned configuration. */
export function linkAccountFiles(source: string, destination: string, names: string[]): void {
  mkdirSync(destination, {recursive: true});
  for (const name of names) if (existsSync(join(source, name))) symlinkSync(join(source, name), join(destination, name));
}

/** Selection defaults are data. Executable resources, commands, MCP and hooks never follow them. */
export function selectionSettings(path: string, names: string[]): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const settings = Bun.JSON5.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error(`execution.config.${path}: expected an object`);
  return Object.fromEntries(names.filter(name => settings[name] !== undefined).map(name => [name, settings[name]]));
}
