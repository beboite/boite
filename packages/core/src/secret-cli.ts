/**
 * `boite secret`: an agent asks for a secret on a card and uses it by ref,
 * never holding the value. The core writes it into an ignored env file or
 * hands it to a command, and prints the command's output masked.
 */
import { resolve } from 'node:path';
import { SECRET_ASK_TIMEOUT_MINUTES, type SecretUseResult } from '@boite/contracts';
import type { CoreClient } from './client.ts';
import type { CliIo } from './cli.ts';
import { Usage } from './cli-args.ts';

export const SECRET_HELP = `boite secret: ask the user for a key on a card, then use it by ref without ever seeing it.
  boite secret list                                   compatibility: reports that no keys are stored
  boite secret ask <NAME> --why "<reason>" [--placeholder "<example>"] [--timeout <minutes>]
                                                      prints: saved secret:<ref> | declined | cancelled | timed_out
  boite secret write <ref> --env-file <path> --key <VAR> [--allow-unignored]
                                                      writes VAR=<value> into a git-ignored file of this conversation
  boite secret run <ref> --as <VAR> -- <cmd> [args...] runs cmd with the value in env var VAR, output masked
  boite secret pipe <ref> -- <cmd> [args...]          runs cmd with the value on stdin, output masked
Never ask for a secret in chat. Refs: secret:<id>, single-use, in memory for at most 10 minutes and only during the requesting turn.
This is not a sandbox: a value written to a file can be read back with a shell, and then it reaches the model.`;

export interface SecretCliResult {
  lines: string[];
  value: unknown;
  /** run and pipe: the child's output, already masked, and its exit code. */
  output?: { stdout: string; stderr: string; exitCode: number };
}

/** The flags of one subcommand, before `--`; anything unknown is a usage error. */
function flags(args: string[], known: { values: string[]; booleans: string[] }): { positional: string[]; values: Map<string, string>; booleans: Set<string> } {
  const positional: string[] = [];
  const values = new Map<string, string>();
  const booleans = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (!arg.startsWith('--')) { positional.push(arg); continue; }
    const name = arg.slice(2);
    if (known.booleans.includes(name)) { booleans.add(name); continue; }
    if (!known.values.includes(name)) throw new Usage(`boite secret: unknown flag ${arg}`);
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Usage(`boite secret: ${arg} needs a value`);
    values.set(name, value);
    index += 1;
  }
  return { positional, values, booleans };
}

function useLines(result: SecretUseResult): string[] {
  if (result.action === 'write') return [`${result.replaced ? 'replaced' : 'added'} in ${result.path}`];
  return [];
}

export async function secretCommand(args: string[], io: CliIo, client: CoreClient, threadId: string): Promise<SecretCliResult> {
  const [action, ...rest] = args;
  if (action === undefined || action === 'help' || action === '--help') return { lines: [SECRET_HELP], value: { help: SECRET_HELP } };
  if (action === 'list') {
    if (rest.length > 0) throw new Usage('boite secret list takes no arguments');
    const result = await client.call('secrets.list', { threadId });
    return { lines: ['Secret Drop stores no project keys; ask for a new single-use ref'], value: result };
  }
  if (action === 'ask') {
    const parsed = flags(rest, { values: ['why', 'placeholder', 'timeout', 'request-id'], booleans: [] });
    const name = parsed.positional[0];
    if (name === undefined || parsed.positional.length > 1) throw new Usage('boite secret ask needs one NAME, e.g. OPENAI_API_KEY');
    const why = parsed.values.get('why');
    if (why === undefined) throw new Usage('boite secret ask needs --why "<reason>"');
    const timeout = Number(parsed.values.get('timeout') ?? SECRET_ASK_TIMEOUT_MINUTES);
    if (!Number.isInteger(timeout)) throw new Usage('--timeout takes whole minutes');
    // The same id on a retry finds the same card, or the answer it already got.
    const requestId = parsed.values.get('request-id') ?? `sreq_${crypto.randomUUID().replaceAll('-', '')}`;
    const placeholder = parsed.values.get('placeholder');
    const result = await client.call('secrets.ask', {
      threadId, name, reason: why, timeoutMinutes: timeout, requestId,
      ...(placeholder === undefined ? {} : { placeholder }),
    });
    const line = result.outcome === 'saved' ? `saved ${result.ref}` : result.outcome;
    const memory = result.outcome === 'saved' ? ['note: single-use ref; expires in 10 minutes, when this turn ends or when Boite stops'] : [];
    return { lines: [line, ...memory], value: result };
  }
  if (action === 'write') {
    const parsed = flags(rest, { values: ['env-file', 'key'], booleans: ['allow-unignored'] });
    const ref = parsed.positional[0];
    if (ref === undefined || parsed.positional.length > 1) throw new Usage('boite secret write needs one ref');
    const path = parsed.values.get('env-file');
    const key = parsed.values.get('key');
    if (path === undefined || key === undefined) throw new Usage('boite secret write needs --env-file <path> and --key <VAR>');
    const result = await client.call('secrets.use', { threadId, ref, use: { action: 'write', path: resolve(io.cwd, path), key, ...(parsed.booleans.has('allow-unignored') ? { allowUnignored: true } : {}) } });
    return { lines: useLines(result), value: result };
  }
  if (action === 'run' || action === 'pipe') {
    const split = rest.indexOf('--');
    if (split < 0) throw new Usage(`boite secret ${action} needs -- before the command`);
    const parsed = flags(rest.slice(0, split), { values: action === 'run' ? ['as'] : [], booleans: [] });
    const [command, ...commandArgs] = rest.slice(split + 1);
    const ref = parsed.positional[0];
    if (ref === undefined || parsed.positional.length > 1) throw new Usage(`boite secret ${action} needs one ref`);
    if (command === undefined) throw new Usage(`boite secret ${action} needs a command after --`);
    const as = parsed.values.get('as');
    if (action === 'run' && as === undefined) throw new Usage('boite secret run needs --as <VAR>');
    const env = Object.fromEntries(Object.entries(io.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
    const result = await client.call('secrets.use', { threadId, ref, use: { action, ...(as === undefined ? {} : { as }), command, args: commandArgs, cwd: io.cwd, env } });
    if (result.action === 'write') return { lines: useLines(result), value: result };
    const notes = [...(result.truncated ? ['boite secret: output cut at 1 MB per stream'] : []), ...(result.timedOut ? ['boite secret: the command was stopped at its deadline'] : [])];
    // A command stopped at its deadline exits 124 like timeout(1), whatever its signal gave.
    return {
      lines: [], value: result,
      output: { stdout: result.stdout, stderr: result.stderr + (notes.length ? `${notes.join('\n')}\n` : ''), exitCode: result.timedOut ? 124 : result.exitCode ?? 1 },
    };
  }
  throw new Usage(`boite secret: unknown action ${action}; expected list, ask, write, run or pipe`);
}
