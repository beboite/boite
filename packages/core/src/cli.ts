/**
 * `boite`, the CLI an agent runs inside a thread. It is `boite-core cli`
 * behind a shim on the PATH; a process the thread launched finds the core and
 * its own token in the environment the core put there (`AGENT_ENV`) and says
 * hello as the `agent` of that thread. Every answer is a few `key: value`
 * lines or one row per item, which is what a model reads back at the lowest
 * cost; `--json` gives the raw result to a script.
 *
 * Without that environment, `--thread <id>` drives any thread with the owner
 * token read out of `core.json`, the way `boite-core pair` finds its core.
 */
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { AGENT_ENV, AGENT_SETTING_KEYS, SETTINGS_PAGES, VIEW_HELP } from '@boite/contracts';
import { VIEW_EXAMPLE } from './view-example.ts';
import { viewCheckCommand } from './view-cli.ts';
import type { AgentTask, GitChange, PanelSurface, SettingsReading, Todo } from '@boite/contracts';
import { connect } from './client.ts';
import type { CoreClient } from './client.ts';
import { CORE_VERSION } from './version.ts';
import { resolveDataDir } from './paths.ts';
import { botCommand } from './agents/cli.ts';
import { workflowCommand } from './workflow-cli.ts';
import { DELEGATE_ACTIONS, delegateCommand } from './delegate-cli.ts';
import { browserCommand, BROWSER_HELP } from './browser-cli.ts';
import { browserRun } from './browser-run.ts';
import { browserRecipe } from './browser-recipe.ts';
import { deviceCommand } from './device-cli.ts';
import { WINDOW_REQUEST_TIMEOUT_MS, windowCommand } from './window-cli.ts';
import { secretCommand } from './secret-cli.ts';
import { agentsCommand, AgentsUsage, WAIT_MAX_S } from './agents-cli.ts';
import type { RpcParams } from '@boite/contracts';
import { contextRequest, parse, requiredText, Usage, type Parsed } from './cli-args.ts';
import { issueCommand, logsCommand } from './logs-cli.ts';
import { CONTROL_HELP, controlCommand, isControlCommand, ownerThreadNew, ownerWithoutThread, spawnedLines, type Caller } from './control-cli.ts';

export interface CliIo {
  out(text: string): void;
  err(text: string): void;
  env: Record<string, string | undefined>;
  cwd: string;
  /** Everything piped in, for a command that reads `-`. */
  stdin?(): Promise<string>;
}

export const USAGE = `usage: boite <command> [args] [--json]

  mcp                            serve bounded thread-scoped tools over MCP stdio
  where                          this thread, project, cwd, branch
  thread move <project>          move this thread to another project (name,
                                 id or folder) when this turn ends
  thread new <project> <brief>   start a thread in a project; its first answer
                                 comes back to you (--worktree, --title <title>,
                                 --machine <name> from an agent thread: on
                                 another machine of the group, in a project
                                 there, once its owner allows it. From a
                                 terminal use --core <url>; --model
                                 <provider/model>, --effort <level>, --speed
                                 <tier> from boite delegate models, with the
                                 same --machine for that machine's; refused
                                 when it lacks them, never another model);
                                 a bot names an entrusted remote project
                                 as <machine>/<project>
  projects                       the projects added to Boite
  projects add <folder>          add an existing folder as a project, so thread
                                 new and thread move can name it (--name <name>)
  projects archive|unarchive|remove <p>
                                 the owner's; removing leaves the folder on disk
${CONTROL_HELP}
  attach <file>                  publish a file in chat, up to 512 MB
  show <file>[:line]             open a file in the panel, at a line
  diff [file]                    open the changes, or one file's diff
  browse <url>                   open a url in a new tab of this conversation's browser
  browser help                   inspect, test and capture the built-in browser
  device help                    open an iOS Simulator or Android emulator in the
                                 user's Device panel, capture and drive it
  window help                    capture a desktop window (Unity, a game) as a PNG
                                 or a contact sheet, or show it in the Window panel
  desktop help                   a private virtual desktop (Linux) to run GUI apps
                                 and drive them through agent-desktop
  pr list|refresh                this conversation's linked pull requests
  pr link|unlink <url>           attach or remove a PR link; does not change GitHub
  pr watch [<url|number>]        wake this thread when the PR's checks fail or
                                 pass, a review or comment lands, it starts
                                 to conflict or leaves the merge queue
                                 unmerged; end your turn instead of polling
  pr unwatch [<url|number>]      stop one watch, or all of this thread's
  view <file.html>               draw an HTML page in your answer, where a
                                 line ![title](file.html) places it
                                 (--title <text>); view help has the rules
                                 and the app's look, view example a full page
  view check <file.html>         check at desktop and phone widths without
                                 publishing; save PNGs in the cwd
                                 (--script <checks.js>, --scheme dark|light)
  preview <file.html>             open a local HTML artifact with its assets
  preview-close <file.html>       stop serving a local HTML preview
  open trace|tasks|changes|files|workflow [dir|run-id]
  status                         git status of the working directory
  server check|update|cancel      check or update this server, or cancel the
                                 pending update; no thread needed as owner
  journal-check [table rowid]     bounded read-only journal diagnostics, owner only
  logs [--min-level warn] [--since 2h]
                                 Boite's own diagnostics: did the app, its shell
                                 or a client fail? logs help has the filters,
                                 logs problems groups them, logs export writes
                                 the anonymized file a developer reads
  issue draft|submit --title <t> --description <text>
                                 report a Boite bug on GitHub with that export;
                                 show the user the draft before submit
  ask <question> [option ...]    ask the user without stopping; the answer
                                 arrives later as a message (--multiple);
                                 --open <url> adds an Open button for a page
                                 the user must sign in to, in your browser
  ask list                      read this thread's pending questions
  secret list                    keys kept for this project, by name only
  secret ask <NAME> --why <text> ask the user for a key on a card; prints
                                 saved secret:<ref>, declined, cancelled or timed_out
  secret write|run|pipe <ref>    use it without seeing it; boite secret help
  settings [key]                 Boite settings you may ask about: value, page,
                                 the name the user's app shows; first, the
                                 language the app speaks; experiments last
  settings request <key> <value> --why <text>
                                 a card with the switch or value itself, for
                                 the user to change in the chat; value is JSON
                                 or a bare word (experiment.<id> true|false);
                                 the outcome arrives as a message (applied,
                                 changed or refused); --machine <name> asks
                                 about another machine of the group
                                 (groupThreads, groupBots)
  settings open <page>[#<card>] --why <text>
                                 a card with a button to that Settings page,
                                 for what is not one value: a provider login,
                                 a pairing (pages: ${SETTINGS_PAGES.join(', ')})
  settings bot [key]             a bot's settings a card may change:
                                 ${AGENT_SETTING_KEYS.slice(0, 5).join(', ')},
                                 ${AGENT_SETTING_KEYS.slice(5).join(', ')}
                                 (--bot <name>; yours in your own conversation)
  settings bot request <key> <value> --why <text>
                                 a card asking the user to change one, for you
                                 or --bot <name>: name Ada, status paused,
                                 model codex/gpt-6.1-sol (<provider>/<model>,
                                 any provider), projects +boite -old
                                 (+<machine>/<name> for a project of another
                                 machine of the group), instructions with
                                 --instructions-file <path>; the outcome
                                 arrives as a message (applied, changed, refused)
  settings bot create <name>     create the bot the user asked for, at once,
                                 on your own route or --model <provider/model>
                                 (--effort, --project a,b, --domain <text>,
                                 --instructions-file <path>); prints its id
                                 and conversation
  task list                      the agent's task list
  task add <text>                add a task (id t1, t2, ...)
  task start|done|remove <id>    move or drop one task
  task clear                     drop every task
  todo list                      the project's todo list
  todo add <text>                add a card for the user
  todo claim <id>                mark a card finished, awaiting the user
  goal track                     a reviewed goal and checklist on the user's
                                 last prompt (the Automatic goals experiment)
  threads find <words>           locate threads by words of their chat, title,
                                 project, branch or model
  threads read <thread>          its conversation (--last <n>, --before <ms>)
  threads send <thread> <text>   message it; --wait blocks for its answer
  threads reply <message-id> <text>
  threads log <thread>           what you and that thread said to each other
  threads wait [thread]          the next message (--timeout <s>, default 90)
  threads inbox                  every exchange and its delivery state
                                 <thread>: <thread-id>, <machine>/<thread-id>
  threads contacts               other owners' Boites linked as contacts and
                                 the projects each opened to you
  threads ask <contact> <text>   request project access; the remote Boite can
                                 decide automatically; send messages with threads send
  bot memory                     a bot's MEMORY.md and its path
  bot remember <fact>            add a dated line to MEMORY.md
  bot routines                   its routines: schedule, next run, last outcome
  bot schedule <json>            name, prompt, schedule; optional id and enabled
  bot unschedule <routine-id>    remove one routine
  bot watch|unwatch <thread-id>  put a thread of its projects on its desk, or
                                 take one off; <machine>/<thread-id> for a
                                 project another machine entrusted to it
  bot event <bot> <text>         wake a bot with an event from outside Boite
                                 (--key <key>: a later event with the same key
                                 replaces it while it waits); from a terminal
                                 as the owner, or --core with a paired device
  --request-id <id>              reuse to retry threads send|reply or delegate spawn|send
  delegate models                models, reasoning levels and speeds a subagent can use
                                 (--machine <name>: another machine's, for
                                 thread new or delegate spawn --machine --model)
  delegate spawn <brief>         start a subagent on one bounded job; its result
                                 comes back as a message (--model <provider/model>,
                                 --effort <level>, --speed <tier>, --title <title>,
                                 --profile <id>, --worktree for a git worktree of
                                 its own from your checkout's HEAD (the project's
                                 for a bot), and a context mode: --context
                                 light|neutral, --keep|--drop <parts>, --tools
                                 <Tool,...>, --rules <text>|--rules-file <path>)
                                 --project <p> places a bot's child in an entrusted project
                                 --machine <name> runs it on another machine of the
                                 group, in its project named like yours or --project
  delegate list                  every subagent and workflow: state, model, time
  delegate send <thread-id> <text>
                                 steer or reuse a subagent, or ask the parent;
                                 to a subagent that asks something, the answer
  delegate stop [thread-id]      stop one subagent, or all of them
  delegate resume [thread-id]    continue stopped subagents, or one, and the
                                 workflows a pause or a restart held
  delegate wait [thread-id]      block until children finish or one asks something
                                 (--timeout <s>, default 600, max 3600); only with
                                 nothing else to do
  delegate result <child> <turn> [offset]
                                 read a bounded page of full assistant text
  delegate profiles              the owner's named routes
  workflow help                  the plan format, with an example
  workflow check|run <plan>      validate, or start, a JSON plan (file or inline)
  workflow list|show [run-id]    runs of this thread, or one run's steps and results
  workflow extend <run-id> <steps>
  workflow pause|resume|stop <run-id>
  workflow retry <run-id> [step]
  workflow output <json>         a step's structured result, checked on the spot
  workflow templates             plans kept for this project
  workflow save <name> <plan|run-id>
  workflow start <template>      run a kept plan by name or id

  Outside a thread, threads, thread, questions, answer, permissions, allow,
  deny and projects need no --thread: the owner drives every thread, and a
  message it sends is its own prompt. Inside a bot's conversation they reach
  the threads of the projects entrusted to it, and its messages reach them as
  that bot's.

  --core <url>                   another core, with its token in BOITE_TOKEN
                                 (an owner token, or a paired device's session)
  --thread <id> --data-dir <dir> --channel <stable|dev>
                                 drive a thread from outside it, as the owner
  --                             ends Boite's flags: the words after it are the command's`;

const STATUS_LETTER: Record<GitChange['status'], string> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R',
  copied: 'C',
  untracked: '?',
  conflict: 'U',
};

const TASK_MARK: Record<AgentTask['status'], string> = {
  pending: '[ ]',
  in_progress: '[>]',
  completed: '[x]',
};


interface Target {
  url: string;
  token: string;
  threadId: string;
}

/** Loopback, Tailscale's 100.64.0.0/10 and its fd7a:115c:a1e0::/48: links that already encrypt or never leave the machine. */
export function privateLink(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host === '::1' || /^127\./.test(host)) return true;
  const v4 = /^100\.(\d+)\.\d+\.\d+$/.exec(host);
  if (v4) return Number(v4[1]) >= 64 && Number(v4[1]) <= 127;
  return /^fd7a:115c:a1e0:/.test(host);
}

/** The environment first; `--thread` and `core.json` when the command runs outside a thread. */
function targetOf(parsed: Parsed, env: CliIo['env']): Target {
  const url = env[AGENT_ENV.coreUrl] || undefined;
  const token = env[AGENT_ENV.token] || undefined;
  const own = env[AGENT_ENV.threadId] || undefined;
  if (url && token && own) {
    // Inside a thread the CLI speaks for that thread and no other: `--thread`
    // is the owner's way in from a terminal, not an agent's way out of its own.
    if (parsed.thread !== undefined && parsed.thread !== own) {
      throw new Error(`this CLI speaks for thread ${own}, not thread ${parsed.thread}`);
    }
    if (parsed.core !== undefined) throw new Error(`this CLI speaks for thread ${own} on its own core; --core is for a terminal`);
    return { url, token, threadId: own };
  }
  const threadId = parsed.thread ?? own ?? (['server', 'logs', 'issue', 'journal-check'].includes(parsed.positional[0] ?? '') || ownerWithoutThread(parsed) ? '' : undefined);
  if (parsed.core !== undefined) {
    // The token stays out of the command line, where any process listing would show it.
    const remoteToken = env.BOITE_TOKEN || undefined;
    if (remoteToken === undefined) throw new Error('--core needs the token in BOITE_TOKEN');
    let url: URL;
    try { url = new URL(parsed.core); } catch { throw new Error(`--core: expected a URL such as https://host:3773, got ${parsed.core}`); }
    // The hello carries the token: cleartext only where the link is already private, loopback or a Tailscale address.
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && privateLink(url.hostname))) {
      throw new Error(`--core: expected https://, or http:// on loopback or a Tailscale address, got ${parsed.core}`);
    }
    const origin = url.origin;
    if (threadId === undefined) throw new Error(`pass --thread <id> with --core for ${parsed.positional[0] ?? 'this command'}`);
    return { url: origin, token: remoteToken, threadId };
  }
  if (threadId === undefined) {
    throw new Error(`not inside a Boite thread (${AGENT_ENV.threadId} is not set); pass --thread <id>`);
  }
  const dataDir = resolveDataDir(parsed.dataDir, parsed.channel);
  const file = join(dataDir, 'core.json');
  if (!existsSync(file)) throw new Error(`no core has run on ${dataDir}: ${file} does not exist`);
  let state: { port?: unknown; host?: unknown; token?: unknown };
  try {
    state = JSON.parse(readFileSync(file, 'utf8')) as typeof state;
  } catch {
    throw new Error(`${file} is not JSON`);
  }
  if (typeof state.port !== 'number' || typeof state.token !== 'string' || state.token.length === 0) {
    throw new Error(`${file} has no port or no token`);
  }
  const bound = typeof state.host === 'string' ? state.host : '127.0.0.1';
  const host = bound === '0.0.0.0' || bound === '::' ? '127.0.0.1' : bound;
  return { url: `http://${host.includes(':') ? `[${host}]` : host}:${state.port}`, token: state.token, threadId };
}

/** `src/a.ts:12` split into the file and the line; a Windows drive letter is not a line. */
export function splitLine(spec: string): { path: string; line: number | undefined } {
  const match = /^(.*):(\d+)$/.exec(spec);
  if (match && match[1] !== undefined && match[1].length > 0) return { path: match[1], line: Number(match[2]) };
  return { path: spec, line: undefined };
}

function absolute(cwd: string, path: string): string {
  return isAbsolute(path) ? path : resolve(cwd, path);
}

/** A value as typed: JSON when it parses (60, true, null, ["a"]), the bare word otherwise. */
export function settingValue(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

/**
 * A bot setting as typed: the text keys take the words as they are, so a
 * name such as `007` stays text; `projects` takes `+name -name` edits or a
 * list (`a,b`, `a b` or JSON), the other keys a value as `settingValue` reads it.
 */
export function agentSettingArg(key: string, tokens: string[]): unknown {
  const raw = tokens.join(' ').trim();
  if (['name', 'domain', 'instructions', 'avatar', 'status'].includes(key)) return raw;
  if (key !== 'projects') return settingValue(raw);
  if (raw.startsWith('[') || raw.startsWith('{')) return settingValue(raw);
  const items = raw.split(/[\s,]+/).filter(item => item.length > 0);
  const edits = items.filter(item => /^[+-]./.test(item));
  if (edits.length === 0) return items;
  if (edits.length !== items.length) throw new Usage('settings bot request projects takes +name -name edits or a list, not both');
  return { add: edits.filter(item => item.startsWith('+')).map(item => item.slice(1)), remove: edits.filter(item => item.startsWith('-')).map(item => item.slice(1)) };
}

/** A bot's instructions run to thousands of characters: a listing shows their start; one key or --json gives them whole. */
function clipped(text: string, max = 160): string {
  return text.length > max ? `${text.slice(0, max - 1)}… (${text.length} characters)` : text;
}

/** `resources#limits` into a page and a card. */
function settingsPlace(raw: string): { page: string; section?: string } {
  const parts = raw.split('#');
  if (parts.length > 2) throw new Usage('settings open takes one page, with an optional #card');
  const [page = '', section] = parts;
  return section === undefined || section.length === 0 ? { page } : { page, section };
}

function nextTaskId(tasks: AgentTask[]): string {
  let max = 0;
  for (const task of tasks) {
    const match = /^t(\d+)$/.exec(task.id);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `t${max + 1}`;
}

/** `3` names `t3`; anything else is an id as the list prints it. */
function taskId(raw: string): string {
  return /^\d+$/.test(raw) ? `t${raw}` : raw;
}

function taskRow(task: AgentTask): string {
  return `${task.id} ${TASK_MARK[task.status]} ${task.text}`;
}

function todoRow(todo: Todo): string {
  return `${todo.id} ${todo.status} ${todo.text}`;
}

function changeRow(change: GitChange): string {
  const counts = change.additions === null ? '' : ` +${change.additions} -${change.deletions ?? 0}`;
  const from = change.oldPath === null ? '' : ` (from ${change.oldPath})`;
  return `${STATUS_LETTER[change.status]}${change.staged ? '*' : ' '} ${change.path}${counts}${from}`;
}

type Printer = (lines: string[], value: unknown) => void;

/** A command that ran a child: the child's own output and code as it gave them, or the lines with --json. */
function childOutput(result: { lines: string[]; value: unknown; output?: { stdout: string; stderr: string; exitCode: number } }, json: boolean, io: CliIo, print: Printer): number | undefined {
  if (result.output === undefined || json) { print(result.lines, result.value); return result.output?.exitCode; }
  if (result.output.stdout) io.out(result.output.stdout);
  if (result.output.stderr) io.err(result.output.stderr);
  return result.output.exitCode;
}

async function run(parsed: Parsed, io: CliIo, client: CoreClient, threadId: string, print: Printer, caller: Caller): Promise<void | number> {
  const [command, ...rest] = parsed.positional;
  if (isControlCommand(parsed)) {
    await controlCommand(client, caller, threadId, parsed, print);
    return;
  }
  const want = (index: number, what: string): string => {
    const value = rest[index];
    if (value === undefined || value.length === 0) throw new Usage(`${command} needs ${what}`);
    return value;
  };
  const opened = async (surface: PanelSurface): Promise<void> => {
    const { shown } = await client.call('panel.open', { threadId, surface });
    print([`shown: ${shown ? 'yes' : 'no, nobody is watching this thread; it is queued on its panel'}`], { shown });
  };

  // An agent's token reads the anonymized view; the owner's terminal reads its own records.
  const agentCaller = Boolean(io.env[AGENT_ENV.coreUrl] && io.env[AGENT_ENV.token] && io.env[AGENT_ENV.threadId]);
  /** `--rules-file`, read from where the command runs. */
  const readRules = (path: string): string => readFileSync(absolute(io.cwd, path), 'utf8');
  const commands: Record<string, () => Promise<void | number>> = {
    'journal-check': async () => {
      if (rest.length !== 0 && rest.length !== 2) throw new Usage('journal-check expects no arguments or a cursor table and rowid');
      const cursor = rest.length ? { table: rest[0] as import('@boite/contracts').JournalInspectionTable, afterRowid: Number(rest[1]) } : null;
      if (parsed.limit !== undefined && parsed.limit > 200) throw new Usage('journal-check takes --limit up to 200');
      const result = await client.call('journal.inspect', { cursor, limit: parsed.limit ?? 100 });
      print([`checked: ${result.checked}; issues: ${result.issues.length}; more: ${result.truncated ? 'yes' : 'no'}`,
        ...result.issues.map(issue => `${issue.table} row ${issue.rowId}: ${issue.code} (${issue.field}: ${issue.expected})`),
        ...(result.cursor ? [`next: boite journal-check ${result.cursor.table} ${result.cursor.afterRowid}`] : [])], result);
    },
    pr: async () => {
      const action = rest[0] ?? 'list';
      if (!['list', 'refresh', 'link', 'unlink', 'watch', 'unwatch'].includes(action) || rest.length > (action === 'list' || action === 'refresh' ? 1 : 2)) throw new Usage('pr expects list, refresh, link <url>, unlink <url>, watch [<url|number>] or unwatch [<url|number>]');
      if (action === 'watch') {
        const watch = await client.call('threads.watchPullRequest', { threadId, ...(rest[1] === undefined ? {} : { url: rest[1] }) });
        print([`watching #${watch.number} ${watch.url}: ${watchStatus(watch)}`, 'Boite wakes this thread when it changes: end your turn, do not poll.'], watch);
        return;
      }
      if (action === 'unwatch') {
        const left = await client.call('threads.unwatchPullRequest', { threadId, ...(rest[1] === undefined ? {} : { url: rest[1] }) });
        print(left.length ? left.map(watch => `still watching #${watch.number} ${watch.url}: ${watchStatus(watch)}`) : ['no pull request watched'], left);
        return;
      }
      const result = action === 'link' || action === 'unlink'
        ? await client.call(action === 'link' ? 'threads.linkPullRequest' : 'threads.unlinkPullRequest', { threadId, url: want(1, 'a pull request URL') })
        : await client.call('threads.pullRequests', { threadId, refresh: action === 'refresh' });
      print(result.map(pr => `${pr.state} #${pr.number} ${pr.title} (${pr.head} -> ${pr.base}) ${pr.url}${pr.error ? ` [${pr.error}]` : ''}`), result);
    },
    browser: async () => {
      if (rest[0] === 'help') { print([BROWSER_HELP], { help: BROWSER_HELP }); return; }
      const result = rest[0] === 'run' ? await browserRun(rest.slice(1), io, client, threadId)
        : rest[0] === 'recipe' ? await browserRecipe(rest.slice(1), io, client, threadId)
        : await browserCommand(rest, io, client, threadId);
      print(result.lines, result.value);
    },
    device: async () => {
      const result = await deviceCommand(rest, io, client, threadId, parsed.timeout);
      print(result.lines, result.value);
    },
    window: async () => {
      const result = await windowCommand(rest, io, client, threadId);
      print(result.lines, result.value);
    },
    desktop: async () => childOutput(await (await import('./desktop-cli.ts')).desktopCommand(rest, io, client, threadId), parsed.json, io, print),
    secret: async () => childOutput(await secretCommand(rest, io, client, threadId), parsed.json, io, print),
    // `boite --limit 5 logs` parsed them as globals: they come first, so the command's own flags still win.
    // A global `--level` yields to the command's own `--min-level`, which it would otherwise override.
    logs: () => logsCommand([...(parsed.limit === undefined ? [] : ['--limit', String(parsed.limit)]), ...(parsed.level === undefined || rest.some(entry => entry === '--min-level' || entry.startsWith('--min-level=')) ? [] : ['--level', parsed.level]), ...rest], client, threadId, agentCaller, io.cwd, print),
    issue: () => issueCommand(rest, client, threadId, agentCaller, io.cwd, print),
    server: async () => {
      const action = rest[0] ?? 'check';
      if (!['check', 'update', 'cancel'].includes(action)) throw new Usage('server expects check, update or cancel');
      let state = action === 'cancel' ? await client.call('core.updateCancel', {}) : await client.call('core.updateStatus', { refresh: true });
      if (action === 'update') {
        if (state.mode !== 'systemd') throw new Error('This server needs a standalone Linux systemd user installation for automatic updates; see docs/server.md');
        if (state.phase === 'error') throw new Error(state.error ?? 'Server update check failed');
        if (state.version && state.phase === 'available') state = await client.call('core.updateInstall', { version: state.version });
      }
      print([`server: ${state.currentVersion}`, `update: ${state.phase}`, ...(state.version ? [`version: ${state.version}`] : []), ...(state.error ? [`error: ${state.error}`] : [])], state);
    },
    bot: async () => {
      if (rest[0] === 'event') {
        if (rest.length < 3) throw new Usage('bot event needs a bot and the text: boite bot event <bot> [--key <key>] <text>');
        const sent = await client.call('agents.event', { agent: rest[1]!, text: rest.slice(2).join(' '), ...(parsed.key === undefined ? {} : { key: parsed.key }) });
        print([`event: ${sent.key} for ${sent.agentId}`, 'It wakes the bot once its thread is free; a later event with the same key replaces it until then.'], sent);
        return;
      }
      const result = await botCommand(client, threadId, rest);
      print([JSON.stringify(result)], result);
    },
    attach: async () => {
      const message = await client.call('artifacts.publish', { threadId, path: absolute(io.cwd, want(0, 'a file')) });
      print([`attached: ${rest[0]}`, `message: ${message.id}`], message);
    },
    delegate: async () => {
      if (rest[0] === undefined) throw new Usage(`delegate needs ${DELEGATE_ACTIONS}`);
      await delegateCommand(client, threadId, rest, {
        ...(parsed.project === undefined ? {} : { project: parsed.project }),
        ...(parsed.requestId === undefined ? {} : { requestId: parsed.requestId }), ...(parsed.timeout === undefined ? {} : { timeout: parsed.timeout }),
        ...(parsed.title === undefined ? {} : { title: parsed.title }), ...(parsed.model === undefined ? {} : { model: parsed.model }),
        ...(parsed.effort === undefined ? {} : { effort: parsed.effort }), ...(parsed.speed === undefined ? {} : { speed: parsed.speed }), ...(parsed.profile === undefined ? {} : { profile: parsed.profile }),
        ...(parsed.worktree === true ? { worktree: true } : {}), ...(parsed.machine === undefined ? {} : { machine: parsed.machine }),
        ...(parsed.context === undefined ? {} : { context: contextRequest(parsed, readRules) }),
      }, print);
    },
    // `threads` alone or `threads list` lists (control-cli.ts); the rest talks to other threads.
    threads: async () => {
      try {
        await agentsCommand(client, threadId, rest, { ...(parsed.requestId === undefined ? {} : { requestId: parsed.requestId }), wait: parsed.wait, ...(parsed.timeout === undefined ? {} : { timeout: parsed.timeout }), ...(parsed.last === undefined ? {} : { last: parsed.last }), ...(parsed.before === undefined ? {} : { before: parsed.before }) }, print);
      } catch (error) {
        if (error instanceof AgentsUsage) throw new Usage(error.message);
        throw error;
      }
    },
    workflow: async () => {
      await workflowCommand(client, threadId, rest, io, print, parsed.requestId);
    },
    where: async () => {
      const where = await client.call('agent.where', { threadId });
      print(
        [
          `thread: ${where.threadId}`,
          `title: ${where.title}`,
          `project: ${where.projectPath}`,
          `cwd: ${where.cwd}`,
          `branch: ${where.branch ?? '(none)'}`,
          `worktree: ${where.worktree ? 'yes' : 'no'}`,
          `agent: ${where.providerId} ${where.model}`,
        ],
        where,
      );
    },
    projects: async () => {
      if (caller === 'owner' && threadId === '') {
        if (rest.length > 0 && rest[0] !== 'add') throw new Usage(`projects: unknown action ${rest[0]}`);
        if (rest[0] === 'add') {
          const folder = requiredText(rest, 1, 'projects add needs a folder');
          const project = await client.call('projects.add', { path: absolute(io.cwd, folder), ...(parsed.name === undefined ? {} : { name: parsed.name }) });
          print([`project: ${project.id}`, `name: ${project.name}`, `path: ${project.path}`, `git: ${project.repository ? 'yes' : 'no'}`], project);
          return;
        }
        const projects = await client.call('projects.list', {});
        print(projects.filter(p => p.archived !== true).map(p => `${p.id} ${JSON.stringify(p.name)} ${p.path}${p.repository ? '' : ' no-git'}${p.kind === 'drafts' ? ' drafts' : ''}`), projects);
        return;
      }
      if (rest.length > 0) {
        if (rest[0] !== 'add') throw new Usage(`projects: unknown action ${rest[0]}`);
        const folder = rest.slice(1).join(' ').trim();
        if (folder.length === 0) throw new Usage('projects add needs a folder');
        const project = await client.call('agent.addProject', { threadId, path: absolute(io.cwd, folder), ...(parsed.name === undefined ? {} : { name: parsed.name }) });
        print([
          `project: ${project.id}`, `name: ${project.name}`, `path: ${project.path}`, `git: ${project.repository ? 'yes' : 'no'}`,
          project.added ? 'Added. boite thread new and boite thread move accept it by name, id or folder.' : 'Already a project; nothing changed.',
        ], project);
        return;
      }
      const projects = await client.call('agent.projects', { threadId });
      print(projects.map(p => `${p.id} ${JSON.stringify(p.name)} ${p.path}${p.current ? ' (this thread)' : ''}${p.repository ? '' : ' no-git'}${p.drafts ? ' drafts' : ''}`), projects);
    },
    thread: async () => {
      const action = want(0, 'move or new');
      if (action === 'new' && caller === 'owner') {
        if (parsed.machine !== undefined) throw new Usage('thread new --machine is for an agent in a thread; from a terminal, reach that machine with --core');
        // From a terminal the brief is the user's own prompt, not an agent's.
        await ownerThreadNew(client, parsed, rest, print, contextRequest(parsed, readRules));
        return;
      }
      if (action === 'new') {
        const project = want(1, 'a project name, id or folder (boite projects lists them)');
        const prompt = requiredText(rest, 2, 'thread new needs a brief after the project');
        const spawned = await client.call('agent.spawn', {
          threadId, project, prompt, requestId: parsed.requestId ?? crypto.randomUUID(),
          ...(parsed.title === undefined ? {} : { title: parsed.title }), ...(parsed.worktree ? { worktree: true } : {}),
          ...(parsed.machine === undefined ? {} : { machine: parsed.machine }),
          ...(parsed.model === undefined ? {} : { model: parsed.model }), ...(parsed.effort === undefined ? {} : { effort: parsed.effort }), ...(parsed.speed === undefined ? {} : { speed: parsed.speed }),
          ...(parsed.context === undefined ? {} : { context: contextRequest(parsed, readRules) as RpcParams<'agent.spawn'>['context'] }),
        });
        // A bot hears of it through events on its desk, not as a message, on this machine or another.
        const persistent = await client.call('agents.snapshot', { threadId }).then(snapshot => snapshot.profiles.length > 0, () => false);
        const machine = spawned.machine ?? parsed.machine;
        print(spawnedLines(spawned, machine, persistent), spawned);
        return;
      }
      if (action !== 'move') throw new Usage(`thread: unknown action ${action}`);
      const project = requiredText(rest, 1, 'thread move needs a project name, id or folder');
      const moved = await client.call('agent.move', { threadId, project });
      const where = moved.cwd ?? `a new folder of ${moved.projectPath}`;
      const background = moved.stopsBackground ? ' Background work stops then.' : '';
      print(
        moved.when === 'turn-end'
          ? [`Moves to ${moved.project} (${moved.projectPath}) when this turn ends; the next turn starts in ${where}.${background}`]
          : [`Moved to ${moved.project} (${moved.projectPath}); the next turn starts in ${where}.${background}`],
        moved,
      );
    },
    show: async () => {
      const { path, line } = splitLine(want(0, 'a file'));
      await opened({ kind: 'file', path: absolute(io.cwd, path), ...(line === undefined ? {} : { line }) });
    },
    diff: async () => {
      const path = rest[0];
      await opened(path === undefined ? { kind: 'diff' } : { kind: 'diff', path: absolute(io.cwd, path) });
    },
    browse: async () => {
      const target = want(0, 'a url or an HTML file');
      if (!/^https?:/i.test(target) && /\.html?$/i.test(target)) {
        const result = await client.call('artifacts.preview', { threadId, path: absolute(io.cwd, target) });
        print([`preview: ${result.url}`, `shown: ${result.shown}`], result);
      } else await opened({ kind: 'browser', url: target });
    },
    view: async () => {
      if (rest[0] === 'help' || rest[0] === undefined) { print([VIEW_HELP], { help: VIEW_HELP }); return; }
      if (rest[0] === 'example') { print([VIEW_EXAMPLE], { example: VIEW_EXAMPLE }); return; }
      if (rest[0] === 'check') {
        const result = await viewCheckCommand(rest.slice(1), io.cwd, client, threadId);
        print(result.lines, result.value);
        return result.code;
      }
      const result = await client.call('artifacts.view', { threadId, path: absolute(io.cwd, want(0, 'an HTML file')), ...(parsed.title === undefined ? {} : { title: parsed.title }) });
      const view = result.message.parts[0]?.type === 'artifact' ? result.message.parts[0].view : undefined;
      const source = view?.source ?? rest[0]!;
      const line = `![${(view?.title ?? '').replace(/[\s[\]]+/g, ' ').trim()}](${/[\s()<>]/.test(source) ? `<${source}>` : source})`;
      print([
        `view: ${view?.title ?? rest[0]}`,
        result.checked
          ? `checked: loaded without an error, ${view?.height}px tall on a desktop${view?.narrowHeight ? `, ${view.narrowHeight}px on a phone` : ''}`
          : 'checked: no, this machine has no browser to load it in; read the page once more before you answer',
        `place: ${line} alone on a line of your answer, right after the paragraph it explains. Without that line it is drawn under your final text when this turn ends. Do not announce it or repeat what it shows.`,
        ...result.advice.map(advice => `advice: ${advice}`),
      ], result);
    },
    preview: async () => {
      const result = await client.call('artifacts.preview', { threadId, path: absolute(io.cwd, want(0, 'an HTML file')) });
      print([`preview: ${result.url}`, `shown: ${result.shown}`], result);
    },
    'preview-close': async () => {
      const result = await client.call('artifacts.previewClose', { threadId, path: absolute(io.cwd, want(0, 'an HTML file')) });
      print(['preview closed'], result);
    },
    open: async () => {
      const kind = want(0, 'trace, tasks, changes, files or workflow');
      if (kind === 'trace' || kind === 'tasks') await opened({ kind });
      else if (kind === 'workflow') await opened(rest[1] === undefined ? { kind } : { kind, runId: rest[1] });
      else if (kind === 'changes') await opened({ kind: 'diff' });
      else if (kind === 'files') {
        const dir = rest[1];
        await opened(dir === undefined ? { kind: 'files' } : { kind: 'files', path: absolute(io.cwd, dir) });
      } else throw new Usage(`open: unknown surface ${kind}`);
    },
    settings: async () => {
      const action = rest[0];
      if (action === 'request' || action === 'open') {
        if (parsed.why === undefined || parsed.why.trim().length === 0) throw new Usage(`settings ${action} needs --why <text>, the reason the user reads on the card`);
        const params = action === 'request'
          ? { threadId, reason: parsed.why, key: want(1, 'a setting key (boite settings lists them)'), value: settingValue(requiredText(rest, 2, 'settings request needs a value after the key', false)),
              ...(parsed.machine === undefined ? {} : { machine: parsed.machine }) }
          : { threadId, reason: parsed.why, ...settingsPlace(want(1, `a page: ${SETTINGS_PAGES.join(', ')}`)) };
        if (action === 'open' && rest.length > 2) throw new Usage('settings open takes one page, with an optional #card');
        const asked = await client.call('settings.request', params);
        const setting = asked.setting;
        print([
          `requested: ${asked.questionId}`,
          ...(setting.kind === 'change'
            ? [`change: ${setting.key} ${JSON.stringify(setting.previous)} -> ${JSON.stringify(setting.value)}${setting.machine === undefined ? '' : ` on ${setting.machine.name}`}`, typeof setting.value === 'boolean' ? 'card: the switch itself, in the chat' : 'card: Apply in the chat, or open Settings at the setting']
            : [`card: opens Settings at ${setting.section === null ? setting.page : `${setting.page}#${setting.section}`}`]),
          'Keep working. The outcome arrives as a message quoting your reason; without one, nothing changed.',
        ], asked);
        return;
      }
      if (action === 'bot') {
        const agent = parsed.bot === undefined ? {} : { agent: parsed.bot };
        if (rest[1] === 'create') {
          if (rest.length !== 3) throw new Usage('settings bot create takes one name; quote a name with spaces');
          const created = await client.call('agents.create', {
            threadId, name: rest[2]!,
            ...(parsed.domain === undefined ? {} : { domain: parsed.domain }),
            ...(parsed.instructionsFile === undefined ? {} : { instructions: readRules(parsed.instructionsFile) }),
            ...(parsed.model === undefined ? {} : { model: parsed.model }),
            ...(parsed.effort === undefined ? {} : { effort: parsed.effort }),
            ...(parsed.project === undefined ? {} : { projects: parsed.project.split(',').map(name => name.trim()).filter(Boolean) }),
          });
          const { agent: bot, threadId: conversation } = created;
          const { selection } = bot;
          print([
            `created: ${bot.name} (${bot.id})`,
            `route: ${selection.providerId}/${selection.model ?? 'default'}${selection.effort === null ? '' : ` (${selection.effort})`}`,
            ...(bot.projectIds?.length ? [`projects: ${bot.projectIds.join(', ')}`] : []),
            ...(conversation === null ? [] : [`conversation: ${conversation}; boite threads send ${conversation} <text> writes to it`]),
            'It introduces itself and schedules what its instructions call for.',
          ], created);
          return;
        }
        if (rest[1] === 'request') {
          if (parsed.why === undefined || parsed.why.trim().length === 0) throw new Usage('settings bot request needs --why <text>, the reason the user reads on the card');
          const key = want(2, `a key: ${AGENT_SETTING_KEYS.join(', ')}`);
          const fromFile = key === 'instructions' && parsed.instructionsFile !== undefined;
          if (fromFile ? rest.length > 3 : rest.length < 4) throw new Usage(fromFile ? 'settings bot request instructions takes the text or --instructions-file <path>, not both' : 'settings bot request needs a value after the key');
          const value = fromFile ? readRules(parsed.instructionsFile!) : agentSettingArg(key, rest.slice(3));
          const asked = await client.call('agents.settings.request', { threadId, reason: parsed.why, key, value, ...agent });
          const setting = asked.setting;
          print([
            `requested: ${asked.questionId}`,
            `change: ${setting.agentName}'s ${setting.key} ${clipped(JSON.stringify(setting.previous))} -> ${clipped(JSON.stringify(setting.value))}`,
            'card: Apply, or the user changes it in the bot\'s settings',
            'Keep working. The outcome arrives as a message quoting your reason; without one, nothing changed.',
          ], asked);
          return;
        }
        if (rest.length > 2) throw new Usage('settings bot expects a key, request <key> <value> or create <name>');
        const read = await client.call('agents.settings.read', { threadId, ...agent });
        const shown = rest[1] === undefined ? read.settings : read.settings.filter(reading => reading.key === rest[1]);
        if (shown.length === 0) throw new Usage(`settings bot: unknown key ${rest[1]}; the keys are ${AGENT_SETTING_KEYS.join(', ')}`);
        const named = (reading: (typeof shown)[number], value: unknown): string => {
          const text = JSON.stringify(reading.key === 'projects' && Array.isArray(value) ? value.map(id => reading.choices?.find(choice => choice.id === id)?.label ?? id) : value ?? null);
          return rest[1] === undefined ? clipped(text) : text;
        };
        // Every provider's models make a long list: the full view cuts it, `settings bot model` shows it whole.
        const choices = (reading: (typeof shown)[number]): string => {
          const text = (reading.choices ?? []).map(choice => choice.label === choice.id ? choice.id : `${choice.label} (${choice.id})`).join(', ');
          return rest[1] === undefined ? clipped(text, 600) : text;
        };
        print([
          `bot: ${read.agentName} (${read.agentId})`,
          ...shown.map(reading => `${reading.key} ${named(reading, reading.value)}${reading.choices?.length ? `\n    choices: ${choices(reading)}` : ''}`),
        ], rest[1] === undefined ? read : shown[0]);
        return;
      }
      if (rest.length > 1) throw new Usage('settings expects a key, request <key> <value> or open <page>');
      const read = await client.call('agent.settings', { threadId });
      const shown = action === undefined ? read.settings : read.settings.filter(reading => reading.key === action);
      if (shown.length === 0) throw new Usage(`settings: unknown key ${action}; boite settings lists them`);
      const rows = shown.map(reading => `${reading.key} ${JSON.stringify(reading.value)} ${reading.page}#${reading.section}${reading.label === undefined ? '' : ` ${JSON.stringify(reading.label)}`}${reading.sensitive ? ' (sensitive)' : ''}`);
      print(action === undefined ? [appLine(read.app), ...rows] : rows, action === undefined ? read : shown[0]);
    },
    ask: async () => {
      // An agent once ran `boite ask help` for this text and drew a card reading "help".
      if (rest.length === 1 && rest[0] === 'help') { print([USAGE], { help: USAGE }); return; }
      if (rest.length === 1 && rest[0] === 'list') {
        await controlCommand(client, caller, threadId, { ...parsed, positional: ['questions', threadId] }, print);
        return;
      }
      const text = want(0, 'a question');
      const options = rest.slice(1);
      const asked = await client.call('questions.ask', { threadId, text, ...(options.length > 0 ? { options } : {}), ...(parsed.multiple ? { multiple: true } : {}), ...(parsed.open === undefined ? {} : { open: parsed.open }) });
      print([`asked: ${asked.questionId}`, 'Keep working. The answer arrives as a message quoting the question; without one, go on with a sensible default.'], asked);
    },
    status: async () => {
      const status = await client.call('git.status', { threadId });
      const head = [`branch: ${status.branch ?? '(detached)'}`];
      if (status.upstream !== null) head.push(`upstream: ${status.upstream} +${status.ahead} -${status.behind}`);
      head.push(`changes: ${status.changes.length}`);
      print([...head, ...status.changes.map(changeRow)], status);
    },
    task: async () => {
      const action = want(0, 'list, add, start, done, remove or clear');
      const tasks = await client.call('threads.tasks.get', { threadId });
      if (action === 'list') {
        print(tasks.length === 0 ? ['tasks: none'] : tasks.map(taskRow), tasks);
        return;
      }
      let next: AgentTask[];
      if (action === 'add') {
        const text = requiredText(rest, 1, 'task add needs a text');
        next = [...tasks, { id: nextTaskId(tasks), text, status: 'pending' }];
      } else if (action === 'clear') next = [];
      else if (action === 'start' || action === 'done' || action === 'remove') {
        const id = taskId(want(1, 'a task id'));
        if (!tasks.some((task) => task.id === id)) throw new Error(`no task ${id}`);
        const status: AgentTask['status'] = action === 'start' ? 'in_progress' : 'completed';
        next = action === 'remove'
          ? tasks.filter((task) => task.id !== id)
          : tasks.map((task) => (task.id === id ? { ...task, status } : task));
      } else throw new Usage(`task: unknown action ${action}`);
      const activity = await client.call('threads.tasks.set', { threadId, tasks: next });
      print(activity.tasks.length === 0 ? ['tasks: none'] : activity.tasks.map(taskRow), activity.tasks);
    },
    todo: async () => {
      const action = want(0, 'list, add or claim');
      if (action === 'list') {
        const todos = await client.call('todos.list', { threadId });
        print(todos.length === 0 ? ['todos: none'] : todos.map(todoRow), todos);
      } else if (action === 'add') {
        const text = requiredText(rest, 1, 'todo add needs a text');
        const todo = await client.call('todos.add', { threadId, text });
        print([todoRow(todo)], todo);
      } else if (action === 'claim') {
        const todo = await client.call('todos.update', { threadId, todoId: want(1, 'a todo id'), status: 'claimed' });
        print([todoRow(todo)], todo);
      } else throw new Usage(`todo: unknown action ${action}`);
    },
    goal: async () => {
      const action = want(0, 'track');
      if (action !== 'track') throw new Usage(`goal: unknown action ${action}`);
      const activity = await client.call('threads.goal.track', { threadId });
      // This turn is the goal's first: its claim counts, so the agent learns the marker here.
      print([`goal: reviewed, tracking the user's last prompt (${activity.goal?.objective.length ?? 0} characters)`, 'when it is done and verified, end this turn with [BOITE_GOAL_COMPLETE] alone on its last line; a reviewer then checks it'], activity);
    },
  };
  const handler = command !== undefined && Object.hasOwn(commands, command) ? commands[command] : undefined;
  if (handler === undefined) throw new Usage(`unknown command ${command}`);
  return handler();
}

/** The exit code: 0, 1 on a refusal or a failure, 2 on a usage error. */
export async function runCli(argv: string[], io: CliIo): Promise<number> {
  let parsed: Parsed;
  try {
    parsed = parse(argv);
    if (parsed.positional.length === 0 || parsed.positional[0] === 'help') throw new Usage('');
  } catch (error) {
    if (error instanceof Usage) {
      io.err((error.message.length === 0 ? USAGE : `${error.message}\n${USAGE}`) + '\n');
      // `boite help` asked for this text; a bare `boite` or a bad flag did not.
      return error.message.length === 0 && argv.length > 0 ? 0 : 2;
    }
    throw error;
  }

  const print: Printer = (lines, value) => {
    io.out((parsed.json ? JSON.stringify(value) : lines.join('\n')) + '\n');
  };

  let client: CoreClient | null = null;
  try {
    if (parsed.positional[0] === 'journal-check' && (io.env[AGENT_ENV.coreUrl] || io.env[AGENT_ENV.token] || io.env[AGENT_ENV.threadId])) throw new Error('boite journal-check is owner-only outside the agent environment');
    if (parsed.positional[0] === 'mcp' && (!io.env[AGENT_ENV.coreUrl] || !io.env[AGENT_ENV.token] || !io.env[AGENT_ENV.threadId])) {
      throw new Error('boite mcp requires the thread-bound agent environment; owner credential fallback is disabled');
    }
    const target = targetOf(parsed, io.env);
    try {
      // An agent waiting for an answer holds its call up to five minutes; a secret card or command up to an hour.
      // A window capture may wait ten minutes for the owner's consent.
      const waits = parsed.positional[0] === 'threads' && (parsed.wait || parsed.positional[1] === 'wait');
      const requestTimeoutMs = waits ? (WAIT_MAX_S + 30) * 1000
        : parsed.positional[0] === 'secret' ? 3_660_000
        : parsed.positional[0] === 'window' ? WINDOW_REQUEST_TIMEOUT_MS : undefined;
      client = await connect(target.url, target.token, { client: { name: 'cli', version: CORE_VERSION }, ...(requestTimeoutMs === undefined ? {} : { requestTimeoutMs }) });
    } catch (error) {
      throw new Error(`no core answers at ${target.url}: ${(error as Error).message}`);
    }
    if (parsed.positional[0] === 'mcp') {
      if (parsed.positional.length !== 1 || parsed.json) throw new Usage('boite mcp takes no positional arguments or --json');
      const { runBoiteMcp } = await import('./mcp/server.ts');
      await runBoiteMcp(client, target.threadId, io.err, () => connect(target.url, target.token, { client: { name: 'mcp-wait', version: CORE_VERSION }, requestTimeoutMs: 3_605_000 }));
    } else {
      const caller: Caller = io.env[AGENT_ENV.coreUrl] && io.env[AGENT_ENV.token] && io.env[AGENT_ENV.threadId] ? 'agent' : 'owner';
      const code = await run(parsed, io, client, target.threadId, print, caller);
      if (typeof code === 'number') return code;
    }
    return 0;
  } catch (error) {
    if (error instanceof Usage) {
      io.err(`${error.message}\n${USAGE}\n`);
      return 2;
    }
    io.err(`error: ${(error as Error).message}\n`);
    return 1;
  } finally {
    client?.close();
  }
}

export function processIo(): CliIo {
  return {
    out: (text) => process.stdout.write(text),
    err: (text) => process.stderr.write(text),
    env: process.env,
    cwd: process.cwd(),
    stdin: () => Bun.stdin.text(),
  };
}

/** One line on what a watch last saw, for `boite pr watch` and `unwatch`. */
export function watchStatus(watch: import('@boite/contracts').PullRequestWatch): string {
  const paused = watch.paused ? `paused until ${new Date(watch.paused.until).toISOString()} (${watch.paused.reason === 'rate-limit' ? 'GitHub rate limit' : watch.paused.message})` : null;
  const seen = watch.seen;
  if (!seen) return paused ?? 'not read yet';
  const { total, running, failed } = seen.checks;
  const checks = total === 0 ? 'no checks' : `${total} checks, ${running} running, ${failed} failed`;
  const queue = seen.queue ? `merge queue position ${seen.queue.position}` : null;
  return [`head ${seen.head}`, checks, seen.conflicting ? `conflicts with ${seen.base}` : null, seen.behind ? `behind ${seen.base}` : null, queue, paused].filter(Boolean).join('; ');
}

/**
 * The first line of `boite settings`: which language the user reads Boite in,
 * so the agent names a setting the way the screen does, and where experiments
 * come from.
 */
function appLine(app: SettingsReading['app']): string {
  if (app === null) return 'app: no Boite app has reported yet; experiments are unknown and names are the keys';
  const language = app.language === 'fr' ? 'French' : 'English';
  const where = app.client === 'shell' ? `the desktop app${app.device === null ? '' : ` on ${JSON.stringify(app.device)}`}` : app.device === null ? 'the web app' : `the web app on a ${app.device}`;
  return `app: ${where} speaks ${language}; quoted names are what the user sees there, experiments are that app's own`;
}
