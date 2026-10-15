import pkg from '../../../package.json';
import { messageOf, unavailable } from '../../errors.ts';
import { profileFor, resolveExecutable } from '../../providers/resolve.ts';
import { titleRequest } from '../../titles.ts';
import type { TitleContext } from '../types.ts';
import { subscriptionProxyCodexArgs } from '../../subscription-proxy.ts';
import { imageInputsOf, textOf } from './mapping.ts';
import type { CodexThreadOpened, CodexTurnRecord, Timer } from './protocol.ts';
import { AGENT_OWN_MODEL, CLIENT_NAME, NO_PLUGINS, STDERR_MAX } from './protocol.ts';
import { CodexRpc } from './rpc.ts';

/** How long one title call may take before its app-server is dropped. */
const TITLE_TIMEOUT_MS = 30_000;

/**
 * The `thread/start` override that turns off every MCP server the effective
 * config of `cwd` declares, read with `config/read` on the title's own
 * app-server. Each server is named, since an override of `mcp_servers` merges
 * into the user's servers rather than replacing them, and nested so a name with
 * a dot stays one key. A server already off is left out. An app-server that
 * cannot answer leaves the servers on: the title still gets written.
 */
async function mcpServersOff(rpc: CodexRpc, ctx: TitleContext): Promise<Record<string, { enabled: false }> | null> {
  try {
    const read = await rpc.request<{ config?: { mcp_servers?: Record<string, { enabled?: boolean } | null> | null } }>('config/read', { cwd: ctx.thread.cwd });
    const off: Record<string, { enabled: false }> = {};
    for (const [name, server] of Object.entries(read?.config?.mcp_servers ?? {})) {
      if (server?.enabled !== false) off[name] = { enabled: false };
    }
    return Object.keys(off).length === 0 ? null : off;
  } catch (error) {
    ctx.log('warn', `codex title: config/read failed, so the MCP servers of ${ctx.thread.cwd} start for this title: ${messageOf(error)}`);
    return null;
  }
}

/**
 * One short-lived `codex app-server` on an ephemeral thread: nothing is written
 * to Codex's own history, the sandbox is read-only, nothing is asked, and the
 * effort is low. No MCP server, plugin or app starts for it: the user's
 * servers would otherwise launch with every title, branch name and retitle,
 * and could act on the prompt. The agent message of that one turn is the title, as the model
 * wrote it; the core applies its one cleaning rule. A turn that fails is
 * thrown with Codex's own sentence.
 */
export async function titleTurn(ctx: TitleContext): Promise<string | null> {
  const profile = profileFor(ctx.provider);
  const executable = profile === undefined ? null : resolveExecutable(profile);
  if (executable === null) {
    throw unavailable(`no ${ctx.provider.id} executable on this machine`, { providerId: ctx.provider.id });
  }

  let lastStderr = '';
  const child = ctx.spawnChild(executable, [...subscriptionProxyCodexArgs(profile?.launch?.args ?? [], ctx.accountEnv), ...NO_PLUGINS], {
    cwd: ctx.thread.cwd,
    env: { ...process.env, ...ctx.accountEnv },
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    for (const line of chunk.split(/\r?\n/)) {
      const text = line.trim();
      if (text.length > 0) lastStderr = text.slice(0, STDERR_MAX);
    }
  });
  const say = (head: string): string => (lastStderr.length === 0 ? head : `${head}: ${lastStderr}`);

  let text = '';
  let settle: ((record: CodexTurnRecord) => void) | null = null;
  const completed = new Promise<CodexTurnRecord>((resolve) => {
    settle = resolve;
  });
  const rpc = new CodexRpc(child, {
    notification: (method, params) => {
      const body = (params ?? {}) as Record<string, unknown>;
      if (method === 'item/agentMessage/delta') text += textOf(body['delta']);
      else if (method === 'turn/completed' && body['turn'] !== undefined) settle?.(body['turn'] as CodexTurnRecord);
    },
    // Read-only and `never`: the server has nothing to ask a title call.
    request: (method) => Promise.reject(new Error(`a title call answers no ${method}`)),
    log: (level, message, context) => {
      ctx.log(level, message, context);
    },
  });

  let timer: Timer | null = null;
  try {
    const died = new Promise<never>((_resolve, reject) => {
      child.once('exit', (code) => {
        reject(new Error(say(`the ${ctx.provider.id} agent exited with code ${code ?? 'unknown'}`)));
      });
      child.once('error', (error) => {
        reject(new Error(say(`the ${ctx.provider.id} agent did not start: ${messageOf(error)}`)));
      });
    });
    const expired = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`the ${ctx.provider.id} agent wrote no title in ${TITLE_TIMEOUT_MS / 1000} s`));
      }, TITLE_TIMEOUT_MS);
      timer.unref?.();
    });

    const model = ctx.model === null || ctx.model === AGENT_OWN_MODEL ? null : ctx.model;
    const run = (async (): Promise<string | null> => {
      await rpc.request('initialize', {
        clientInfo: { name: CLIENT_NAME, title: null, version: pkg.version },
        capabilities: null,
      });
      rpc.notify('initialized', {});
      const servers = await mcpServersOff(rpc, ctx);
      const opened = await rpc.request<CodexThreadOpened>('thread/start', {
        cwd: ctx.thread.cwd,
        approvalPolicy: 'never',
        sandbox: 'read-only',
        ephemeral: true,
        ...(model === null ? {} : { model }),
        ...(servers === null ? {} : { config: { mcp_servers: servers } }),
      });
      const started = await rpc.request<{ turn: CodexTurnRecord }>('turn/start', {
        threadId: opened.thread.id,
        input: [{ type: 'text', text: titleRequest(ctx.prompt, ctx.answer, ctx.initial, ctx.nameBranch), text_elements: [] }, ...imageInputsOf(ctx.attachments ?? [])],
        ...(model === null ? {} : { model }),
        effort: 'low',
      });
      const record = started.turn.status === 'inProgress' ? await completed : started.turn;
      if (record.status === 'failed') throw new Error(record.error?.message ?? 'Codex failed the title turn.');
      if (record.status !== 'completed') return null;
      return text;
    })();

    return await Promise.race([run, died, expired]);
  } finally {
    if (timer !== null) clearTimeout(timer);
    rpc.fail('the title call is over');
    try {
      child.stdin.end();
    } catch {
      // the pipe is already gone
    }
    child.kill();
  }
}
