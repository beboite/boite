import pkg from '../../../package.json';
import { unavailable } from '../../errors.ts';
import { profileFor, resolveExecutable } from '../../providers/resolve.ts';
import type { ForkedSession, SessionContext } from '../types.ts';
import { exitWithin } from '../exit.ts';
import { NativeForkUnsupported } from '../native-fork.ts';
import { modelOf } from './mapping.ts';
import { CLIENT_NAME, MODE_POLICY } from './protocol.ts';
import { CodexRpc, CodexRpcError } from './rpc.ts';

const FORK_TIMEOUT_MS = 30_000;

/** Codex lastTurnId is inclusive. Never reads a native transcript or starts a model turn. */
export async function forkSession(ctx: SessionContext, checkpoint: { sessionId: string; entry: string }): Promise<ForkedSession> {
  const profile = profileFor(ctx.provider);
  const executable = profile === undefined ? null : resolveExecutable(profile);
  if (executable === null) throw unavailable(`no ${ctx.provider.id} executable on this machine`, { providerId: ctx.provider.id });
  const args = [...(profile?.launch?.args ?? []), ...(ctx.thread.permissionMode === 'yolo' ? ['--config', 'features.hooks=false'] : [])];
  const child = ctx.spawnChild(executable, args, { startup: true, cwd: ctx.thread.cwd, env: { ...process.env, ...ctx.accountEnv } });
  const exited = new Promise<number | null>(resolve => { child.once('exit', resolve); child.once('error', () => resolve(null)); });
  const rpc = new CodexRpc(child, {
    notification: () => undefined,
    request: method => Promise.reject(new Error(`native fork answers no ${method}`)),
    log: ctx.log,
  });
  // Drain stderr even when this setup request produces no turn sink.
  child.stderr.resume();
  let released = false;
  const release = async (): Promise<void> => {
    if (released) return;
    released = true;
    rpc.fail('the native fork setup is over');
    try { child.stdin.end(); } catch { /* The child may already have closed its input. */ }
    await child.kill();
    const exit = await exitWithin(exited, 1_000);
    ctx.finishStartup?.();
    if (exit === undefined) throw new Error('native fork setup process exit was not confirmed');
  };
  try {
    await rpc.request('initialize', { clientInfo: { name: CLIENT_NAME, title: null, version: pkg.version }, capabilities: null }, { timeoutMs: FORK_TIMEOUT_MS });
    rpc.notify('initialized', {});
    const policy = MODE_POLICY[ctx.thread.permissionMode];
    const model = modelOf(ctx);
    const answer = await rpc.request<{ thread: { id: string } }>('thread/fork', {
      threadId: checkpoint.sessionId,
      lastTurnId: checkpoint.entry,
      excludeTurns: true,
      cwd: ctx.thread.cwd,
      approvalPolicy: policy.approvalPolicy,
      sandbox: policy.sandbox,
      ...(model === null ? {} : { model }),
      config: { 'tools.update_plan.enabled': true },
    }, { timeoutMs: FORK_TIMEOUT_MS });
    const sessionId = answer?.thread?.id;
    if (typeof sessionId !== 'string' || !sessionId.length || sessionId === checkpoint.sessionId) {
      throw new Error('thread/fork.thread.id: expected a new native session id distinct from the source');
    }
    try {
      // Older servers silently ignore lastTurnId. Prove the retained boundary
      // using one newest summary, never hydrating the native transcript.
      const retained = await rpc.request<{ data: { id: string }[] }>('thread/turns/list', {
        threadId: sessionId, limit: 1, sortDirection: 'desc', itemsView: 'summary',
      }, { timeoutMs: FORK_TIMEOUT_MS });
      if (!Array.isArray(retained?.data) || retained.data.length !== 1 || retained.data[0]?.id !== checkpoint.entry) {
        throw new Error('thread/fork boundary: expected the requested lastTurnId as the newest retained native turn');
      }
    } catch (error) {
      let archived = false;
      try { await rpc.request('thread/archive', { threadId: sessionId }, { timeoutMs: FORK_TIMEOUT_MS }); archived = true; }
      catch (cleanup) { ctx.log('warn', `unverified native fork archive failed: ${String(cleanup)}`); }
      if (archived && error instanceof CodexRpcError && error.code === -32601) {
        await release();
        throw new NativeForkUnsupported('this Codex appserver does not support bounded native fork verification');
      }
      throw error;
    }
    return { sessionId, release, discard: async () => {
      try { await rpc.request('thread/archive', { threadId: sessionId }, { timeoutMs: FORK_TIMEOUT_MS }); }
      finally { await release(); }
    } };
  } catch (error) {
    await release();
    throw error;
  }
}
