import type { Channel } from '@boite/contracts';

export class Usage extends Error {}

export interface Parsed {
  positional: string[];
  json: boolean;
  multiple: boolean;
  thread: string | undefined;
  dataDir: string | undefined;
  channel: Channel;
  requestId?: string;
  worktree: boolean;
  title?: string;
  /** `boite ask --open <url>`: the page the card opens. */
  open?: string;
  name?: string;
  model?: string;
  effort?: string;
  speed?: string;
  profile?: string;
  wait: boolean;
  timeout?: number;
  last?: number;
  before?: number;
  limit?: number;
  level?: 'debug' | 'info' | 'warn' | 'error';
  /** `threads --project` or `delegate spawn --project`: one project by id, name or folder. */
  project?: string;
  /** `threads --archived`: the archived threads instead. */
  archived: boolean;
  /** `answer --skip`: resolve a question without an answer. */
  skip: boolean;
  /** `settings request|open --why <text>`: the reason the card shows the user. */
  why?: string;
  /** `settings bot --bot <name>`: the bot, by name or id; omitted, the one whose conversation this is. */
  bot?: string;
  /** `settings bot create --domain <text>`: what the new bot looks after, in a line. */
  domain?: string;
  /** `settings bot create --instructions-file <path>`: its instructions, read from a file. */
  instructionsFile?: string;
  /** Another core's address; its token comes from BOITE_TOKEN, never the command line. */
  core?: string;
  /** `thread new --machine <name>`, `settings request --machine <name>`: another machine of the group. */
  machine?: string;
  /** `bot event --key <key>`: the outside event a later one with the same key replaces. */
  key?: string;
  /** `--context`, `--keep`, `--drop`, `--tools`, `--rules`, `--rules-file`, as typed: `contextRequest` reads them. */
  context?: { preset?: string; keep?: string; drop?: string; tools?: string; rules?: string; rulesFile?: string };
}

/** The flags that start a thread or a subagent without part of the user's setup. */
const CONTEXT_FLAGS = { '--context': 'preset', '--keep': 'keep', '--drop': 'drop', '--tools': 'tools', '--rules': 'rules', '--rules-file': 'rulesFile' } as const;

const BOOLEAN_OPTIONS = ['json', 'multiple', 'worktree', 'wait', 'archived', 'skip'] as const;
const NUMBER_OPTIONS = ['timeout', 'last', 'before'] as const;

export function parse(argv: string[]): Parsed {
  const parsed: Parsed = { positional: [], json: false, multiple: false, worktree: false, wait: false, archived: false, skip: false, thread: undefined, dataDir: undefined, channel: 'stable' };
  const number = (flag: string, raw: string): number => {
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) throw new Usage(`${flag} needs a number, got ${raw}`);
    return value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? '';
    const next = (): string => {
      const value = argv[index + 1];
      if (value === undefined || value === '' || value.startsWith('--')) throw new Usage(`${arg} needs a value`);
      index += 1;
      return value;
    };
    // `boite browser` takes agent-browser's own flags (-i, --text, --timeout...); only these stay global.
    if (parsed.positional[0] === 'browser' && parsed.positional.length > 1 && !['--json', '--thread', '--data-dir', '--core', '--channel'].includes(arg)) { parsed.positional.push(arg); continue; }
    // `boite logs` and `boite issue` parse their own filters (logs-cli.ts).
    if ((parsed.positional[0] === 'logs' || parsed.positional[0] === 'issue') && !['--json', '--thread', '--data-dir', '--core', '--channel', '--help', '-h'].includes(arg)) {
      // A value comes next and is passed the same way; a global flag after it stays global.
      parsed.positional.push(arg);
      continue;
    }
    // `boite window` parses its own flags (window-cli.ts): its --title names a window, not a thread.
    // `boite view check` parses its script and scheme flags in view-cli.ts.
    // `boite secret` parses its own flags (secret-cli.ts); after `--` every word is the child command's, `--json` included.
    if ((parsed.positional[0] === 'window' && parsed.positional.length > 1 && !['--json', '--thread', '--data-dir', '--core', '--channel', '--help', '-h'].includes(arg))
      || (parsed.positional[0] === 'view' && parsed.positional[1] === 'check' && !['--json', '--thread', '--data-dir', '--core', '--channel', '--help', '-h'].includes(arg))
      || (parsed.positional[0] === 'secret' && (arg === '--' || parsed.positional.includes('--') || !['--json', '--thread', '--data-dir', '--core', '--channel'].includes(arg)))) {
      parsed.positional.push(arg);
      continue;
    }
    const boolean = BOOLEAN_OPTIONS.find(key => arg === `--${key}`);
    const numeric = NUMBER_OPTIONS.find(key => arg === `--${key}`);
    if (boolean !== undefined) parsed[boolean] = true;
    else if (numeric !== undefined) parsed[numeric] = number(arg, next());
    else if (arg === '--request-id') parsed.requestId = next();
    else if (arg === '--title') parsed.title = next();
    else if (arg === '--open') parsed.open = next();
    else if (arg === '--name') parsed.name = next();
    else if (arg === '--project') parsed.project = next();
    else if (arg === '--why') parsed.why = next();
    // `--agent` is the old spelling, still read.
    else if (arg === '--bot' || arg === '--agent') parsed.bot = next();
    else if (arg === '--domain') parsed.domain = next();
    else if (arg === '--instructions-file') parsed.instructionsFile = next();
    else if (arg === '--core') parsed.core = next();
    else if (arg === '--machine') parsed.machine = next();
    else if (arg === '--key' && parsed.positional[0] === 'bot') parsed.key = next();
    else if (arg === '--limit') {
      const value = number(arg, next());
      // The widest any command takes (`boite logs`); a command with a lower cap checks its own.
      if (!Number.isInteger(value) || value < 1 || value > 1000) throw new Usage('--limit needs an integer from 1 to 1000');
      parsed.limit = value;
    }
    else if (arg === '--level') {
      const value = next();
      if (value !== 'debug' && value !== 'info' && value !== 'warn' && value !== 'error') throw new Usage('--level expects debug, info, warn or error');
      parsed.level = value;
    }
    else if (arg === '--thread') parsed.thread = next();
    else if (arg === '--data-dir') parsed.dataDir = next();
    else if (arg === '--channel') {
      const channel = next();
      if (channel !== 'stable' && channel !== 'dev') throw new Usage(`unknown channel ${channel}`);
      parsed.channel = channel;
    } else if (arg === '--help' || arg === '-h') throw new Usage('');
    else if (arg === '--output' && parsed.positional[0] === 'device' && parsed.positional[1] === 'screenshot') parsed.positional.push(arg, next());
    else if (arg === '--platform' && parsed.positional[0] === 'device' && parsed.positional[1] === 'open') parsed.positional.push(arg, next());
    else if (arg === '--shutdown' && parsed.positional[0] === 'device' && parsed.positional[1] === 'close') parsed.positional.push(arg);
    else if (arg === '--model') parsed.model = next();
    else if (arg === '--effort') parsed.effort = next();
    else if (arg === '--speed') parsed.speed = next();
    else if (arg === '--profile') parsed.profile = next();
    else if (Object.hasOwn(CONTEXT_FLAGS, arg)) parsed.context = { ...parsed.context, [CONTEXT_FLAGS[arg as keyof typeof CONTEXT_FLAGS]]: next() };
    else if (arg.startsWith('--')) throw new Usage(`unknown flag ${arg}`);
    else parsed.positional.push(arg);
  }
  parsed.positional = canonicalCommand(parsed.positional);
  return parsed;
}

/**
 * The old spellings as the commands they became: `agent <x>` is `bot <x>`,
 * `agents <x>` is `threads <x>` and `settings agent` is `settings bot`.
 * Bots' brains and the user's notes still name them; help shows only the new.
 */
export function canonicalCommand(positional: string[]): string[] {
  const [command, action] = positional;
  if (command === 'agent') return ['bot', ...positional.slice(1)];
  if (command === 'agents') return ['threads', ...positional.slice(1)];
  if (command === 'settings' && action === 'agent') return ['settings', 'bot', ...positional.slice(2)];
  return positional;
}


export function requiredText(args: string[], start: number, message: string, trim = true): string {
  let text = args.slice(start).join(' ');
  if (trim) text = text.trim();
  if (text.length === 0) throw new Usage(message);
  return text;
}

/**
 * The `context` a spawn or a new thread sends, from `--context <preset>`,
 * `--keep`/`--drop <part,part>`, `--tools <Tool,Tool>` and `--rules <text>` or
 * `--rules-file <path>`; undefined when none was given. The core checks the values.
 */
export function contextRequest(parsed: Parsed, readFile: (path: string) => string): Record<string, unknown> | undefined {
  const flags = parsed.context;
  if (flags === undefined) return undefined;
  if (flags.rules !== undefined && flags.rulesFile !== undefined) throw new Usage('--rules and --rules-file exclude each other');
  const list = (value: string | undefined) => value === undefined ? undefined : value.split(',').map(item => item.trim()).filter(Boolean);
  const rules = flags.rulesFile === undefined ? flags.rules : readFile(flags.rulesFile);
  const request: Record<string, unknown> = {
    ...(flags.preset === undefined ? {} : { preset: flags.preset }),
    ...(flags.keep === undefined ? {} : { keep: list(flags.keep) }),
    ...(flags.drop === undefined ? {} : { drop: list(flags.drop) }),
    ...(flags.tools === undefined ? {} : { tools: list(flags.tools) }),
    ...(rules === undefined ? {} : { rules }),
  };
  return request;
}
