import type { ArtifactContent, Message, MessagePart, Thread, Turn } from '@boite/contracts';
import { askAsync } from './requests';
import type { FakeContext } from './context';
import { FAKE_MEDIA } from './files';
import { toSummary } from './shared';

/** Pictures the demo's agents attached, served by `artifacts.read` beside the ones a turn publishes. */
const seeded = new WeakMap<FakeContext, Map<string, ArtifactContent>>();

export function seededArtifact(ctx: FakeContext, artifactId: string): ArtifactContent | undefined {
  const value = seeded.get(ctx)?.get(artifactId);
  return value ? { ...value } : undefined;
}

const MINUTE = 60_000;

/**
 * `?fake=1&agents=1`: three agents, each in its own thread, the way the core
 * would have written them.
 * - Nova is at work: a turn runs a test step live, and its desk holds two
 *   threads it started in the first project, one with an open pull request.
 * - Iris waits on the user: a deploy failed and it asks for a login, with the
 *   page to open beside the conversation.
 * - Mira rests until its 20:00 routine; its history holds a picture it
 *   attached and yesterday's routine, which had nothing to report.
 */
export function seedAgentsDemo(ctx: FakeContext): void {
  const account = ctx.accounts.find(a => a.providerId === 'echo') ?? ctx.accounts[0];
  if (!account) return;
  const project = ctx.projects.find(p => p.kind !== 'drafts') ?? null;
  const selection = { providerId: account.providerId, accountId: account.id, model: null, effort: null, permissionMode: 'default' as const };
  const now = Date.now();
  const projectIds = project ? [project.id] : [];

  // Mira, at rest.
  const mira = ctx.agents.seedAgent({ name: 'Mira', domain: 'Product scout', instructions: 'Keep an eye on the product and tell me what matters, with pictures. Every evening, check new issues and pull requests.', avatar: '', selection, status: 'active', projectIds }, now - 3 * 86_400_000);
  const miraThread = ctx.thread(mira.threadId);
  exchange(ctx, miraThread, { at: now - 26 * 60 * MINUTE, prompt: 'Can you look at the new welcome screen and tell me how it reads?',
    answer: 'It reads well: the title is clear and the button stands out. On a phone the subtitle wraps to three lines, so I would cut it to one sentence. Here is how it looks now.', picture: true });
  const quiet = exchange(ctx, miraThread, { at: now - 20 * 60 * MINUTE, operation: 'routine', label: 'Routine · Evening review', prompt: 'Check the new issues and pull requests of the projects I look after and tell me what needs me.',
    answer: 'Read 4 new issues and 2 pull requests. Nothing needs you tonight.\n\n[quiet] 4 issues, 2 pull requests, nothing new' });
  quiet.quiet = true;
  ctx.agents.seedQuiet(quiet.id);
  exchange(ctx, miraThread, { at: now - 95 * MINUTE, prompt: 'Remember that the welcome screen must fit in three lines on a phone.', answer: 'Noted in my memory: the welcome screen stays under three lines on a phone. I will check it in tonight\'s review.' });
  const evening = ctx.agents.seedRoutine({ agentId: mira.agent.id, name: 'Evening review', prompt: 'Check the new issues and pull requests of the projects I look after and tell me what needs me.', schedule: { kind: 'daily', time: '20:00', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone } });
  void evening;
  ctx.agents.seedMemory(mira.agent.id, '- The welcome screen stays under three lines on a phone.\n- Meetsu wants pictures of what changed, not descriptions.');
  miraThread.unread = true;
  ctx.agents.seedUnread(mira.agent.id, 1);

  // Iris, waiting on a login.
  const iris = ctx.agents.seedAgent({ name: 'Iris', domain: 'Ops watcher', instructions: 'Watch the staging deploys. When one fails, read its logs and tell me why in two lines.', avatar: '', selection, status: 'active', projectIds }, now - 2 * 86_400_000);
  const irisThread = ctx.thread(iris.threadId);
  const deploy = exchange(ctx, irisThread, { at: now - 12 * MINUTE, operation: 'event', label: 'Deploy failed on staging', prompt: 'A watched deploy failed: staging, build 1288, step "migrate". Read its logs and tell the user why.',
    answer: 'The staging deploy failed at the migrate step. The logs are behind the dashboard login, so I need you to sign in once.' });
  askAsync(ctx, irisThread, deploy, null, 'Sign in to dashboard.example.com so I can read the failed deploy logs.', ['Signed in', 'Skip'], false, 'https://dashboard.example.com/login');
  irisThread.openQuestions = 1;
  ctx.agents.seedRoutine({ agentId: iris.agent.id, name: 'Morning deploy check', prompt: 'Check last night\'s staging deploys.', schedule: { kind: 'daily', time: '08:30', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone } });

  // Nova, at work.
  const nova = ctx.agents.seedAgent({ name: 'Nova', domain: 'Release captain', instructions: 'Carry the login fix to a merged pull request and keep the release notes current.', avatar: '', selection, status: 'active', projectIds }, now - 86_400_000);
  const novaThread = ctx.thread(nova.threadId);
  exchange(ctx, novaThread, { at: now - 5 * 60 * MINUTE, prompt: 'Keep the login fix moving and tell me when its pull request is green.', answer: 'On it. I started a thread in boite for the fix and I watch its pull request from my desk.' });
  exchange(ctx, novaThread, { at: now - 40 * MINUTE, operation: 'event', label: '2 project events', prompt: 'Thread "Fix login redirect loop" opened pull request #482. Thread "Flaky upload test" failed its last turn.',
    answer: 'The login fix opened PR #482 and its checks pass. The upload test failed once on a timeout, so I asked its thread to retry with more time.' });
  if (project) {
    const fix = deskThread(ctx, project.id, 'Fix login redirect loop', now - 4 * 60 * MINUTE, 'idle');
    const flaky = deskThread(ctx, project.id, 'Flaky upload test', now - 3 * 60 * MINUTE, 'running');
    ctx.agents.seedWatch({ agentId: nova.agent.id, threadId: fix.id, origin: 'started', since: fix.createdAt, stalledSince: null, pullRequest: { number: 482, url: 'https://github.com/example/boite/pull/482', state: 'open', checks: 'passing' } });
    ctx.agents.seedWatch({ agentId: nova.agent.id, threadId: flaky.id, origin: 'started', since: flaky.createdAt, stalledSince: null, pullRequest: null });
  }
  liveTurn(ctx, novaThread, now - 3 * MINUTE, 'Is the release notes draft ready?', 'Checking the release branch first, then I will sum up what changed since 2.0.', { name: 'Bash', input: { command: 'bun run test packages/ui', description: 'Run the UI tests' }, step: 'Run the UI tests' });
  ctx.agents.seedRoutine({ agentId: nova.agent.id, name: 'Release check', prompt: 'Check the release branch and the open pull requests.', schedule: { kind: 'interval', everyMinutes: 120 } });
}

/** A finished turn: the prompt (or a wake's label), then the agent's answer. */
function exchange(ctx: FakeContext, thread: Thread, spec: { at: number; prompt: string; answer: string; operation?: 'routine' | 'event'; label?: string; picture?: boolean }): Turn {
  const turn: Turn = { id: `turn-agents-demo-${++ctx.seq}`, threadId: thread.id, status: 'done', queuedAt: spec.at, startedAt: spec.at, finishedAt: spec.at + 2 * MINUTE, usage: null, error: null, execution: execution(thread, spec.operation) };
  thread.turns.push(turn);
  const prompt: MessagePart = { type: 'text', text: spec.prompt, ...(spec.label ? { displayText: spec.label } : {}) };
  thread.messages.push({ id: `m-${++ctx.seq}`, threadId: thread.id, turnId: turn.id, role: 'user', state: 'complete', createdAt: spec.at, parts: [prompt] });
  const parts: MessagePart[] = [{ type: 'text', text: spec.answer }];
  if (spec.picture) parts.push(picture(ctx));
  thread.messages.push({ id: `m-${++ctx.seq}`, threadId: thread.id, turnId: turn.id, role: 'assistant', state: 'complete', createdAt: spec.at + MINUTE, parts });
  thread.updatedAt = Math.max(thread.updatedAt, spec.at + 2 * MINUTE);
  thread.sessionId ??= `sess-agents-demo-${thread.id}`;
  return turn;
}

function execution(thread: Thread, operation?: 'routine' | 'event'): NonNullable<Turn['execution']> {
  return { providerId: thread.providerId, accountId: thread.accountId, model: thread.model, effort: thread.effort, speed: null, permissionMode: thread.permissionMode,
    sessionId: thread.sessionId, sessionGeneration: 0, selectionVersion: 0, ...(operation ? { operation } : {}) };
}

/** The capture an agent attached with `boite attach`, read back through `artifacts.read`. */
function picture(ctx: FakeContext): MessagePart {
  const media = FAKE_MEDIA['assets/preview.png']!;
  const url = media.url();
  const bytes = Math.floor((url.length - url.indexOf(',') - 1) * 3 / 4);
  const id = `artifact-agents-demo-${++ctx.seq}`;
  const name = 'welcome-screen.png';
  const mimeType = url.startsWith('data:image/png') ? 'image/png' : 'image/svg+xml';
  let store = seeded.get(ctx);
  if (!store) seeded.set(ctx, store = new Map());
  store.set(id, { url, bytes, mimeType, name });
  return { type: 'artifact', id, name, mimeType, bytes };
}

/** A thread of a project an agent started: it sits on that agent's desk. */
function deskThread(ctx: FakeContext, projectId: string, title: string, at: number, status: 'idle' | 'running'): Thread {
  const project = ctx.projects.find(p => p.id === projectId)!;
  const account = ctx.accounts.find(a => a.providerId === 'echo') ?? ctx.accounts[0]!;
  const id = `t-agents-desk-${++ctx.seq}`;
  const turnId = `turn-agents-desk-${ctx.seq}`;
  const turn: Turn = { id: turnId, threadId: id, status: status === 'running' ? 'running' : 'done', queuedAt: at, startedAt: at, finishedAt: status === 'running' ? null : at + 20 * MINUTE, usage: null, error: null };
  const thread: Thread = {
    id, projectId, title, titleSource: 'user', cwd: project.path, providerId: account.providerId, accountId: account.id, model: null, effort: null, speed: null,
    permissionMode: 'default', archived: false, pinned: false, branch: `fix/${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, messagesBefore: null, commands: [],
    status, unread: false, sessionId: `sess-${id}`, sessionGeneration: 0, selectionVersion: 0, load: null, context: null, createdAt: at, updatedAt: at + 20 * MINUTE,
    ...(status === 'running' ? { runningSince: at + 10 * MINUTE } : {}),
    turns: [turn],
    messages: [
      { id: `m-${++ctx.seq}`, threadId: id, turnId, role: 'user', parts: [{ type: 'text', text: title }], state: 'complete', createdAt: at },
      { id: `m-${++ctx.seq}`, threadId: id, turnId, role: 'assistant', parts: [{ type: 'text', text: status === 'running' ? 'Running the tests again with a longer timeout.' : 'The fix is in and its pull request is open.' }], state: status === 'running' ? 'streaming' : 'complete', createdAt: at + MINUTE },
    ],
  };
  ctx.threads.set(id, thread);
  ctx.emit('thread.created', structuredClone(toSummary(thread)));
  return thread;
}

/**
 * A turn under way: the user's question, the agent's first words and a tool
 * step still running, so the header and the row read the step live. Stop
 * ends it the way the core stops a turn.
 */
function liveTurn(ctx: FakeContext, thread: Thread, at: number, prompt: string, text: string, tool: { name: string; input: Record<string, unknown>; step: string }): void {
  const turn: Turn = { id: `turn-agents-live-${++ctx.seq}`, threadId: thread.id, status: 'running', queuedAt: at, startedAt: at, finishedAt: null, usage: null, error: null, execution: execution(thread) };
  thread.turns.push(turn);
  thread.messages.push({ id: `m-${++ctx.seq}`, threadId: thread.id, turnId: turn.id, role: 'user', state: 'complete', createdAt: at, parts: [{ type: 'text', text: prompt }] });
  const toolStarted = at + MINUTE + 20_000;
  const answer: Message = { id: `m-${++ctx.seq}`, threadId: thread.id, turnId: turn.id, role: 'assistant', state: 'streaming', createdAt: at + 5_000, parts: [
    { type: 'thinking', text: 'The release notes depend on what landed on the release branch: read it, then run the tests to be sure.', startedAt: at + 5_000, finishedAt: at + 20_000 },
    { type: 'text', text },
    { type: 'tool', toolId: `tool-${ctx.seq}`, name: 'Read', input: { file_path: 'CHANGELOG.md' }, output: '## 2.0.4\n- Fix the login redirect loop', status: 'done', startedAt: at + 30_000 },
    { type: 'tool', toolId: `tool-${ctx.seq}-run`, name: tool.name, input: tool.input, output: null, status: 'running', startedAt: toolStarted },
  ] };
  thread.messages.push(answer);
  thread.status = 'running';
  thread.runningSince = at;
  thread.updatedAt = at;
  thread.progress = { turnId: turn.id, phase: 'tool', detail: tool.step, at: toolStarted, since: toolStarted };
  // Stop ends the step and the turn, as the core does: `stopTurn` raises `cancelled`, then waits on `done`.
  let settle = () => {};
  const done = new Promise<void>(resolve => { settle = resolve; });
  let cancelled = false;
  const finish = () => {
    const step = answer.parts.at(-1);
    if (step?.type === 'tool') step.status = 'error';
    answer.state = 'complete';
    Object.assign(turn, { status: 'stopped', finishedAt: ctx.now() });
    ctx.inFlight.delete(thread.id);
    thread.status = 'idle';
    thread.progress = null;
    thread.runningSince = null;
    ctx.emitToThread(thread.id, 'message.completed', { threadId: thread.id, messageId: answer.id, state: 'complete' });
    ctx.touch(thread);
    ctx.emit('turn.finished', structuredClone(turn));
    settle();
  };
  const record = {
    done,
    get cancelled() { return cancelled; },
    set cancelled(value: boolean) { if (value && !cancelled) { cancelled = true; queueMicrotask(finish); } },
  };
  ctx.inFlight.set(thread.id, record);
}
