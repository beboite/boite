/**
 * The commands that drive other threads: list them, read one, send it a
 * message, stop, archive, rename, move or delete it, answer what it asks,
 * decide its permissions, and assign stewards.
 *
 * The same words serve two callers. The owner at a terminal (no agent
 * environment, `core.json` or `--core` with `BOITE_TOKEN`) reaches every
 * thread through the owner methods, and a message it sends is the user's own
 * prompt. A steward, the agent of a thread the owner assigned projects to,
 * goes through `steward.*` and coordination: the core holds it to its grant,
 * and its messages reach a thread marked as the steward's, never as the user's.
 */
import { STEWARD_CAPABILITIES, STEWARD_DEFAULT_CAPABILITIES } from '@boite/contracts';
import type {
  PermissionRequest, Project, QuestionRequest, StewardCapability, StewardGrant, StewardThread, ThreadSummary,
} from '@boite/contracts';
import type { CoreClient } from './client.ts';
import { requiredText, Usage, type Parsed } from './cli-args.ts';

type Printer = (lines: string[], value: unknown) => void;
export type Caller = 'owner' | 'steward';

/** Commands this file answers, with the words that follow them. */
export const CONTROL_COMMANDS = ['threads', 'thread', 'questions', 'answer', 'permissions', 'allow', 'deny', 'stewards', 'steward'] as const;
/** `thread` actions this file answers; `new` and `move <project>` without a target stay with the agent's own commands. */
const THREAD_ACTIONS = ['show', 'send', 'stop', 'archive', 'unarchive', 'remove', 'rename'] as const;

export const CONTROL_HELP = `  threads [--project <p>] [--archived]
                                 threads you may drive: every one as the owner,
                                 those of your projects as a steward
  thread show <id>               state, pending questions and permissions, last answer
  thread send <id> <text>        the owner's prompt, or the steward's message
  thread stop|archive|unarchive|remove <id>
  thread rename <id> <title>
  thread move <project> <id>     move another thread (without <id>: this one)
  questions [<id>]               pending questions
  answer <id> <question-id> <option|text ...> (--skip)
  permissions [<id>]             pending tool permissions
  allow|deny <id> <request-id>
  stewards                       the steward grants (owner)
  stewards set <thread> <project ...> [--all] [--can <a,b>] [--quiet]
  stewards revoke <thread>
  steward                        this thread's own grant
                                 capabilities: ${STEWARD_CAPABILITIES.join(', ')}
                                 default: ${STEWARD_DEFAULT_CAPABILITIES.join(', ')}`;

export function isControlCommand(parsed: Parsed): boolean {
  const [command, action] = parsed.positional;
  if (command === 'thread') {
    if (THREAD_ACTIONS.includes(action as typeof THREAD_ACTIONS[number])) return true;
    // `thread move <project> <thr_id>` names another thread; `thread move <project words>` stays the caller's own move.
    return action === 'move' && parsed.positional.length === 4 && /^thr_[0-9a-z]+$/.test(parsed.positional[3] ?? '');
  }
  if (command === 'projects') return ['archive', 'unarchive', 'remove'].includes(action ?? '');
  return (CONTROL_COMMANDS as readonly string[]).includes(command ?? '');
}

/** Commands an owner may run without naming a thread of its own. */
export function ownerWithoutThread(parsed: Parsed): boolean {
  const [command, action] = parsed.positional;
  if (isControlCommand(parsed)) return true;
  if (command === 'projects') return true;
  return command === 'thread' && action === 'new';
}

function statusOf(row: { status: string; archived: boolean }): string {
  return row.archived ? `${row.status},archived` : row.status;
}

function threadLine(row: StewardThread): string {
  const facts = [
    row.project ? `project=${JSON.stringify(row.project)}` : null,
    row.branch ? `branch=${row.branch}` : null,
    row.questions ? `questions=${row.questions}` : null,
    row.permissions ? `permissions=${row.permissions}` : null,
    row.pullRequest ? `pr=#${row.pullRequest.number}:${row.pullRequest.state}` : null,
    row.self ? '(this thread)' : null,
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

function grantLines(grant: StewardGrant, projects: Pick<Project, 'id' | 'name'>[]): string[] {
  const names = grant.allProjects ? 'every project' : grant.projectIds.map(id => projects.find(project => project.id === id)?.name ?? id).join(', ');
  return [`steward: ${grant.threadId}`, `projects: ${names}`, `can: ${grant.capabilities.join(', ') || 'read only'}`, `notices: ${grant.notify ? 'on' : 'off'}`];
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

export function capabilitiesOf(raw: string | undefined): StewardCapability[] {
  if (raw === undefined) return [...STEWARD_DEFAULT_CAPABILITIES];
  const names = raw.split(',').map(name => name.trim()).filter(Boolean);
  if (names.length === 1 && names[0] === 'all') return [...STEWARD_CAPABILITIES];
  for (const name of names) {
    if (!STEWARD_CAPABILITIES.includes(name as StewardCapability)) throw new Usage(`--can: unknown capability ${name}; expected ${STEWARD_CAPABILITIES.join(', ')} or all`);
  }
  return names as StewardCapability[];
}

/** A project by id, name (any case) or folder, among the owner's list, as the core's own finder does. */
function projectOf(projects: Project[], query: string): Project {
  const byId = projects.find(project => project.id === query);
  if (byId) return byId;
  const byPath = projects.find(project => project.path === query);
  if (byPath) return byPath;
  const byName = projects.filter(project => project.name.toLowerCase() === query.toLowerCase());
  if (byName.length > 1) throw new Error(`${byName.length} projects are named ${query}; name one by its id: ${byName.map(project => project.id).join(', ')}`);
  if (byName.length === 0) throw new Error(`no project ${query}; boite projects lists them`);
  return byName[0]!;
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

  /** Owner rows in the same shape a steward reads, so both print alike. */
  const ownerRows = async (projectQuery: string | undefined, archived: boolean): Promise<StewardThread[]> => {
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
  const ownerRow = (thread: ThreadSummary, projects: Project[], questions: QuestionRequest[], permissions: PermissionRequest[]): StewardThread => ({
    id: thread.id, title: thread.title, projectId: thread.projectId,
    project: projects.find(project => project.id === thread.projectId)?.name ?? null,
    status: thread.status, archived: thread.archived, branch: thread.branch, self: thread.id === threadId,
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
    if (target !== undefined) return (await client.call('steward.thread', { threadId, target })).questions;
    const rows = await client.call('steward.threads', { threadId });
    const details = await Promise.all(rows.filter(row => row.questions > 0 && !row.self).map(row => client.call('steward.thread', { threadId, target: row.id })));
    return details.flatMap(detail => detail.questions);
  };
  const pendingPermissions = async (target: string | undefined): Promise<PermissionRequest[]> => {
    if (owner) return client.call('permissions.list', target === undefined ? {} : { threadId: target });
    if (target !== undefined) return (await client.call('steward.thread', { threadId, target })).permissions;
    const rows = await client.call('steward.threads', { threadId });
    const details = await Promise.all(rows.filter(row => row.permissions > 0 && !row.self).map(row => client.call('steward.thread', { threadId, target: row.id })));
    return details.flatMap(detail => detail.permissions);
  };

  switch (command) {
    case 'threads': {
      const project = parsed.project;
      const rows = owner
        ? await ownerRows(project, parsed.archived)
        : await client.call('steward.threads', { threadId, ...(project === undefined ? {} : { project }), ...(parsed.archived ? { archived: true } : {}) });
      print(rows.length === 0 ? ['threads: none'] : rows.map(threadLine), rows);
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
          const result = await client.call('steward.act', { threadId, target, action: 'move', project });
          print([threadLine(result.thread!)], result);
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
          const detail = await client.call('steward.thread', { threadId, target });
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
          print([`message: ${letter.id}`, `status: ${letter.status}`, `as: ${letter.origin === 'steward' ? 'steward' : 'agent'}`, 'Its answer comes back as an agent message; do not poll.'], letter);
        }
        return;
      }
      if (action === 'rename') {
        const title = requiredText(rest, 2, 'thread rename needs a title after the thread id');
        if (owner) {
          const thread = await client.call('threads.update', { threadId: target, title });
          print([`renamed: ${thread.id} ${JSON.stringify(thread.title)}`], thread);
        } else {
          const result = await client.call('steward.act', { threadId, target, action: 'rename', title });
          print([threadLine(result.thread!)], result);
        }
        return;
      }
      if (action !== 'stop' && action !== 'archive' && action !== 'unarchive' && action !== 'remove') throw new Usage(`thread: unknown action ${action}`);
      if (!owner) {
        const result = await client.call('steward.act', { threadId, target, action });
        print(result.thread === null ? [`${action}: ${target}`] : [threadLine(result.thread)], result);
        return;
      }
      if (action === 'stop') {
        const result = await client.call('turns.stop', { threadId: target });
        print([`stopped: ${result.stopped ? 'yes' : 'no, nothing was running'}`], result);
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
        else await client.call('steward.answer', { threadId, target, questionId, optionIds: [], skip: true });
        print([`skipped: ${questionId}`], { ok: true });
        return;
      }
      const words = rest.slice(2);
      if (words.length === 0) throw new Usage('answer needs option ids, labels or a text after the question id');
      const answer = answerOf(question, words);
      if (owner) await client.call('questions.answer', { threadId: target, questionId, ...answer });
      else await client.call('steward.answer', { threadId, target, questionId, ...answer });
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
      if (owner) {
        if (!(await pendingPermissions(target)).some(request => request.id === requestId)) throw new Error(`no pending permission ${requestId} in ${target}`);
        await client.call('permissions.answer', { requestId, decision: command });
      } else await client.call('steward.permission', { threadId, target, requestId, decision: command });
      print([`${command === 'allow' ? 'allowed' : 'denied'}: ${requestId}`], { ok: true });
      return;
    }
    case 'steward': {
      const view = await client.call('steward.get', { threadId });
      print(view.grant === null ? ['steward: no; the owner assigns projects in Communication settings or with boite stewards set'] : grantLines(view.grant, view.projects), view);
      return;
    }
    case 'stewards': {
      ownerOnly('assigning stewards');
      const action = rest[0] ?? 'list';
      const projects = await client.call('projects.list', {});
      if (action === 'list') {
        const grants = await client.call('stewards.list', {});
        print(grants.length === 0 ? ['stewards: none'] : grants.flatMap(grant => [...grantLines(grant, projects), '']).slice(0, -1), grants);
      } else if (action === 'set') {
        const steward = want(1, 'the steward thread id');
        const names = rest.slice(2);
        if (!parsed.all && names.length === 0) throw new Usage('stewards set needs projects after the thread, or --all');
        const grant = await client.call('stewards.set', { grant: {
          threadId: steward, allProjects: parsed.all, projectIds: parsed.all ? [] : names.map(name => projectOf(projects, name).id),
          capabilities: capabilitiesOf(parsed.can), notify: !parsed.quiet,
        } });
        print(grantLines(grant, projects), grant);
      } else if (action === 'revoke') {
        const result = await client.call('stewards.revoke', { threadId: want(1, 'the steward thread id') });
        print(['revoked'], result);
      } else throw new Usage(`stewards: unknown action ${action}`);
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
export async function ownerThreadNew(client: CoreClient, parsed: Parsed, rest: string[], print: Printer): Promise<void> {
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
    ...(parsed.worktree ? { worktree: {} } : {}),
  });
  const turn = await client.call('turns.start', { threadId: created.id, prompt, clientRequestId: parsed.requestId ?? crypto.randomUUID() });
  print([`thread: ${created.id}`, `title: ${created.title}`, `project: ${project.name}`, `cwd: ${created.cwd}`, `agent: ${created.providerId} ${created.model ?? 'default'}`, `turn: ${turn.id}`], { thread: created, turn });
}
