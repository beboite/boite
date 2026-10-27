/** The Contacts concierge and activity reviewer share the driver's tool-free query path. */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { AGENT_ENV, TOOL_FREE_CONTEXT, type ThreadSummary } from '@boite/contracts';
import type { Core } from '../core.ts';
import { assertDriverRunnable, getDriver } from '../drivers/index.ts';
import { newId } from '../ids.ts';

export interface InferenceRoute {providerId: string; accountId: string; model: string | null; effort: string | null}
export function withoutBoiteCredentials(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const agent = new Set<string>(Object.values(AGENT_ENV)), clean: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(env)) {
    const upper = name.toUpperCase();
    if (agent.has(upper) || upper.startsWith('BOITE_AGENT_') || upper === 'BOITE_TOKEN' || upper === 'BOITE_PLUGIN_ID') continue;
    clean[name] = value;
  }
  return clean;
}
/** No project, conversation snapshot, hooks, tools, token or raw provider log. Nothing persists a model session. */
export async function toolFreeInference(core: Core, route: InferenceRoute, prompt: string, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  const provider = core.providers.require(route.providerId), account = core.accounts.require(route.accountId);
  if (account.providerId !== provider.id) throw new Error('inference account must belong to the configured provider');
  assertDriverRunnable(provider.protocol, core.providers.summary(provider.id), account, () => core.providers.launcherScriptOnly(provider.id));
  const driver = getDriver(provider.protocol);
  if (!driver.sideQuestion) throw new Error('this provider has no tool-free inference');
  const cwd = join(core.dataDir, 'contacts', 'inference'); mkdirSync(cwd, {recursive: true});
  const now = Date.now();
  const thread: ThreadSummary = {
    id: newId('thr_'), projectId: null, title: 'Contacts policy query', titleSource: 'user',
    ...route, speed: null, cwd, branch: null, permissionMode: 'plan', contextMode: {...TOOL_FREE_CONTEXT},
    status: 'idle', unread: false, archived: false, pinned: false, sessionId: null,
    sessionGeneration: 0, selectionVersion: 0, load: null, context: null, createdAt: now, updatedAt: now,
  };
  const procId = `contact-inference:${thread.id}`;
  const cancelled = Promise.withResolvers<never>();
  const abort = () => {core.procs.killTree(procId); cancelled.reject(signal.reason ?? new Error('inference cancelled'));};
  signal.addEventListener('abort', abort, {once: true});
  try {
    if (signal.aborted) abort();
    const answer = await Promise.race([cancelled.promise, driver.sideQuestion({
      thread, provider, prompt, question: prompt, signal,
      accountEnv: withoutBoiteCredentials(core.accounts.accountEnv(account, provider, thread)) as Record<string, string>,
      spawnChild: (cmd, args, opts) => {
        signal.throwIfAborted();
        const child = core.procs.spawnChild(procId, cmd, args, {...opts, env: withoutBoiteCredentials(opts?.env ?? process.env)});
        core.providers.installs.acquire(provider.id);
        let released = false;
        const drop = () => {if (!released) {released = true; core.providers.installs.release(provider.id);}};
        child.once('exit', drop); child.once('error', drop);
        return child;
      },
      log: () => undefined,
    })]);
    signal.throwIfAborted();
    return answer;
  } finally {
    signal.removeEventListener('abort', abort);
    await core.procs.stopAndWait(procId);
  }
}
