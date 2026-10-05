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
import type { AgentTask, GitChange, PanelSurface, Todo } from '@boite/contracts';
import { connect } from './client.ts';
import type { CoreClient } from './client.ts';
import { CORE_VERSION } from './version.ts';
import { resolveDataDir } from './paths.ts';
import { agentCommand } from './agents/cli.ts';
import { workflowCommand } from './workflow-cli.ts';
import { DELEGATE_ACTIONS, delegateCommand } from './delegate-cli.ts';
import { browserCommand, BROWSER_HELP } from './browser-cli.ts';
import { deviceCommand } from './device-cli.ts';
import { agentsCommand, AgentsUsage, WAIT_MAX_S } from './agents-cli.ts';
import { parse, requiredText, Usage, type Parsed } from './cli-args.ts';
import { CONTROL_HELP, controlCommand, isControlCommand, ownerThreadNew, ownerWithoutThread, type Caller } from './control-cli.ts';

export interface CliIo {
  out(text: string): void;
  err(text: string): void;
  env: Record<string, string | undefined>;
  cwd: string;
}

export const USAGE = `usage: boite <command> [args] [--json]

  mcp                            serve bounded thread-scoped tools over MCP stdio
  where                          this thread, project, cwd, branch
  thread move <project>          move this thread to another project (name,
                                 id or folder) when this turn ends
  thread new <project> <brief>   start a thread in a project; its first answer
                                 comes back as an agent message
                                 (--worktree, --title <title>)
  projects                       the projects added to Boite
  projects add <folder>          add an existing folder as a project, so thread
                                 new and thread move can name it (--name <name>)
  projects archive|unarchive|remove <p>
                                 the owner's; removing leaves the folder on disk
${CONTROL_HELP}
  attach <file>                  publish a file in chat, up to 512 MB
  show <file>[:line]             open a file in the panel, at a line
  diff [file]                    open the changes, or one file's diff
  browse <url>                   open a url in the panel's browser
  browser help                   inspect, test and capture the built-in browser
  device help                    open an iOS Simulator or Android emulator in the
                                 user's Device panel, capture and drive it
  pr list|refresh                this conversation's linked pull requests
  pr link|unlink <url>           attach or remove a PR link; does not change GitHub
  preview <file.html>             open a local HTML artifact with its assets
  preview-close <file.html>       stop serving a local HTML preview
  open trace|tasks|changes|files|workflow [dir|run-id]
  status                         git status of the working directory
  server check|update|cancel      check or update this server, or cancel the
                                 pending update; no thread needed as owner
  journal-check [table rowid]     bounded read-only journal diagnostics, owner only
  logs [--limit <n>] [--level info|warn|error]
                                 recent private diagnostics, owner only;
                                 --thread filters one conversation
  ask <question> [option ...]    ask the user without stopping; the answer
                                 arrives later as a message (--multiple)
  task list                      the agent's task list
  task add <text>                add a task (id t1, t2, ...)
  task start|done|remove <id>    move or drop one task
  task clear                     drop every task
  todo list                      the project's todo list
  todo add <text>                add a card for the user
  todo claim <id>                mark a card finished, awaiting the user
  agents list                    other agents here and on linked machines
  agents find <words>            locate agents by words of their chat, title,
                                 project, branch or model
  agents read <agent>            its conversation (--last <n>, --before <ms>)
  agents send <agent> <text>     message it; --wait blocks for its answer
  agents reply <message-id> <text>
  agents log <agent>             what you and that agent said to each other
  agents wait [agent]            the next message (--timeout <s>, default 90)
  agents inbox                   every exchange and its delivery state
                                 <agent>: <thread-id>, <machine>/<thread-id>
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
  delegate models                models and reasoning levels a subagent can use
  delegate spawn <brief>         start a subagent on one bounded job; its result
                                 comes back as a message (--model <provider/model>,
                                 --effort <level>, --title <title>, --profile <id>)
  delegate list                  every subagent and workflow: state, model, time
  delegate send <thread-id> <text>
                                 steer or reuse a subagent, or ask the parent
  delegate stop [thread-id]      stop one subagent, or all of them
  delegate wait [thread-id]      block until children finish (--timeout <s>,
                                 default 600, max 3600); only with nothing else to do
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
  deny, stewards and projects need no --thread: the owner drives every thread,
  and a message it sends is its own prompt. Inside a thread they act as the
  steward the owner made it, and its messages reach threads as the steward's.

  --core <url>                   another core, with its token in BOITE_TOKEN
                                 (an owner token, or a paired device's session)
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
    if (parsed.core !== undefined) throw new Error(`this CLI speaks for thread ${own} on its own core; --core is for a terminal`);
    return { url, token, threadId: own };
  }
  const threadId = parsed.thread ?? own ?? (['server', 'logs', 'journal-check'].includes(parsed.positional[0] ?? '') || ownerWithoutThread(parsed) ? '' : undefined);
  if (parsed.core !== undefined) {
    // The token stays out of the command line, where any process listing would show it.
    const remoteToken = env.BOITE_TOKEN || undefined;
    if (remoteToken === undefined) throw new Error('--core needs the token in BOITE_TOKEN');
    let origin: string;
    try { origin = new URL(parsed.core).origin; } catch { throw new Error(`--core: expected a URL such as https://host:3773, got ${parsed.core}`); }
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

async function run(parsed: Parsed, io: CliIo, client: CoreClient, threadId: string, print: Printer, caller: Caller): Promise<void> {
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

  const commands: Record<string, () => Promise<void>> = {
    'journal-check': async () => {
      if (rest.length !== 0 && rest.length !== 2) throw new Usage('journal-check expects no arguments or a cursor table and rowid');
      const cursor = rest.length ? { table: rest[0] as import('@boite/contracts').JournalInspectionTable, afterRowid: Number(rest[1]) } : null;
      const result = await client.call('journal.inspect', { cursor, limit: parsed.limit ?? 100 });
      print([`checked: ${result.checked}; issues: ${result.issues.length}; more: ${result.truncated ? 'yes' : 'no'}`,
        ...result.issues.map(issue => `${issue.table} row ${issue.rowId}: ${issue.code} (${issue.field}: ${issue.expected})`),
        ...(result.cursor ? [`next: boite journal-check ${result.cursor.table} ${result.cursor.afterRowid}`] : [])], result);
    },
    pr: async () => {
      const action = rest[0] ?? 'list';
      if (!['list', 'refresh', 'link', 'unlink'].includes(action) || rest.length > (action === 'link' || action === 'unlink' ? 2 : 1)) throw new Usage('pr expects list, refresh, link <url> or unlink <url>');
      const result = action === 'link' || action === 'unlink'
        ? await client.call(action === 'link' ? 'threads.linkPullRequest' : 'threads.unlinkPullRequest', { threadId, url: want(1, 'a pull request URL') })
        : await client.call('threads.pullRequests', { threadId, refresh: action === 'refresh' });
      print(result.map(pr => `${pr.state} #${pr.number} ${pr.title} (${pr.head} -> ${pr.base}) ${pr.url}${pr.error ? ` [${pr.error}]` : ''}`), result);
    },
    browser: async () => {
      if (rest[0] === 'help') { print([BROWSER_HELP], { help: BROWSER_HELP }); return; }
      const result = await browserCommand(rest, io, client, threadId);
      print([JSON.stringify(result, null, 2)], result);
    },
    device: async () => {
      const result = await deviceCommand(rest, io, client, threadId, parsed.timeout);
      print(result.lines, result.value);
    },
    logs: async () => {
      if (rest.length > 0) throw new Usage('logs takes --limit, --level and --thread filters');
      const records = await client.call('core.logs', {
        ...(parsed.limit === undefined ? {} : { limit: parsed.limit }),
        ...(parsed.level === undefined ? {} : { level: parsed.level }),
        ...(parsed.thread === undefined ? {} : { threadId: parsed.thread }),
      });
      print(records.map(record => `${new Date(record.at).toISOString()} ${record.level.toUpperCase()} ${record.source}/${record.event}${record.threadId ? ` thread=${record.threadId}` : ''}${record.turnId ? ` turn=${record.turnId}` : ''}${record.requestId ? ` request=${record.requestId}` : ''} ${record.message.replace(/[\r\n]+/g, ' ')}`), records);
    },
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
    agent: async () => {
      const result = await agentCommand(client, threadId, rest, parsed.requestId ?? crypto.randomUUID());
      print([JSON.stringify(result)], result);
    },
    attach: async () => {
      const message = await client.call('artifacts.publish', { threadId, path: absolute(io.cwd, want(0, 'a file')) });
      print([`attached: ${rest[0]}`, `message: ${message.id}`], message);
    },
    delegate: async () => {
      if (rest[0] === undefined) throw new Usage(`delegate needs ${DELEGATE_ACTIONS}`);
      await delegateCommand(client, threadId, rest, {
        ...(parsed.requestId === undefined ? {} : { requestId: parsed.requestId }), ...(parsed.timeout === undefined ? {} : { timeout: parsed.timeout }),
        ...(parsed.title === undefined ? {} : { title: parsed.title }), ...(parsed.model === undefined ? {} : { model: parsed.model }),
        ...(parsed.effort === undefined ? {} : { effort: parsed.effort }), ...(parsed.profile === undefined ? {} : { profile: parsed.profile }),
      }, print);
    },
    agents: async () => {
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
        // From a terminal the brief is the user's own prompt, not an agent's.
        await ownerThreadNew(client, parsed, rest, print);
        return;
      }
      if (action === 'new') {
        const project = want(1, 'a project name, id or folder (boite projects lists them)');
        const prompt = requiredText(rest, 2, 'thread new needs a brief after the project');
        const spawned = await client.call('agent.spawn', {
          threadId, project, prompt, requestId: parsed.requestId ?? crypto.randomUUID(),
          ...(parsed.title === undefined ? {} : { title: parsed.title }), ...(parsed.worktree ? { worktree: true } : {}),
        });
        print([
          `thread: ${spawned.thread.id}`, `title: ${spawned.thread.title}`, `project: ${spawned.project}`, `cwd: ${spawned.thread.cwd}`,
          ...(spawned.thread.branch ? [`branch: ${spawned.thread.branch}`] : []),
          `agent: ${spawned.thread.providerId} ${spawned.thread.model ?? 'default'}`,
          `address: ${spawned.address.coreId}/${spawned.address.threadId}`,
          'Its first answer comes back to you as an agent message; do not poll. boite agents send <address> <text> steers it.',
        ], spawned);
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
    ask: async () => {
      const text = want(0, 'a question');
      const options = rest.slice(1);
      const asked = await client.call('questions.ask', { threadId, text, ...(options.length > 0 ? { options } : {}), ...(parsed.multiple ? { multiple: true } : {}) });
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
  };
  const handler = command !== undefined && Object.hasOwn(commands, command) ? commands[command] : undefined;
  if (handler === undefined) throw new Usage(`unknown command ${command}`);
  await handler();
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
      // An agent waiting for an answer holds its call up to five minutes.
      const waits = parsed.positional[0] === 'agents' && (parsed.wait || parsed.positional[1] === 'wait');
      client = await connect(target.url, target.token, { client: { name: 'cli', version: CORE_VERSION }, ...(waits ? { requestTimeoutMs: (WAIT_MAX_S + 30) * 1000 } : {}) });
    } catch (error) {
      throw new Error(`no core answers at ${target.url}: ${(error as Error).message}`);
    }
    if (parsed.positional[0] === 'mcp') {
      if (parsed.positional.length !== 1 || parsed.json) throw new Usage('boite mcp takes no positional arguments or --json');
      const { runBoiteMcp } = await import('./mcp/server.ts');
      await runBoiteMcp(client, target.threadId, io.err, () => connect(target.url, target.token, { client: { name: 'mcp-wait', version: CORE_VERSION }, requestTimeoutMs: 3_605_000 }));
    } else {
      const caller: Caller = io.env[AGENT_ENV.coreUrl] && io.env[AGENT_ENV.token] && io.env[AGENT_ENV.threadId] ? 'steward' : 'owner';
      await run(parsed, io, client, target.threadId, print, caller);
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
  };
}
