import type { SDKUserMessage, SpawnOptions as SdkSpawnOptions } from '@anthropic-ai/claude-agent-sdk';
import { unavailable } from '../../errors.ts';
import type { SpawnedChild } from '../../procs.ts';
import { profileFor, resolveExecutable } from '../../providers/loader.ts';
import { titleRequest } from '../../titles.ts';
import type { TitleContext } from '../types.ts';
import { childEnv, STDERR_MAX } from './query.ts';
import type { ClaudeDeps } from './query.ts';

/** What writes a thread's title: the CLI's alias for its smallest current model. */
const TITLE_MODEL = 'haiku';
/** How long one title call may take before its CLI is aborted. */
const TITLE_TIMEOUT_MS = 30_000;

/**
 * One short query on the small model: no tool, one turn, no settings file
 * read, nothing kept on disk, and the CLI traced under the thread like a
 * turn's. The `result` message's text is the title, as the model wrote it:
 * the core applies its one cleaning rule; a result that is an error is
 * thrown with its sentence.
 */
export async function titleQuery(deps: ClaudeDeps, ctx: TitleContext): Promise<string | null> {
  const profile = profileFor(ctx.provider);
  const executable = profile === undefined ? null : resolveExecutable(profile);
  if (executable === null) {
    throw unavailable(`no ${ctx.provider.id} executable on this machine`, { providerId: ctx.provider.id });
  }
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), TITLE_TIMEOUT_MS);
  timer.unref?.();
  const spawnCli = (options: SdkSpawnOptions): SpawnedChild => {
    const child = ctx.spawnChild(options.command, options.args, { cwd: options.cwd, env: options.env });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      const text = chunk.trim();
      if (text.length > 0) ctx.log('warn', `claude cli (title): ${text.slice(0, STDERR_MAX)}`);
    });
    return child;
  };
  const prompt = async function* (): AsyncGenerator<SDKUserMessage> {
    yield {
      type: 'user',
      message: { role: 'user', content: titleRequest(ctx.prompt, ctx.answer) },
      parent_tool_use_id: null,
    } as SDKUserMessage;
  };
  try {
    const queryFn = await deps.loadQuery();
    const query = queryFn({
      prompt: prompt(),
      options: {
        cwd: ctx.thread.cwd,
        model: TITLE_MODEL,
        maxTurns: 1,
        tools: [],
        allowedTools: [],
        settingSources: [],
        persistSession: false,
        includePartialMessages: false,
        pathToClaudeCodeExecutable: executable,
        abortController,
        env: childEnv(ctx.accountEnv),
        canUseTool: async () => ({ behavior: 'deny', message: 'a title needs no tool' }),
        spawnClaudeCodeProcess: spawnCli,
      },
    });
    let text: string | null = null;
    for await (const message of query) {
      if (message.type !== 'result') continue;
      if (message.subtype !== 'success') {
        const errors = (message as { errors?: string[] }).errors ?? [];
        throw new Error(errors[0] ?? `Claude ended the title call with ${message.subtype}.`);
      }
      text = message.result;
    }
    return text;
  } finally {
    clearTimeout(timer);
  }
}
