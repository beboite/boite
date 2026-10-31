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

/** What every command reads wherever it stands, until a command's own text begins. */
const GLOBAL_FLAGS = ['--json', '--thread', '--data-dir', '--core', '--channel'];

/**
 * Commands that parse their own flags: every other word reaches them as typed.
 * `help` keeps `--help` the CLI's. `text` says the command's own text has
 * begun, after which a global flag is part of that text too. `terminator`
 * says the command reads `--` itself.
 */
const OWNED: { owns: (positional: string[]) => boolean; help: boolean; text?: (positional: string[]) => boolean; terminator?: boolean }[] = [
  // agent-browser's own flags (-i, --text, --timeout...); see `browserText` for its text.
  { owns: ([command, action]) => command === 'browser' && action !== undefined, help: false, text: positional => browserText(positional.slice(1)) },
  // Their own filters (logs-cli.ts); a value comes next and is passed the same way.
  { owns: ([command]) => command === 'logs' || command === 'issue', help: true },
  // window-cli.ts: its --title names a window, not a thread.
  { owns: ([command, action]) => command === 'window' && action !== undefined, help: true },
  // desktop-cli.ts: after its command every word is its own, `run`'s program and agent-desktop's flags alike.
  { owns: ([command, action]) => command === 'desktop' && action !== undefined, help: false, text: positional => positional.length >= 2, terminator: true },
  // view-cli.ts: the script and scheme flags of `view check`.
  { owns: ([command, action]) => command === 'view' && action === 'check', help: true },
  // secret-cli.ts; after `--` every word is the child command's.
  { owns: ([command]) => command === 'secret', help: false, text: positional => positional.includes('--'), terminator: true },
];

/**
 * The browser commands that end in text, and how many words come before it:
 * `fill <target> <text>`, `eval <js>`, `run <script> <args>`. Once those words
 * are there, every word is the command's, so `fill '#q' --json` types it and a
 * script receives `--core`. `--tab <id>` is the browser's wherever it stands.
 */
const BROWSER_TEXT: Record<string, number> = { fill: 1, type: 1, select: 1, dialog: 1, eval: 0, evaluate: 0, run: 1 };

/** `recipe run <name> <args>` and `recipe save <name> <file|-> <args>`, counting the sub-command. */
const RECIPE_TEXT: Record<string, number> = { run: 2, save: 3 };

/** The browser flags that take the next word as their value (`recipe save --about "..."`). */
const VALUE_FLAGS = ['--tab', '--about', '--usage'];

/** A flag of the command's own; `-` alone is an operand, the stdin of `run -`. */
const isFlag = (word: string): boolean => word.length > 1 && word.startsWith('-');

function browserText(words: string[]): boolean {
  const [action = '', ...rest] = words;
  const plain = rest.filter((word, index) => !isFlag(word) && !VALUE_FLAGS.includes(rest[index - 1] ?? ''));
  const before = action === 'recipe' ? RECIPE_TEXT[plain[0] ?? ''] : BROWSER_TEXT[action];
  return before !== undefined && plain.length >= before;
}

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
    const owner = OWNED.find(family => family.owns(parsed.positional));
    const text = owner?.text?.(parsed.positional) === true;
    // `--` ends Boite's flags: every word after it is the command's, `task add -- --json` and
    // `browser run -- batch.js --core` included. Inside a command's text it is that text,
    // and `secret run <ref> -- <command>` reads its own.
    if (arg === '--' && !text && owner?.terminator !== true) {
      parsed.positional.push(...argv.slice(index + 1));
      break;
    }
    if (owner && (text || (!GLOBAL_FLAGS.includes(arg) && !(owner.help && (arg === '--help' || arg === '-h'))))) {
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
