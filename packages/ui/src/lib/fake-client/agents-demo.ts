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
 * - Nova is at work: a turn runs a test step live after four calls, its
 *   earlier turns fold their steps, and its desk holds every state a desk
 *   card has: a thread at work, one gone silent, one asking a question, a
 *   pull request whose checks fail and one merged. It spent $1.35 of its $2
 *   daily budget.
 * - Iris waits on the user: a deploy failed and it asks for a login, with the
 *   page to open beside the conversation.
 * - Mira rests until its 20:00 routine; its history holds a picture it
 *   attached and yesterday's routine, which had nothing to report.
 * - Bolt cannot run: its account was removed. Pixel is paused. Each wears a
 *   robot it picked, so the list shows every ring.
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
    answer: 'Read 4 new issues and 2 pull requests. Nothing needs you tonight.\n\n[quiet] 4 issues, 2 pull requests, nothing new',
    steps: [
      { tool: 'Bash', input: { command: 'gh issue list --state open --limit 20', description: 'List the open issues' }, output: '#61 Settings page scrolls twice\n#60 Dark mode flashes on start\n#58 Export as PDF\n#57 Typo on the welcome screen' },
      { tool: 'Bash', input: { command: 'gh pr list --state open', description: 'List the open pull requests' }, output: '#482 Fix login redirect loop\n#479 Release notes 2.0.4' },
    ] });
  quiet.quiet = true;
  ctx.agents.seedQuiet(quiet.id);
  exchange(ctx, miraThread, { at: now - 95 * MINUTE, prompt: 'Remember that the welcome screen must fit in three lines on a phone.', answer: 'Noted in my memory: the welcome screen stays under three lines on a phone. I will check it in tonight\'s review.' });
  const evening = ctx.agents.seedRoutine({ agentId: mira.agent.id, name: 'Evening review', prompt: 'Check the new issues and pull requests of the projects I look after and tell me what needs me.', schedule: { kind: 'daily', time: '20:00', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone } });
  void evening;
  ctx.agents.seedMemoryPass(mira.agent.id, { threadId: 't-agents-demo-memory-mira', status: 'done', summary: 'Noted that the welcome screen fits in three lines on a phone.', at: now - 92 * MINUTE });
  ctx.agents.seedMemory(mira.agent.id, '- The welcome screen stays under three lines on a phone.\n- The user wants pictures of what changed, not descriptions.');
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
  exchange(ctx, novaThread, { at: now - 5 * 60 * MINUTE, prompt: 'Keep the login fix moving and tell me when its pull request is green.', answer: 'On it. I started a thread in boite for the fix and I watch its pull request from my desk.',
    steps: [
      { narration: 'I will hand the fix to a thread of its own in the project.', tool: 'Bash', input: { command: 'boite thread new boite "Fix the login redirect loop and open a pull request"', description: 'Start the fix thread' }, output: 'Started thread t-fix' },
      { tool: 'Bash', input: { command: 'boite agent watch t-fix', description: 'Put it on my desk' }, output: 'Watching t-fix' },
    ] });
  exchange(ctx, novaThread, { at: now - 40 * MINUTE, operation: 'event', label: '2 project events', prompt: 'Thread "Fix login redirect loop" opened pull request #482. Thread "Flaky upload test" failed its last turn.',
    answer: 'The login fix opened PR #482, but its end-to-end check fails on the redirect test. The upload test failed once on a timeout, so I asked its thread to retry with more time.',
    steps: [
      { tool: 'Bash', input: { command: 'gh pr checks 482', description: 'Read the checks of #482' }, output: 'build\tpass\nunit\tpass\ne2e\tfail' },
      { narration: 'The e2e job fails; its log names the redirect test.', tool: 'Bash', input: { command: 'gh run view --log-failed --job e2e | tail -20', description: 'Read the failed e2e log' }, output: 'login.spec.ts: expected /home, got /login' },
      { tool: 'Read', input: { file_path: 'tests/e2e/login.spec.ts' }, output: "test('redirects home after login', ...)" },
      { narration: 'The upload test only timed out. A retry with more time is enough.', tool: 'Bash', input: { command: 'boite thread send t-flaky "Run the upload test again with a 60 s timeout"', description: 'Ask the upload thread to retry' }, output: 'Sent' },
    ] });
  if (project) {
    const fix = deskThread(ctx, project.id, 'Fix login redirect loop', now - 4 * 60 * MINUTE, 'idle');
    const flaky = deskThread(ctx, project.id, 'Flaky upload test', now - 3 * 60 * MINUTE, 'running');
    const migrate = deskThread(ctx, project.id, 'Migrate the settings store', now - 90 * MINUTE, 'running');
    const icons = deskThread(ctx, project.id, 'Pick the release icon set', now - 50 * MINUTE, 'idle');
    const notes = deskThread(ctx, project.id, 'Release notes 2.0.4', now - 7 * 60 * MINUTE, 'done');
    askAsync(ctx, icons, icons.turns[0]!, null, 'Two icon sets fit the release. Which one should the app ship with?', ['Lucide', 'Phosphor'], false);
    icons.openQuestions = 1;
    icons.updatedAt = now - 30 * MINUTE;
    const pr = (number: number, state: 'open' | 'merged', checks: 'passing' | 'failing' | null) => ({ number, url: `https://github.com/example/boite/pull/${number}`, state, checks });
    ctx.agents.seedWatch({ agentId: nova.agent.id, threadId: fix.id, origin: 'started', since: fix.createdAt, stalledSince: null, pullRequest: pr(482, 'open', 'failing') });
    ctx.agents.seedWatch({ agentId: nova.agent.id, threadId: flaky.id, origin: 'started', since: flaky.createdAt, stalledSince: null, pullRequest: null });
    ctx.agents.seedWatch({ agentId: nova.agent.id, threadId: migrate.id, origin: 'entrusted', since: migrate.createdAt, stalledSince: now - 24 * MINUTE, pullRequest: null });
    ctx.agents.seedWatch({ agentId: nova.agent.id, threadId: icons.id, origin: 'followed', since: icons.createdAt, stalledSince: null, pullRequest: null });
    ctx.agents.seedWatch({ agentId: nova.agent.id, threadId: notes.id, origin: 'started', since: notes.createdAt, stalledSince: null, pullRequest: pr(479, 'merged', null) });
    // A thread of another machine of the group, which does not answer right now.
    ctx.agents.seedWatch({
      agentId: nova.agent.id, threadId: 'thr_skoll_save', title: 'Fix the save migration', projectId: 'core_skoll/prj_hearthfall', origin: 'followed', since: now - 2 * 60 * MINUTE,
      stalledSince: null, pullRequest: null, lastActivityAt: now - 40 * MINUTE, coreId: 'core_skoll', machine: 'skoll',
      unreachable: 'skoll is unreachable (connection refused); its events reach you once it is back',
    });
  }
  liveTurn(ctx, novaThread, now - 3 * MINUTE, 'Is the release notes draft ready?', 'Checking the release branch first, then I will sum up what changed since 2.0.', { name: 'Bash', input: { command: 'bun run test packages/ui', description: 'Run the UI tests' }, step: 'Run the UI tests' });
  ctx.agents.seedRoutine({ agentId: nova.agent.id, name: 'Release check', prompt: 'Check the release branch and the open pull requests.', schedule: { kind: 'interval', everyMinutes: 120 } });
  ctx.agents.seedMemory(nova.agent.id, '## Release 2.0.4\n- The login fix ships in it, PR #482.\n- Release notes live in `CHANGELOG.md`, newest first.\n\n## How the user likes it\n- A pull request is done when its checks pass, not when it opens.');
  ctx.agents.seedRuntime(nova.agent.id, { dailyBudgetUsd: 2 });
  ctx.agents.seedSpend(nova.agent.id, 1.35);
  ctx.agents.seedMemoryPass(nova.agent.id, { threadId: 't-agents-demo-memory-nova', status: 'done', summary: 'PR #482 fails its e2e redirect test; the upload test only timed out.', at: now - 37 * MINUTE });

  // Bolt, whose provider left: its last turn could not run.
  const bolt = ctx.agents.seedAgent({ name: 'Bolt', domain: 'Dependency updates', instructions: 'Every Monday, update the dependencies and open one pull request.', avatar: 'bot:b.4.13.2.11.11.0.0', selection, status: 'active', projectIds: [] }, now - 5 * 86_400_000);
  exchange(ctx, ctx.thread(bolt.threadId), { at: now - 2 * 86_400_000, prompt: 'Update the dependencies.', answer: 'Opened #470 with the 14 updates; the lockfile is regenerated.' });
  ctx.agents.seedProblem(bolt.agent.id, 'Its account was removed: pick another in Settings');

  // Pixel, paused: nothing wakes it.
  const pixel = ctx.agents.seedAgent({ name: 'Pixel', domain: 'Screenshot reviewer', instructions: 'Check the store screenshots before each release.', avatar: 'bot:c.1.15.12.12.2.1.0', selection, status: 'paused', projectIds: [] }, now - 9 * 86_400_000);
  exchange(ctx, ctx.thread(pixel.threadId), { at: now - 4 * 86_400_000, prompt: 'Are the store screenshots current?', answer: 'Yes: all six match 2.0.3. I will look again before the next release.' });
}

/** A finished turn: the prompt (or a wake's label), then the agent's answer. */
/** A call a finished turn made on the way to its answer, with the words the agent said before it. */
interface StepSpec { narration?: string; tool: string; input: Record<string, unknown>; output: string }

function exchange(ctx: FakeContext, thread: Thread, spec: { at: number; prompt: string; answer: string; operation?: 'routine' | 'event'; label?: string; picture?: boolean; steps?: StepSpec[] }): Turn {
  const turn: Turn = { id: `turn-agents-demo-${++ctx.seq}`, threadId: thread.id, status: 'done', queuedAt: spec.at, startedAt: spec.at, finishedAt: spec.at + 2 * MINUTE, usage: null, error: null, execution: execution(thread, spec.operation) };
  thread.turns.push(turn);
  const prompt: MessagePart = { type: 'text', text: spec.prompt, ...(spec.label ? { displayText: spec.label } : {}) };
  thread.messages.push({ id: `m-${++ctx.seq}`, threadId: thread.id, turnId: turn.id, role: 'user', state: 'complete', createdAt: spec.at, parts: [prompt] });
  const parts: MessagePart[] = (spec.steps ?? []).flatMap((step, index): MessagePart[] => {
    const startedAt = spec.at + 10_000 + index * 20_000;
    const call: MessagePart = { type: 'tool', toolId: `tool-agents-demo-${++ctx.seq}`, name: step.tool, input: step.input, output: step.output, status: 'done', startedAt, finishedAt: startedAt + 8_000 };
    return step.narration ? [{ type: 'text', text: step.narration }, call] : [call];
  });
  parts.push({ type: 'text', text: spec.answer });
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
function deskThread(ctx: FakeContext, projectId: string, title: string, at: number, standing: 'idle' | 'running' | 'done'): Thread {
  const status = standing === 'running' ? 'running' : 'idle';
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
    ...(standing === 'done' ? { doneAt: at + 30 * MINUTE } : {}),
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
    { type: 'tool', toolId: `tool-${ctx.seq}-log`, name: 'Bash', input: { command: 'git log --oneline v2.0.3..release', description: 'List what landed since 2.0.3' }, output: 'a1b2c3d Fix login redirect loop\n9f8e7d6 Faster upload retries', status: 'done', startedAt: at + 45_000 },
    { type: 'tool', toolId: `tool-${ctx.seq}-grep`, name: 'Grep', input: { pattern: 'TODO\\(release\\)', path: 'packages' }, output: 'No matches', status: 'done', startedAt: at + 60_000 },
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
