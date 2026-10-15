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
import { mcpServersOff, readConfig } from './config.ts';

/** How long one title call may take before its app-server is dropped. */
const TITLE_TIMEOUT_MS = 30_000;

/**
 * One short-lived `codex app-server` on an ephemeral thread: nothing is written
 * to Codex's own history, the sandbox is read-only, nothing is asked, and the
 * effort is low. No MCP server, plugin or app starts for it: the user's
 * servers would otherwise launch with every title, branch name and retitle,
 * and could act on the prompt. A Codex that cannot list them through
 * `config/read` writes no title. The agent message of that one turn is the title, as the model
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
      // No answer means no way to turn the servers off: the title fails rather
      // than start them, and the thread keeps the title it has.
      const config = await readConfig(rpc, ctx.thread.cwd).catch((error: unknown) => {
        throw new Error(`codex did not answer config/read, so its MCP servers could not be kept off for a title: ${messageOf(error)}`);
      });
      const servers = mcpServersOff(config);
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
