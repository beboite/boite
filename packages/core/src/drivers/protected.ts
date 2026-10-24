import type {PermissionMode} from '@boite/contracts';
import type {TurnContext} from './types.ts';

/** Trusted control stays in the selected account; only this capability can run model tools. */
export interface ProtectedDriverExecution {
  readonly fingerprint: string;
  readonly toolsAllowed?: boolean;
  check(): void;
  execute(command: string, args: string[], cwd?: string): Promise<{code: number; stdout: string; stderr: string}>;
  commit?(message: string): Promise<string>;
}

export const PROTECTED_TOOL = 'boite_exec';
export const PROTECTED_COMMIT = 'boite_commit';
export const PROTECTED_COMMIT_DESCRIPTION = 'Commit only validated project edits on this shared job\'s captured host branch. Git metadata and host hooks remain inaccessible to tools.';
export const PROTECTED_DESCRIPTION = 'Execute an argv vector in the protected project filesystem. Use this for project reads, edits, builds and tests. The environment is offline, contains no host credentials and cannot access other host files. No sandbox escape or elevation is available.';
export const PROTECTED_SCHEMA = {type: 'object', additionalProperties: false, properties: {
  command: {type: 'string', minLength: 1}, args: {type: 'array', items: {type: 'string'}}, cwd: {type: 'string'},
}, required: ['command', 'args']} as const;

/** Mediation retains the host's permission choice, including the refusal to prompt. */
async function permitted(ctx: TurnContext, input: unknown, stopped: Promise<unknown>, name = PROTECTED_TOOL): Promise<boolean> {
  const mode: PermissionMode = ctx.thread.permissionMode;
  if (mode === 'plan' || mode === 'dontAsk') return false;
  if (mode === 'yolo' || mode === 'bypassPermissions') return true;
  const ticket = ctx.requestPermission(name, input, 'Run in the captured protected project');
  return await Promise.race([ticket, stopped.then(() => 'deny')]) === 'allow';
}

export async function protectedCommit(ctx: TurnContext | null, raw: unknown, stopped: Promise<unknown>) {
  try {
    if (ctx?.protectedExecution?.toolsAllowed === false || !ctx?.protectedExecution?.commit) throw new Error('execution.commit: requires a captured shared job branch');
    const input = raw as {message?: unknown} | null;
    if (!input || Object.keys(input).some(k => k !== 'message') || typeof input.message !== 'string' || !input.message.trim() || input.message.length > 500) throw new Error('execution.commit.message: expected a nonempty commit message up to 500 characters');
    ctx.protectedExecution.check();
    if (!await permitted(ctx, raw, stopped, PROTECTED_COMMIT)) throw new Error('execution.commit: host permission refused');
    return {success: true, contentItems: [{type: 'inputText' as const, text: await ctx.protectedExecution.commit(input.message)}]};
  } catch (error) {return {success: false, contentItems: [{type: 'inputText' as const, text: error instanceof Error ? error.message : 'Protected commit refused'}]};}
}

export async function protectedTool(ctx: TurnContext | null, raw: unknown, stopped: Promise<unknown>): Promise<{success: boolean; contentItems: {type: 'inputText'; text: string}[]}> {
  try {
    if (!ctx?.protectedExecution || ctx.protectedExecution.toolsAllowed === false) throw new Error('execution.tool: no captured protected turn');
    ctx.protectedExecution.check();
    const input = raw as Record<string, unknown> | null;
    if (!input || Object.keys(input).some(k => !['command', 'args', 'cwd'].includes(k)) || typeof input.command !== 'string' || !input.command
      || !Array.isArray(input.args) || input.args.some(a => typeof a !== 'string') || input.cwd !== undefined && typeof input.cwd !== 'string') {
      throw new Error('execution.tool: expected command, string args and optional checkout cwd; no environment, elevation or descriptors');
    }
    if (!await permitted(ctx, raw, stopped)) throw new Error('execution.tool: host permission mode or approval refused this command');
    const result = await ctx.protectedExecution.execute(input.command, input.args as string[], input.cwd as string | undefined);
    return {success: result.code === 0, contentItems: [{type: 'inputText', text: JSON.stringify(result)}]};
  } catch (error) {
    return {success: false, contentItems: [{type: 'inputText', text: error instanceof Error ? error.message : 'Protected tool refused'}]};
  }
}
