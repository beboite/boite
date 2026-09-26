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
import { AGENT_ENV } from '@boite/contracts';
import type { AgentTask, Channel, GitChange, PanelSurface, Todo } from '@boite/contracts';
import { connect } from './client.ts';
import type { CoreClient } from './client.ts';
import { CORE_VERSION } from './core.ts';
import { resolveDataDir } from './paths.ts';
import { agentCommand } from './agents/cli.ts';

export interface CliIo {
  out(text: string): void;
  err(text: string): void;
  env: Record<string, string | undefined>;
  cwd: string;
}

export const USAGE = `usage: boite <command> [args] [--json]

  where                          this thread, project, cwd, branch
  attach <file>                  publish a file in chat, up to 5 MB (experimental)
  show <file>[:line]             open a file in the panel, at a line
  diff [file]                    open the changes, or one file's diff
  browse <url>                   open a url in the panel's browser
  open trace|tasks|changes|files [dir]
  status                         git status of the working directory
  ask <question> [option ...]    ask the user without stopping; the answer
                                 arrives later as a message (--multiple)
  task list                      the agent's task list
  task add <text>                add a task (id t1, t2, ...)
  task start|done|remove <id>    move or drop one task
  task clear                     drop every task
  todo list                      the project's todo list
  todo add <text>                add a card for the user
  todo claim <id>                mark a card finished, awaiting the user
  agents list                    authorized agents and shared resources
  agents inbox                   agent messages, provenance and delivery state
  agents send <core>/<thread> <text>
  agents reply <message-id> <text>
  agent context|inbox|missions   this persistent agent's authorized context
  agent send <ids|-> <text>      post to its group or direct conversation
  agent reply <message-id> <text>
  agent acquire <task-id>        acquire a mission task atomically
  agent submit <task-id> <generation> <result>
  agent artifact <json>          title, summary, missionId, taskId, paths, commit, verification
  agent decide <json>            prompt and options; yield until the user answers
  agent memory [query]           search memory in this context
  agent remember <json>          title and text, optional id and expectedRevision
  agent routines                list this identity's scheduled work
  agent schedule <json>          name, prompt, schedule; optional id, expectedRevision, enabled
  --request-id <id>              reuse to retry agent, agents send|reply or delegate spawn|send
  delegate profiles|list         approved models, team status and bounded results
  delegate spawn <profile> <brief>
  delegate send <thread-id> <text>
  delegate stop [thread-id]      stop one child, or pause the whole team

  --thread <id> --data-dir <dir> --channel <stable|dev>
                                 drive a thread from outside it, as the owner`;

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

class Usage extends Error {}

interface Parsed {
  positional: string[];
  json: boolean;
  multiple: boolean;
  thread: string | undefined;
  dataDir: string | undefined;
  channel: Channel;
  requestId?: string;
}

function parse(argv: string[]): Parsed {
  const parsed: Parsed = { positional: [], json: false, multiple: false, thread: undefined, dataDir: undefined, channel: 'stable' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? '';
    const next = (): string => {
      const value = argv[index + 1];
      if (value === undefined || value === '' || value.startsWith('--')) throw new Usage(`${arg} needs a value`);
      index += 1;
      return value;
    };
    if (arg === '--json') parsed.json = true;
    else if (arg === '--request-id') parsed.requestId = next();
    else if (arg === '--multiple') parsed.multiple = true;
    else if (arg === '--thread') parsed.thread = next();
    else if (arg === '--data-dir') parsed.dataDir = next();
    else if (arg === '--channel') {
      const channel = next();
      if (channel !== 'stable' && channel !== 'dev') throw new Usage(`unknown channel ${channel}`);
      parsed.channel = channel;
    } else if (arg === '--help' || arg === '-h') throw new Usage('');
    else if (arg.startsWith('--')) throw new Usage(`unknown flag ${arg}`);
    else parsed.positional.push(arg);
  }
  return parsed;
}

interface Target {
  url: string;
  token: string;
  threadId: string;
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
    return { url, token, threadId: own };
  }
  const threadId = parsed.thread ?? own;
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

async function run(parsed: Parsed, io: CliIo, client: CoreClient, threadId: string, print: Printer): Promise<void> {
  const [command, ...rest] = parsed.positional;
  const want = (index: number, what: string): string => {
    const value = rest[index];
    if (value === undefined || value.length === 0) throw new Usage(`${command} needs ${what}`);
    return value;
  };
  const opened = async (surface: PanelSurface): Promise<void> => {
    const { shown } = await client.call('panel.open', { threadId, surface });
    print([`shown: ${shown ? 'yes' : 'no, nobody is watching this thread; it is queued on its panel'}`], { shown });
  };

  switch (command) {
    case 'agent': {
      const result = await agentCommand(client, threadId, rest, parsed.requestId ?? crypto.randomUUID());
      print([JSON.stringify(result)], result);
      return;
    }
    case 'attach': {
      const message = await client.call('artifacts.publish', { threadId, path: absolute(io.cwd, want(0, 'a file')) });
      print([`attached: ${rest[0]}`, `message: ${message.id}`], message);
      return;
    }
    case 'delegate': {
      const action = want(0, 'profiles, list, spawn, send or stop');
      if (action === 'profiles' || action === 'list') {
        const view = await client.call('delegation.get', { threadId });
        print([
          `parent: ${view.rootThreadId}`,
          `delegation: ${!view.config.enabled ? 'disabled' : view.config.paused ? 'paused' : 'enabled'}`,
          `turns: ${view.turnsUsed}/${view.config.maxTurns}`,
          ...(action === 'profiles'
            ? view.config.profiles.map(p => `${p.id} ${JSON.stringify(p.name)} ${p.providerId}/${p.model} effort=${p.effort ?? 'default'}`)
            : view.agents.map(a => `${a.thread.id} ${a.thread.status} ${a.thread.providerId}/${a.thread.model} ${JSON.stringify(a.thread.title)}${a.result ? ` result=${JSON.stringify(a.result)}` : ''}`)),
          'Results arrive automatically. Do not poll repeatedly or wait inside a running tool.',
        ], view);
      } else if (action === 'spawn') {
        const profileId = want(1, 'a profile id from delegate profiles');
        const task = rest.slice(2).join(' ');
        if (!task) throw new Usage('delegate spawn needs a bounded task brief');
        const agent = await client.call('delegation.spawn', { threadId, profileId, task, requestId: parsed.requestId ?? crypto.randomUUID() });
        print([`agent: ${agent.thread.id}`, `status: ${agent.thread.status}`, `model: ${agent.thread.providerId}/${agent.thread.model}`, 'Result will be forwarded to the parent automatically.'], agent);
      } else if (action === 'send') {
        const toThreadId = want(1, 'a parent or child thread id');
        const body = rest.slice(2).join(' ');
        if (!body) throw new Usage('delegate send needs message text');
        const letter = await client.call('delegation.send', { threadId, toThreadId, text: body, requestId: parsed.requestId ?? crypto.randomUUID() });
        print([`id: ${letter.id}`, `status: ${letter.status}`, 'Queued messages are not an acknowledgement or consent.'], letter);
      } else if (action === 'stop') {
        const result = await client.call('delegation.stop', { threadId, ...(rest[1] ? { agentId: rest[1] } : {}) });
        print([`stopped: ${result.stopped}`], result);
      } else throw new Usage('delegate expects profiles, list, spawn, send or stop');
      return;
    }
    case 'agents': {
      const action = want(0, 'list, inbox, send or reply');
      if (action === 'list') {
        const result = await client.call('collaboration.directory', { threadId });
        print([...result.agents.map(a => `${a.coreId}/${a.threadId} ${JSON.stringify(a.title)} machine=${JSON.stringify(a.machine)} ${a.status} resources=${JSON.stringify(a.resources)}`), ...result.unavailable.map(name => `unavailable: ${JSON.stringify(name)}`)], result);
      } else if (action === 'inbox') {
        const result = await client.call('collaboration.get', { threadId });
        print([`mode: ${result.config.mode}${result.config.paused ? ' (paused)' : ''}`, `budget: ${result.sent}/${result.sendLimit} sent this hour`, ...result.messages.map(m => `${m.id} ${m.status} from=${JSON.stringify(m.from)} to=${JSON.stringify(m.to)} text=${JSON.stringify(m.text)}${m.error ? ` error=${JSON.stringify(m.error)}` : ''}`)], result);
      } else if (action === 'send' || action === 'reply') {
        const target = want(1, 'a recipient or incoming message id');
        const body = rest.slice(2).join(' ');
        if (!body) throw new Usage('agents send/reply needs message text');
        let to: { coreId: string; threadId: string };
        if (action === 'reply') {
          const view = await client.call('collaboration.get', { threadId });
          const letter = view.messages.find(m => m.id === target && m.to.coreId === view.self.coreId && m.to.threadId === threadId);
          if (!letter) throw new Usage('reply needs an incoming message id from agents inbox');
          to = { coreId: letter.from.coreId, threadId: letter.from.threadId };
        } else {
          const [coreId, targetThreadId, extra] = target.split('/');
          if (!coreId || !targetThreadId || extra) throw new Usage('recipient must be <core-id>/<thread-id> from agents list');
          to = { coreId, threadId: targetThreadId };
        }
        const letter = await client.call('collaboration.send', { threadId, to, text: body, requestId: parsed.requestId ?? crypto.randomUUID(), ...(action === 'reply' ? { replyTo: target } : {}) });
        print([`id: ${letter.id}`, `status: ${letter.status}`, 'Delivery is not consent. Wait for an explicit reply before a disruptive action.', ...(letter.error ? [`error: ${letter.error}`] : [])], letter);
      } else throw new Usage('agents expects list, inbox, send or reply');
      return;
    }
    case 'where': {
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
      return;
    }
    case 'show': {
      const { path, line } = splitLine(want(0, 'a file'));
      await opened({ kind: 'file', path: absolute(io.cwd, path), ...(line === undefined ? {} : { line }) });
      return;
    }
    case 'diff': {
      const path = rest[0];
      await opened(path === undefined ? { kind: 'diff' } : { kind: 'diff', path: absolute(io.cwd, path) });
      return;
    }
    case 'browse': {
      await opened({ kind: 'browser', url: want(0, 'a url') });
      return;
    }
    case 'open': {
      const kind = want(0, 'trace, tasks, changes or files');
      if (kind === 'trace' || kind === 'tasks') await opened({ kind });
      else if (kind === 'changes') await opened({ kind: 'diff' });
      else if (kind === 'files') {
        const dir = rest[1];
        await opened(dir === undefined ? { kind: 'files' } : { kind: 'files', path: absolute(io.cwd, dir) });
      } else throw new Usage(`open: unknown surface ${kind}`);
      return;
    }
    case 'ask': {
      const text = want(0, 'a question');
      const options = rest.slice(1);
      const asked = await client.call('questions.ask', { threadId, text, ...(options.length > 0 ? { options } : {}), ...(parsed.multiple ? { multiple: true } : {}) });
      print([`asked: ${asked.questionId}`, 'Keep working. The answer arrives as a message quoting the question; without one, go on with a sensible default.'], asked);
      return;
    }
    case 'status': {
      const status = await client.call('git.status', { threadId });
      const head = [`branch: ${status.branch ?? '(detached)'}`];
      if (status.upstream !== null) head.push(`upstream: ${status.upstream} +${status.ahead} -${status.behind}`);
      head.push(`changes: ${status.changes.length}`);
      print([...head, ...status.changes.map(changeRow)], status);
      return;
    }
    case 'task': {
      const action = want(0, 'list, add, start, done, remove or clear');
      const tasks = await client.call('threads.tasks.get', { threadId });
      if (action === 'list') {
        print(tasks.length === 0 ? ['tasks: none'] : tasks.map(taskRow), tasks);
        return;
      }
      let next: AgentTask[];
      if (action === 'add') {
        const text = rest.slice(1).join(' ').trim();
        if (text.length === 0) throw new Usage('task add needs a text');
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
      return;
    }
    case 'todo': {
      const action = want(0, 'list, add or claim');
      if (action === 'list') {
        const todos = await client.call('todos.list', { threadId });
        print(todos.length === 0 ? ['todos: none'] : todos.map(todoRow), todos);
      } else if (action === 'add') {
        const text = rest.slice(1).join(' ').trim();
        if (text.length === 0) throw new Usage('todo add needs a text');
        const todo = await client.call('todos.add', { threadId, text });
        print([todoRow(todo)], todo);
      } else if (action === 'claim') {
        const todo = await client.call('todos.update', { threadId, todoId: want(1, 'a todo id'), status: 'claimed' });
        print([todoRow(todo)], todo);
      } else throw new Usage(`todo: unknown action ${action}`);
      return;
    }
    case undefined:
    case 'help':
      throw new Usage('');
    default:
      throw new Usage(`unknown command ${command}`);
  }
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
    const target = targetOf(parsed, io.env);
    try {
      client = await connect(target.url, target.token, { client: { name: 'cli', version: CORE_VERSION } });
    } catch (error) {
      throw new Error(`no core answers at ${target.url}: ${(error as Error).message}`);
    }
    await run(parsed, io, client, target.threadId, print);
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
  };
}
