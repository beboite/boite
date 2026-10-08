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
  level?: 'info' | 'warn' | 'error';
  /** `threads --project`: one project by id, name or folder. */
  project?: string;
  /** `threads --archived`: the archived threads instead. */
  archived: boolean;
  /** `answer --skip`: resolve a question without an answer. */
  skip: boolean;
  /** `stewards set --all`: every project. */
  all: boolean;
  /** `stewards set --can a,b`: the capabilities. */
  can?: string;
  /** `stewards set --quiet`: no notices. */
  quiet: boolean;
  /** Another core's address; its token comes from BOITE_TOKEN, never the command line. */
  core?: string;
}

const BOOLEAN_OPTIONS = ['json', 'multiple', 'worktree', 'wait', 'archived', 'skip', 'all', 'quiet'] as const;
const NUMBER_OPTIONS = ['timeout', 'last', 'before'] as const;

export function parse(argv: string[]): Parsed {
  const parsed: Parsed = { positional: [], json: false, multiple: false, worktree: false, wait: false, archived: false, skip: false, all: false, quiet: false, thread: undefined, dataDir: undefined, channel: 'stable' };
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
    const boolean = BOOLEAN_OPTIONS.find(key => arg === `--${key}`);
    const numeric = NUMBER_OPTIONS.find(key => arg === `--${key}`);
    if (boolean !== undefined) parsed[boolean] = true;
    else if (numeric !== undefined) parsed[numeric] = number(arg, next());
    else if (arg === '--request-id') parsed.requestId = next();
    else if (arg === '--title') parsed.title = next();
    else if (arg === '--name') parsed.name = next();
    else if (arg === '--project') parsed.project = next();
    else if (arg === '--can') parsed.can = next();
    else if (arg === '--core') parsed.core = next();
    else if (arg === '--limit') {
      const value = number(arg, next());
      if (!Number.isInteger(value) || value < 1 || value > 200) throw new Usage('--limit needs an integer from 1 to 200');
      parsed.limit = value;
    }
    else if (arg === '--level') {
      const value = next();
      if (value !== 'info' && value !== 'warn' && value !== 'error') throw new Usage('--level expects info, warn or error');
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
    else if (arg.startsWith('--')) throw new Usage(`unknown flag ${arg}`);
    else parsed.positional.push(arg);
  }
  return parsed;
}


export function requiredText(args: string[], start: number, message: string, trim = true): string {
  let text = args.slice(start).join(' ');
  if (trim) text = text.trim();
  if (text.length === 0) throw new Usage(message);
  return text;
}
