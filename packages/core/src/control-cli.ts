/**
 * The commands that drive other threads: list them, read one, send it a
 * message, stop, archive, rename, move or delete it, answer what it asks and
 * decide its permissions.
 *
 * The same words serve two callers. The owner at a terminal (no agent
 * environment, `core.json` or `--core` with `BOITE_TOKEN`) reaches every
 * thread through the owner methods, and a message it sends is the user's own
 * prompt. A bot the owner entrusted projects to goes through `resident.*`
 * and coordination from its own thread: the core holds it to its projects,
 * and its messages reach a thread marked as its own, never as the user's.
 * Any other thread lists what coordination lets it reach. Deleting threads
 * and deciding permissions stay the owner's.
 */
import type { AgentWatch, PermissionRequest, Project, ProjectThreadRow, QuestionRequest, RpcParams, ThreadSummary } from '@boite/contracts';
import type { CoreClient } from './client.ts';
import { contactLine, NO_CONTACT } from './agents-cli.ts';
import { requiredText, Usage, type Parsed } from './cli-args.ts';

type Printer = (lines: string[], value: unknown) => void;
export type Caller = 'owner' | 'agent';

/** Commands this file answers, with the words that follow them. */
export const CONTROL_COMMANDS = ['threads', 'thread', 'questions', 'answer', 'permissions', 'allow', 'deny'] as const;
/** `thread` actions this file answers; `new` and `move <project>` without a target stay with the agent's own commands. */
const THREAD_ACTIONS = ['show', 'send', 'stop', 'done', 'archive', 'unarchive', 'remove', 'rename'] as const;

export const CONTROL_HELP = `  threads [list] [--project <p>] [--archived]
                                 the threads you may see and their machine:
                                 every one here as the owner, those of your
                                 projects and your desk as a bot, the ones that
                                 let you reach them here and on linked machines
                                 from any other thread
  thread show <id>               state, pending questions and permissions, last answer
  thread send <id> <text>        the owner's prompt, or the agent's message
  thread done <id>               put a thread that is not at work in Done
  thread stop|archive|unarchive|remove <id>   (remove: owner only)
  thread rename <id> <title>
  thread move <project> <id>     move another thread (without <id>: this one)
  questions [<id>]               pending questions
  answer <id> <question-id> <option|text ...> (--skip)
  permissions [<id>]             pending tool permissions
  allow|deny <id> <request-id>   (owner only)`;

export function isControlCommand(parsed: Parsed): boolean {
  const [command, action] = parsed.positional;
  if (command === 'thread') {
    if (THREAD_ACTIONS.includes(action as typeof THREAD_ACTIONS[number])) return true;
    // `thread move <project> <thr_id>` names another thread; `thread move <project words>` stays the caller's own move.
    return action === 'move' && parsed.positional.length === 4 && /^thr_[0-9a-z]+$/.test(parsed.positional[3] ?? '');
  }
  if (command === 'projects') return ['archive', 'unarchive', 'remove'].includes(action ?? '');
  // `threads find|read|send|...` talk to other threads (agents-cli.ts); only the listing is here.
  if (command === 'threads') return action === undefined || action === 'list';
  return (CONTROL_COMMANDS as readonly string[]).includes(command ?? '');
}

/** Commands an owner may run without naming a thread of its own. */
export function ownerWithoutThread(parsed: Parsed): boolean {
  const [command, action] = parsed.positional;
  if (isControlCommand(parsed)) return true;
  if (command === 'projects') return true;
  return command === 'thread' && action === 'new';
}

function statusOf(row: { status: string; archived: boolean; done?: true }): string {
  return row.archived ? `${row.status},${row.done ? 'done' : 'archived'}` : row.status;
}

function threadLine(row: ProjectThreadRow): string {
  const facts = [
    row.project ? `project=${JSON.stringify(row.project)}` : null,
    row.branch ? `branch=${row.branch}` : null,
    row.questions ? `questions=${row.questions}` : null,
    row.permissions ? `permissions=${row.permissions}` : null,
    row.pullRequest ? `pr=#${row.pullRequest.number}:${row.pullRequest.state}` : null,
  ].filter(Boolean).join(' ');
  return `${row.id} ${statusOf(row)} ${JSON.stringify(row.title)}${facts ? ` ${facts}` : ''}`;
}

function questionLines(question: QuestionRequest): string[] {
  const options = question.options.map(option => `  option ${option.id}: ${option.label}`);
  const kind = question.options.length === 0 ? 'free text' : question.multiple ? 'several options' : 'one option';
  return [`question ${question.id} (${question.threadId}, ${kind}${question.allowText && question.options.length ? ', or text' : ''}): ${question.text}`, ...options];
}

function permissionLine(request: PermissionRequest): string {
  return `permission ${request.id} (${request.threadId}): ${request.toolName}${request.description ? ` ${request.description}` : ''}`;
}

/** Option ids or labels become `optionIds`; anything else is free text. */
export function answerOf(question: QuestionRequest, words: string[]): { optionIds: string[]; text?: string } {
  if (question.options.length > 0) {
    const ids = words.map(word => question.options.find(option => option.id === word || option.label.toLowerCase() === word.toLowerCase())?.id);
    if (ids.every((id): id is string => id !== undefined)) {
      if (!question.multiple && ids.length > 1) throw new Usage(`question ${question.id} takes one option`);
      return { optionIds: ids };
    }
    const whole = words.join(' ');
    const label = question.options.find(option => option.label.toLowerCase() === whole.toLowerCase());
    if (label) return { optionIds: [label.id] };
    if (!question.allowText) throw new Usage(`question ${question.id} expects ${question.options.map(option => option.id).join(', ')}`);
  }
  return { optionIds: [], text: words.join(' ') };
}

/** A project by id, name (any case) or folder, among the owner's list, as the core's own finder does. */
function projectOf<T extends { id: string; name: string; path: string }>(projects: T[], query: string): T {
  const byId = projects.find(project => project.id === query);
  if (byId) return byId;
  const byPath = projects.find(project => project.path === query);
  if (byPath) return byPath;
  const byName = projects.filter(project => project.name.toLowerCase() === query.toLowerCase());
  if (byName.length > 1) throw new Error(`${byName.length} projects are named ${query}; name one by its id: ${byName.map(project => project.id).join(', ')}`);
  if (byName.length === 0) throw new Error(`no project ${query}; boite projects lists them`);
  return byName[0]!;
}

/** A thread on a bot's desk outside the projects it lists: the desk's own state, from the thread. */
function deskLine(watch: AgentWatch): string {
  const facts = [`desk=${watch.origin}`, watch.pullRequest ? `pr=#${watch.pullRequest.number}:${watch.pullRequest.state}` : null, watch.stalledSince ? 'stalled' : null, 'machine=here'].filter(Boolean).join(' ');
  return `${watch.threadId} ${watch.state} ${JSON.stringify(watch.title)} ${facts}`;
}

/**
 * What a bot sees: the threads of the projects entrusted to it, then the
 * threads on its desk that are not among them. A bot with no project lists
 * its desk alone.
 */
async function botRows(client: CoreClient, threadId: string, watches: AgentWatch[], project: string | undefined, archived: boolean): Promise<{ rows: ProjectThreadRow[]; desk: AgentWatch[] }> {
  const view = await client.call('resident.view', { threadId });
  const projectId = project === undefined ? undefined : projectOf(await client.call('agent.projects', { threadId }), project).id;
  const entrusted = view.projects.length > 0 && (projectId === undefined || view.projects.some(entry => entry.id === projectId));
  const rows = entrusted ? await client.call('resident.threads', { threadId, ...(projectId === undefined ? {} : { project: projectId }), ...(archived ? { archived: true } : {}) }) : [];
  const listed = new Set(rows.map(row => row.id));
  const desk = watches.filter(watch => !listed.has(watch.threadId) && (projectId === undefined || watch.projectId === projectId)
    && (watch.state === 'archived' || watch.state === 'done') === archived);
  return { rows, desk };
}

export async function controlCommand(client: CoreClient, caller: Caller, threadId: string, parsed: Parsed, print: Printer): Promise<void> {
  const [command, ...rest] = parsed.positional;
  const want = (index: number, what: string): string => {
    const value = rest[index];
    if (value === undefined || value.length === 0) throw new Usage(`${command} needs ${what}`);
    return value;
  };
  const owner = caller === 'owner';
  const ownerOnly = (what: string): void => {
    if (!owner) throw new Error(`${what} is the owner's; ask the user`);
  };

  /** Owner rows in the same shape an agent reads, so both print alike. */
  const ownerRows = async (projectQuery: string | undefined, archived: boolean): Promise<ProjectThreadRow[]> => {
    const projects = await client.call('projects.list', {});
    const projectId = projectQuery === undefined ? undefined : projectOf(projects, projectQuery).id;
    const [threads, questions, permissions] = await Promise.all([
      client.call('threads.list', { ...(projectId === undefined ? {} : { projectId }), includeArchived: archived }),
      client.call('questions.list', {}),
      client.call('permissions.list', {}),
    ]);
    return threads
      .filter(thread => thread.archived === archived && !thread.parentThreadId && !thread.agentSessionId)
      .sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 200)
      .map(thread => ownerRow(thread, projects, questions, permissions));
  };
  const ownerRow = (thread: ThreadSummary, projects: Project[], questions: QuestionRequest[], permissions: PermissionRequest[]): ProjectThreadRow => ({
    id: thread.id, title: thread.title, projectId: thread.projectId,
    project: projects.find(project => project.id === thread.projectId)?.name ?? null,
    status: thread.status, archived: thread.archived, ...(thread.archived && thread.doneAt != null ? { done: true as const } : {}), branch: thread.branch,
    questions: questions.filter(question => question.threadId === thread.id).length,
    permissions: permissions.filter(request => request.threadId === thread.id).length,
    pullRequest: thread.pullRequest ?? null, updatedAt: thread.updatedAt, lastCompletedAt: null,
  });
  const ownerThread = async (id: string): Promise<ThreadSummary> => {
    const found = (await client.call('threads.list', { includeArchived: true })).find(thread => thread.id === id);
    if (!found) throw new Error(`no thread ${id}; boite threads lists them`);
    return found;
  };
  const pendingQuestions = async (target: string | undefined): Promise<QuestionRequest[]> => {
    if (owner) return client.call('questions.list', target === undefined ? {} : { threadId: target });
    if (target === threadId) return client.call('questions.list', { threadId });
    if (target !== undefined) return (await client.call('resident.thread', { threadId, target })).questions;
    const rows = await client.call('resident.threads', { threadId });
    const details = await Promise.all(rows.filter(row => row.questions > 0).map(row => client.call('resident.thread', { threadId, target: row.id })));
    return details.flatMap(detail => detail.questions);
  };
  const pendingPermissions = async (target: string | undefined): Promise<PermissionRequest[]> => {
    if (owner) return client.call('permissions.list', target === undefined ? {} : { threadId: target });
    if (target !== undefined) return (await client.call('resident.thread', { threadId, target })).permissions;
    const rows = await client.call('resident.threads', { threadId });
    const details = await Promise.all(rows.filter(row => row.permissions > 0).map(row => client.call('resident.thread', { threadId, target: row.id })));
    return details.flatMap(detail => detail.permissions);
  };

  switch (command) {
    case 'threads': {
      if (rest.length > 1) throw new Usage('threads lists with no more words; threads find <words> searches');
      const project = parsed.project;
      if (owner) {
        const rows = await ownerRows(project, parsed.archived);
        print(rows.length === 0 ? ['threads: none'] : rows.map(row => `${threadLine(row)} machine=here`), rows);
        return;
      }
      const bot = await client.call('agents.snapshot', { threadId }).catch(() => null);
      if (bot !== null && bot.profiles.length > 0) {
        const listed = await botRows(client, threadId, bot.watches, project, parsed.archived);
        print(listed.rows.length + listed.desk.length === 0 ? ['threads: none'] : [...listed.rows.map(row => `${threadLine(row)} machine=here`), ...listed.desk.map(deskLine)], listed);
        return;
      }
      if (parsed.archived) throw new Error('threads --archived lists archived threads for the owner and for bots; another thread sees the open ones it may reach');
      const [{ self }, result] = await Promise.all([client.call('collaboration.get', { threadId }), client.call('collaboration.directory', { threadId })]);
      const shown = project === undefined ? result.agents : result.agents.filter(contact => contact.project?.toLowerCase() === project.toLowerCase());
      const lines = shown.map(contact => contactLine(contact, self.coreId));
      if (lines.length === 0) lines.push(project === undefined ? NO_CONTACT : `no thread you may reach is in a project named ${project}`);
      print([...lines, ...result.unavailable.map(name => `unavailable: ${name}`)], { ...result, agents: shown });
      return;
    }
    case 'thread': {
      const action = want(0, `one of ${THREAD_ACTIONS.join(', ')} or move`);
      if (action === 'move') {
        const project = want(1, 'a project');
        const target = want(2, 'a thread id');
        if (owner) {
          const projects = await client.call('projects.list', {});
          const moved = await client.call('threads.move', { threadId: target, projectId: projectOf(projects, project).id });
          print([`moved: ${moved.id}`, `project: ${projectOf(projects, project).name}`, `cwd: ${moved.cwd}`], moved);
        } else {
          const result = await client.call('resident.act', { threadId, target, action: 'move', project });
          print([threadLine(result.thread)], result);
        }
        return;
      }
      const target = want(1, 'a thread id (boite threads lists them)');
      if (action === 'show') {
        if (owner) {
          const thread = await ownerThread(target);
          const [projects, questions, permissions, page] = await Promise.all([
            client.call('projects.list', {}), client.call('questions.list', { threadId: target }), client.call('permissions.list', { threadId: target }),
            client.call('threads.get', { threadId: target, limit: 20, compactTools: true, compactFiles: true, compactImages: true }),
          ]);
          const last = page.messages.findLast(message => message.role === 'assistant');
          const answer = last?.parts.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n').trim() || null;
          const detail = { thread: ownerRow(thread, projects, questions, permissions), questions, permissions, lastAnswer: answer && answer.length > 4000 ? `${answer.slice(0, 3900)}\n[Truncated.]` : answer };
          print([threadLine(detail.thread), `cwd: ${thread.cwd}`, ...questions.flatMap(questionLines), ...permissions.map(permissionLine), `last answer: ${detail.lastAnswer ?? '(none)'}`], detail);
        } else {
          const detail = await client.call('resident.thread', { threadId, target });
          print([threadLine(detail.thread), ...detail.questions.flatMap(questionLines), ...detail.permissions.map(permissionLine), `last answer: ${detail.lastAnswer ?? '(none)'}`], detail);
        }
        return;
      }
      if (action === 'send') {
        const text = requiredText(rest, 2, 'thread send needs a text after the thread id');
        if (owner) {
          // The owner is the user: this is an ordinary prompt, queued behind a running turn.
          const turn = await client.call('turns.start', { threadId: target, prompt: text, clientRequestId: parsed.requestId ?? crypto.randomUUID() });
          print([`sent: ${turn.id}`, `status: ${turn.status}`], turn);
        } else {
          const self = (await client.call('collaboration.get', { threadId })).self;
          const letter = await client.call('collaboration.send', { threadId, to: { coreId: self.coreId, threadId: target }, text, requestId: parsed.requestId ?? crypto.randomUUID() });
          print(letter.origin === 'resident'
            ? [`message: ${letter.id}`, `status: ${letter.status}`, 'as: the agent of its project', 'Its next answer comes back to you as a notice; do not poll.']
            : [`message: ${letter.id}`, `status: ${letter.status}`, 'as: agent', 'Its answer comes back as an agent message; do not poll.'], letter);
        }
        return;
      }
      if (action === 'rename') {
        const title = requiredText(rest, 2, 'thread rename needs a title after the thread id');
        if (owner) {
          const thread = await client.call('threads.update', { threadId: target, title });
          print([`renamed: ${thread.id} ${JSON.stringify(thread.title)}`], thread);
        } else {
          const result = await client.call('resident.act', { threadId, target, action: 'rename', title });
          print([threadLine(result.thread)], result);
        }
        return;
      }
      if (action !== 'stop' && action !== 'done' && action !== 'archive' && action !== 'unarchive' && action !== 'remove') throw new Usage(`thread: unknown action ${action}`);
      if (!owner) {
        if (action === 'remove') ownerOnly('deleting a thread');
        const result = await client.call('resident.act', { threadId, target, action: action as Exclude<typeof action, 'remove'> });
        print([threadLine(result.thread)], result);
        return;
      }
      if (action === 'stop') {
        const result = await client.call('turns.stop', { threadId: target });
        print([`stopped: ${result.stopped ? 'yes' : 'no, nothing was running'}`], result);
      } else if (action === 'done') {
        const thread = await client.call('threads.archive', { threadId: target, archived: true, onlyIfIdle: true });
        print([`done: ${thread.id}`], thread);
      } else if (action === 'remove') {
        const result = await client.call('threads.remove', { threadId: target });
        print([`removed: ${target}`], result);
      } else {
        const thread = await client.call('threads.archive', { threadId: target, archived: action === 'archive' });
        print([`${action}d: ${thread.id}`], thread);
      }
      return;
    }
    case 'questions': {
      const questions = await pendingQuestions(rest[0]);
      print(questions.length === 0 ? ['questions: none'] : questions.flatMap(questionLines), questions);
      return;
    }
    case 'answer': {
      const target = want(0, 'a thread id');
      const questionId = want(1, 'a question id (boite questions lists them)');
      const question = (await pendingQuestions(target)).find(pending => pending.id === questionId);
      if (!question) throw new Error(`no pending question ${questionId} in ${target}`);
      if (parsed.skip) {
        if (owner) await client.call('questions.skip', { threadId: target, questionId });
        else await client.call('resident.answer', { threadId, target, questionId, optionIds: [], skip: true });
        print([`skipped: ${questionId}`], { ok: true });
        return;
      }
      const words = rest.slice(2);
      if (words.length === 0) throw new Usage('answer needs option ids, labels or a text after the question id');
      const answer = answerOf(question, words);
      if (owner) await client.call('questions.answer', { threadId: target, questionId, ...answer });
      else await client.call('resident.answer', { threadId, target, questionId, ...answer });
      print([`answered: ${questionId}`], { ok: true, ...answer });
      return;
    }
    case 'permissions': {
      const requests = await pendingPermissions(rest[0]);
      print(requests.length === 0 ? ['permissions: none'] : requests.map(permissionLine), requests);
      return;
    }
    case 'allow':
    case 'deny': {
      const target = want(0, 'a thread id');
      const requestId = want(1, 'a request id (boite permissions lists them)');
      ownerOnly('deciding a tool permission');
      if (!(await pendingPermissions(target)).some(request => request.id === requestId)) throw new Error(`no pending permission ${requestId} in ${target}`);
      await client.call('permissions.answer', { requestId, decision: command });
      print([`${command === 'allow' ? 'allowed' : 'denied'}: ${requestId}`], { ok: true });
      return;
    }
    case 'projects': {
      const query = requiredText(rest, 1, `projects ${rest[0]} needs a project`);
      ownerOnly(`projects ${rest[0]}`);
      const projects = await client.call('projects.list', {});
      const project = projectOf(projects, query);
      if (rest[0] === 'remove') {
        const result = await client.call('projects.remove', { projectId: project.id });
        print([`removed: ${project.name}; its folder stays on disk`], result);
      } else {
        const result = await client.call('projects.archive', { projectId: project.id, archived: rest[0] === 'archive' });
        print([`${rest[0]}d: ${project.name}`], result);
      }
      return;
    }
  }
  throw new Usage(`unknown command ${command}`);
}

/**
 * `thread new` from a terminal, outside any thread: a top-level thread on the
 * selection of `--thread`, else of the project's most recent thread, else of
 * the most recent thread anywhere; `--model` replaces the model. The brief is
 * the user's own first prompt.
 */
export async function ownerThreadNew(client: CoreClient, parsed: Parsed, rest: string[], print: Printer, context?: Record<string, unknown>): Promise<void> {
  const query = rest[1];
  if (query === undefined) throw new Usage('thread new needs a project name, id or folder');
  const prompt = requiredText(rest, 2, 'thread new needs a brief after the project');
  const projects = await client.call('projects.list', {});
  const project = projectOf(projects, query);
  const threads = (await client.call('threads.list', { includeArchived: true }))
    .filter(thread => !thread.parentThreadId && !thread.agentSessionId).sort((a, b) => b.updatedAt - a.updatedAt);
  const base = (parsed.thread ? threads.find(thread => thread.id === parsed.thread) : undefined)
    ?? threads.find(thread => thread.projectId === project.id) ?? threads[0];
  if (!base) throw new Error('no thread to copy an agent from; start one in the app first');
  const model = parsed.model ?? base.model ?? undefined;
  const created = await client.call('threads.create', {
    projectId: project.id, providerId: base.providerId, accountId: base.accountId, title: parsed.title ?? prompt.trim().split('\n')[0]!.slice(0, 80),
    ...(model === undefined ? {} : { model }), effort: parsed.model === undefined ? base.effort : null, permissionMode: base.permissionMode,
    ...(parsed.worktree ? { worktree: {} } : {}), ...(context === undefined ? {} : { context: context as RpcParams<'threads.create'>['context'] }),
  });
  const turn = await client.call('turns.start', { threadId: created.id, prompt, clientRequestId: parsed.requestId ?? crypto.randomUUID() });
  print([`thread: ${created.id}`, `title: ${created.title}`, `project: ${project.name}`, `cwd: ${created.cwd}`, `agent: ${created.providerId} ${created.model ?? 'default'}`, `turn: ${turn.id}`], { thread: created, turn });
}
