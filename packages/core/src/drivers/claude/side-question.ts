import { unavailable } from '../../errors.ts';
import type { Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { profileFor, resolveExecutable } from '../../providers/resolve.ts';
import type { SideQuestionContext } from '../types.ts';
import { childEnv, liveSetup, type ClaudeDeps } from './query.ts';

/** A fresh, unpersisted query leaves the running session and its prompt queue alone. */
export async function sideQuestion(deps: ClaudeDeps, ctx: SideQuestionContext): Promise<string> {
  const profile = profileFor(ctx.provider);
  const executable = profile === undefined ? null : resolveExecutable(profile);
  if (executable === null) throw unavailable(`no ${ctx.provider.id} executable on this machine`, { providerId: ctx.provider.id });
  const { effortLevel } = liveSetup(ctx.thread);
  let query: Query | undefined;
  const abortController = new AbortController();
  const abort = () => { abortController.abort(); query?.close(); };
  ctx.signal.addEventListener('abort', abort, { once: true });
  if (ctx.signal.aborted) abort();
  try {
    const queryFn = await deps.loadQuery();
    ctx.signal.throwIfAborted();
    const prompt = async function* (): AsyncGenerator<SDKUserMessage> {
      yield { type: 'user', message: { role: 'user', content: ctx.prompt }, parent_tool_use_id: null } as SDKUserMessage;
    };
    query = queryFn({ prompt: prompt(), options: {
      cwd: ctx.thread.cwd,
      ...(ctx.thread.model === null ? {} : { model: ctx.thread.model }),
      ...(effortLevel === null ? {} : { effort: effortLevel }),
      maxTurns: 1,
      tools: [], allowedTools: [], mcpServers: {}, settingSources: [],
      persistSession: false,
      includePartialMessages: false,
      pathToClaudeCodeExecutable: executable,
      abortController,
      env: childEnv(ctx.accountEnv),
      canUseTool: async () => ({ behavior: 'deny', message: 'side questions have no tool access' }),
      spawnClaudeCodeProcess: options => ctx.spawnChild(options.command, options.args, { cwd: options.cwd, env: options.env }),
    } });
    for await (const message of query) {
      if (message.type !== 'result') continue;
      if (message.subtype !== 'success') throw new Error(('errors' in message && message.errors[0]) || `Claude ended the side question with ${message.subtype}.`);
      if (message.result.trim()) return message.result;
    }
    ctx.signal.throwIfAborted();
    throw new Error('Claude wrote no side answer.');
  } finally {
    ctx.signal.removeEventListener('abort', abort);
    query?.close();
  }
}
