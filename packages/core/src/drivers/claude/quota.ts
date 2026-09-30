import type { Query, SpawnOptions as SdkSpawnOptions } from '@anthropic-ai/claude-agent-sdk';
import { unavailable } from '../../errors.ts';
import type { SpawnedChild } from '../../procs.ts';
import { profileFor, resolveExecutable } from '../../providers/resolve.ts';
import type { ProbeContext } from '../types.ts';
import { childEnv, PromptQueue } from './query.ts';
import type { ClaudeDeps } from './query.ts';

const QUOTA_TIMEOUT_MS = 20_000;

/**
 * The plan's usage windows as the Claude CLI reads them itself, the data
 * behind its `/usage` command. The CLI holds the login wherever it keeps it,
 * the macOS Keychain included, so Boite never touches the credential. The
 * prompt stream stays empty: the session initializes and answers the control
 * request without sending anything to the model.
 */
export async function readClaudeQuota(ctx: ProbeContext, deps: ClaudeDeps = {
  loadQuery: () => import('@anthropic-ai/claude-agent-sdk').then((module) => module.query),
}): Promise<unknown> {
  const profile = profileFor(ctx.provider);
  const executable = profile ? resolveExecutable(profile) : null;
  if (!executable) throw unavailable('no Claude executable for the quota');
  const prompts = new PromptQueue();
  const abortController = new AbortController();
  let query: Query | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const queryFn = await deps.loadQuery();
    query = queryFn({ prompt: prompts.stream(), options: {
      cwd: ctx.cwd, pathToClaudeCodeExecutable: executable, abortController,
      env: childEnv(ctx.accountEnv), settingSources: ['user'], persistSession: false,
      settings: { disableAllHooks: true },
      tools: [], mcpServers: {},
      spawnClaudeCodeProcess: (options: SdkSpawnOptions): SpawnedChild => {
        const child = ctx.spawnChild(options.command, options.args, { cwd: options.cwd, env: options.env });
        child.stderr.resume(); return child;
      },
    } });
    const usage = await Promise.race([
      query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Claude quota timed out after 20 seconds')), QUOTA_TIMEOUT_MS);
      }),
    ]);
    if (!usage.rate_limits_available) throw new Error('This Claude account has no subscription login. Connect it in Providers.');
    return usage;
  } finally { if (timer) clearTimeout(timer); prompts.end(); query?.close(); abortController.abort(); ctx.killTree(); }
}
