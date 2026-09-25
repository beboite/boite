/*
 * The contract, as behaviour. Each scenario drives one method through an
 * environment and throws on the first answer that differs from the rule, so
 * the same list runs against the real core over WebSocket
 * (`packages/core/test/contract.test.ts`) and against the in-memory client
 * (`packages/ui/src/lib/fake-client.contract.test.ts`). A scenario makes
 * everything it touches and reads codes, data keys and events, never message
 * text: the words may change, the refusal may not.
 */
import {
  RpcErrorCode,
  type Account,
  type ProviderSummary,
  type RpcEventName,
  type RpcEvents,
  type RpcMethodName,
  type RpcParams,
  type RpcResult,
  type ThreadSummary,
} from '../../packages/contracts/src/index.ts';

export interface ContractEnv {
  call<M extends RpcMethodName>(method: M, params: RpcParams<M>): Promise<RpcResult<M>>;
  on<E extends RpcEventName>(event: E, handler: (payload: RpcEvents[E]) => void): () => void;
  /** A folder that exists, a new one per call. */
  newFolder(): Promise<string>;
  /** A path where no folder is. */
  missingFolder(): string;
  /** The same folder spelt in another case, or null where the file system tells case apart. */
  otherCase(path: string): string | null;
}

export type Scenario = (env: ContractEnv) => Promise<void>;

/** The code and data of a refused call, whichever client carried it. */
export function failure(error: unknown): { code: number; data: Record<string, unknown> } {
  const raw = error as { code?: unknown; data?: unknown; rpc?: { code?: unknown; data?: unknown } };
  const source = raw?.rpc ?? raw;
  if (typeof source?.code !== 'number') throw error;
  const data = typeof source.data === 'object' && source.data !== null ? (source.data as Record<string, unknown>) : {};
  return { code: source.code, data };
}

function check(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function same(actual: unknown, expected: unknown, what: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  check(a === b, `${what}: expected ${b}, got ${a}`);
}

/** Awaits a call that must be refused with `code`, and returns the refusal's data. */
async function refusedWith(call: Promise<unknown>, code: number, keys: string[] = []): Promise<Record<string, unknown>> {
  let answer: unknown;
  try {
    answer = await call;
  } catch (error) {
    const { code: got, data } = failure(error);
    check(got === code, `expected code ${code}, got ${got} (${error instanceof Error ? error.message : String(error)})`);
    for (const key of keys) check(key in data, `the refusal's data has no ${key}: ${JSON.stringify(data)}`);
    return data;
  }
  throw new Error(`expected code ${code}, the call answered ${JSON.stringify(answer)?.slice(0, 200)}`);
}

async function until(what: string, test: () => Promise<boolean> | boolean, timeoutMs = 5000): Promise<void> {
  const started = Date.now();
  while (!(await test())) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Every event of these names, in arrival order, until `stop`. */
function record(env: ContractEnv, names: RpcEventName[]): { events: { name: RpcEventName; payload: unknown }[]; stop(): void } {
  const events: { name: RpcEventName; payload: unknown }[] = [];
  const offs = names.map((name) => env.on(name, (payload) => events.push({ name, payload })));
  return { events, stop: () => offs.forEach((off) => off()) };
}

interface Echo {
  provider: ProviderSummary;
  account: Account;
  model: string;
  levels: string[];
  projectId: string;
  projectPath: string;
}

/** The echo provider, its account, its default model and a new project to work in. */
async function echo(env: ContractEnv): Promise<Echo> {
  const { loaded } = await env.call('providers.list', {});
  const provider = loaded.find((entry) => entry.protocol === 'echo');
  check(provider !== undefined, 'no echo provider');
  const account = (await env.call('accounts.list', {})).find((entry) => entry.providerId === provider.id);
  check(account !== undefined, 'no echo account');
  const model = provider.models.find((entry) => entry.default === true) ?? provider.models[0];
  check(model !== undefined, 'the echo provider lists no model');
  const project = await env.call('projects.add', { path: await env.newFolder(), name: 'contract' });
  return { provider, account, model: model.id, levels: model.effort?.levels.map((level) => level.id) ?? [], projectId: project.id, projectPath: project.path };
}

function thread(env: ContractEnv, setup: Echo, title = 'contract'): Promise<ThreadSummary> {
  return env.call('threads.create', { projectId: setup.projectId, providerId: setup.provider.id, accountId: setup.account.id, title });
}

async function summary(env: ContractEnv, threadId: string): Promise<ThreadSummary> {
  const found = (await env.call('threads.list', { includeArchived: true })).find((entry) => entry.id === threadId);
  check(found !== undefined, `thread ${threadId} is not listed`);
  return found;
}

/** One echo turn, run to its end, so the thread has a turn to ask in. */
async function finishedTurn(env: ContractEnv, threadId: string): Promise<void> {
  await env.call('turns.start', { threadId, prompt: 'hello' });
  await until('the turn to finish', async () => !['queued', 'running', 'waiting'].includes((await summary(env, threadId)).status));
}

/** A thread with a two-option, single-choice card on it. */
async function asked(env: ContractEnv): Promise<{ setup: Echo; threadId: string; questionId: string }> {
  const setup = await echo(env);
  const { id: threadId } = await thread(env, setup);
  await finishedTurn(env, threadId);
  const { questionId } = await env.call('questions.ask', { threadId, text: 'Which one?', options: ['short', 'long'] });
  return { setup, threadId, questionId };
}

async function stillPending(env: ContractEnv, threadId: string, questionId: string): Promise<void> {
  const pending = await env.call('questions.list', { threadId });
  check(pending.some((request) => request.id === questionId), 'a refused answer dropped the question');
}

/** A provider this machine cannot run that signs in, with a new account of its own. */
async function unavailable(env: ContractEnv): Promise<{ provider: ProviderSummary; account: Account }> {
  const { loaded } = await env.call('providers.list', {});
  const provider = loaded.find((entry) => !entry.available && entry.login !== false);
  check(provider !== undefined, 'every provider that signs in is available: nothing to refuse');
  const account = await env.call('accounts.add', { providerId: provider.id, label: 'contract', useDefaultLocation: false });
  return { provider, account };
}

export const SCENARIOS: Record<string, Scenario> = {
  'questions.answer refuses an answer sent for another thread': async (env) => {
    const { setup, threadId, questionId } = await asked(env);
    const other = await thread(env, setup, 'other');
    const data = await refusedWith(env.call('questions.answer', { threadId: other.id, questionId, optionIds: ['1'] }), RpcErrorCode.Refused, ['expected']);
    same(data.expected, threadId, 'expected thread');
    await stillPending(env, threadId, questionId);
  },
  'questions.answer refuses an option the question does not offer': async (env) => {
    const { threadId, questionId } = await asked(env);
    const data = await refusedWith(env.call('questions.answer', { threadId, questionId, optionIds: ['9'] }), RpcErrorCode.Refused, ['unknown', 'expected']);
    same(data.unknown, ['9'], 'unknown options');
    same(data.expected, ['1', '2'], 'offered options');
    await stillPending(env, threadId, questionId);
  },
  'questions.answer refuses two options on a single-choice question': async (env) => {
    const { threadId, questionId } = await asked(env);
    await refusedWith(env.call('questions.answer', { threadId, questionId, optionIds: ['1', '2'] }), RpcErrorCode.Refused);
    await stillPending(env, threadId, questionId);
  },
  'questions.answer refuses an empty answer': async (env) => {
    const { threadId, questionId } = await asked(env);
    await refusedWith(env.call('questions.answer', { threadId, questionId, optionIds: [] }), RpcErrorCode.Refused);
    await stillPending(env, threadId, questionId);
  },
  'questions.answer takes a valid answer and the question goes': async (env) => {
    const { threadId, questionId } = await asked(env);
    await env.call('questions.answer', { threadId, questionId, optionIds: ['2'] });
    const pending = await env.call('questions.list', { threadId });
    check(!pending.some((request) => request.id === questionId), 'an answered question is still pending');
  },
  'questions.ask refuses empty text, too many options and a non-boolean multiple': async (env) => {
    const setup = await echo(env);
    const { id: threadId } = await thread(env, setup);
    await finishedTurn(env, threadId);
    same((await refusedWith(env.call('questions.ask', { threadId, text: '   ' }), RpcErrorCode.Refused, ['field'])).field, 'text', 'field');
    const thirteen = Array.from({ length: 13 }, (_, index) => `option ${index}`);
    same((await refusedWith(env.call('questions.ask', { threadId, text: 'Which?', options: thirteen }), RpcErrorCode.Refused, ['field'])).field, 'options', 'field');
    const multiple = 'yes' as unknown as boolean;
    same((await refusedWith(env.call('questions.ask', { threadId, text: 'Which?', options: ['a', 'b'], multiple }), RpcErrorCode.Refused, ['field'])).field, 'multiple', 'field');
  },
  'questions.ask makes a one-option card single-choice and trims its labels': async (env) => {
    const setup = await echo(env);
    const { id: threadId } = await thread(env, setup);
    await finishedTurn(env, threadId);
    const { questionId } = await env.call('questions.ask', { threadId, text: ' Sure? ', options: [' yes '], multiple: true });
    const request = (await env.call('questions.list', { threadId })).find((entry) => entry.id === questionId);
    check(request !== undefined, 'the card is not listed');
    same([request.text, request.multiple, request.allowText, request.options], ['Sure?', false, true, [{ id: '1', label: 'yes' }]], 'the card');
  },
  'questions.ask refuses a thread with no turn yet': async (env) => {
    const setup = await echo(env);
    const { id: threadId } = await thread(env, setup);
    await refusedWith(env.call('questions.ask', { threadId, text: 'Which?' }), RpcErrorCode.Refused);
  },
  'threads.create refuses an unknown provider': async (env) => {
    const setup = await echo(env);
    await refusedWith(env.call('threads.create', { projectId: setup.projectId, providerId: 'no-such-provider', accountId: setup.account.id }), RpcErrorCode.NotFound);
  },
  'threads.create refuses a model the provider does not list': async (env) => {
    const setup = await echo(env);
    const data = await refusedWith(env.call('threads.create', { projectId: setup.projectId, providerId: setup.provider.id, accountId: setup.account.id, model: 'no-such-model' }), RpcErrorCode.Refused, ['expected']);
    check(Array.isArray(data.expected) && data.expected.includes(setup.model), `the refusal names ${JSON.stringify(data.expected)}, not the listed models`);
  },
  'threads.create refuses an effort the model does not offer': async (env) => {
    const setup = await echo(env);
    const data = await refusedWith(env.call('threads.create', { projectId: setup.projectId, providerId: setup.provider.id, accountId: setup.account.id, model: setup.model, effort: 'no-such-effort' }), RpcErrorCode.Refused, ['expected']);
    same(data.expected, setup.levels, 'offered levels');
  },
  'threads.create refuses a working directory outside the project': async (env) => {
    const setup = await echo(env);
    const data = await refusedWith(env.call('threads.create', { projectId: setup.projectId, providerId: setup.provider.id, accountId: setup.account.id, cwd: `${setup.projectPath}-elsewhere` }), RpcErrorCode.Refused, ['cwd', 'projectPath']);
    same(data.projectPath, setup.projectPath, 'project path');
  },
  'threads.create refuses an account of another provider': async (env) => {
    const setup = await echo(env);
    const { account } = await unavailable(env);
    const data = await refusedWith(env.call('threads.create', { projectId: setup.projectId, providerId: setup.provider.id, accountId: account.id }), RpcErrorCode.Refused, ['accountId']);
    same(data.accountId, account.id, 'account');
  },
  'threads.create refuses a worktree in the drafts': async (env) => {
    const setup = await echo(env);
    const drafts = await env.call('projects.drafts', {});
    await refusedWith(env.call('threads.create', { projectId: drafts.id, providerId: setup.provider.id, accountId: setup.account.id, worktree: {} }), RpcErrorCode.Refused, ['projectId']);
  },
  'threads.create names an untitled thread and picks the default model': async (env) => {
    const setup = await echo(env);
    const created = await env.call('threads.create', { projectId: setup.projectId, providerId: setup.provider.id, accountId: setup.account.id, title: '' });
    same([created.title, created.model, created.effort, created.cwd], ['New thread', setup.model, null, setup.projectPath], 'the new thread');
  },
  'threads.update keeps the title when the new one is empty': async (env) => {
    const setup = await echo(env);
    const created = await thread(env, setup, 'named');
    const updated = await env.call('threads.update', { threadId: created.id, title: '' });
    same([updated.title, updated.titleSource], ['named', created.titleSource], 'the title');
  },
  'threads.update refuses an unlisted model and changes nothing': async (env) => {
    const setup = await echo(env);
    const created = await thread(env, setup);
    await refusedWith(env.call('threads.update', { threadId: created.id, model: 'no-such-model' }), RpcErrorCode.Refused, ['expected']);
    await refusedWith(env.call('threads.update', { threadId: created.id, effort: 'no-such-effort' }), RpcErrorCode.Refused, ['expected']);
    const after = await summary(env, created.id);
    same([after.model, after.effort], [created.model, created.effort], 'the selection');
  },
  'turns.start refuses a provider this machine cannot run': async (env) => {
    const setup = await echo(env);
    const { provider, account } = await unavailable(env);
    const created = await env.call('threads.create', { projectId: setup.projectId, providerId: provider.id, accountId: account.id });
    const data = await refusedWith(env.call('turns.start', { threadId: created.id, prompt: 'hello' }), RpcErrorCode.Unavailable, ['providerId']);
    same(data.providerId, provider.id, 'provider');
  },
  'settings.set refuses a value of the wrong kind and names the field': async (env) => {
    const cases: [Record<string, unknown>, string][] = [
      [{ maxConcurrentTurns: 1.5 }, 'maxConcurrentTurns'],
      [{ warmProcessMinutes: -1 }, 'warmProcessMinutes'],
      [{ agentCpuCapPercent: 150 }, 'agentCpuCapPercent'],
      [{ focusGuard: 'yes' }, 'focusGuard'],
      [{ publicUrl: 'http://example.com' }, 'publicUrl'],
      [{ browserOrigins: ['https://example.com/path'] }, 'browserOrigins'],
    ];
    for (const [patch, field] of cases) {
      const data = await refusedWith(env.call('settings.set', patch as RpcParams<'settings.set'>), RpcErrorCode.InvalidParams, ['field']);
      same(data.field, field, `the field of ${JSON.stringify(patch)}`);
    }
  },
  'projects.add refuses a folder that does not exist': async (env) => {
    const path = env.missingFolder();
    await refusedWith(env.call('projects.add', { path }), RpcErrorCode.Refused, ['path']);
  },
  'projects.add answers the same project for the same folder': async (env) => {
    const added = record(env, ['project.added']);
    const path = await env.newFolder();
    const first = await env.call('projects.add', { path });
    const again = await env.call('projects.add', { path });
    const spelt = env.otherCase(first.path);
    const third = spelt === null ? again : await env.call('projects.add', { path: spelt });
    // A positive sentinel: once this one is announced, any second announcement of the first came before it.
    const sentinel = await env.call('projects.add', { path: await env.newFolder() });
    await until('the sentinel project', () => added.events.some((event) => (event.payload as { id: string }).id === sentinel.id));
    added.stop();
    same([again.id, third.id], [first.id, first.id], 'the ids');
    same(added.events.filter((event) => (event.payload as { id: string }).id === first.id).length, 1, 'project.added for the folder');
  },
  'accounts.add names an unlabelled account and reads its session': async (env) => {
    const setup = await echo(env);
    const account = await env.call('accounts.add', { providerId: setup.provider.id, label: '', useDefaultLocation: true });
    same([account.label, account.status, account.isolationDir], ['Account', 'ok', null], 'the echo account');
    const { account: isolated } = await unavailable(env);
    same(isolated.status, 'unauthenticated', 'a new isolated account that signs in');
  },
  'accounts.add refuses an unknown provider': async (env) => {
    await refusedWith(env.call('accounts.add', { providerId: 'no-such-provider', label: 'x' }), RpcErrorCode.NotFound);
  },
  'threads.markRead on a read thread announces nothing': async (env) => {
    const setup = await echo(env);
    const created = await thread(env, setup);
    const updates = record(env, ['thread.updated']);
    await env.call('threads.markRead', { threadId: created.id });
    await env.call('threads.pin', { threadId: created.id, pinned: true });
    await until('the pin', () => updates.events.length > 0);
    updates.stop();
    const first = updates.events[0]?.payload as ThreadSummary;
    check(first.pinned, 'threads.markRead announced a thread that was already read');
  },
  'threads.archive announces the archived thread': async (env) => {
    const setup = await echo(env);
    const created = await thread(env, setup);
    const updates = record(env, ['thread.updated']);
    const answer = await env.call('threads.archive', { threadId: created.id, archived: true });
    await until('the archive', () => updates.events.some((event) => (event.payload as ThreadSummary).archived));
    updates.stop();
    check(answer.archived, 'the answer is not archived');
  },
  'projects.remove archives each thread before removing it': async (env) => {
    const setup = await echo(env);
    const created = await thread(env, setup);
    const events = record(env, ['thread.updated', 'thread.removed', 'project.removed']);
    await env.call('projects.remove', { projectId: setup.projectId });
    await until('project.removed', () => events.events.some((event) => event.name === 'project.removed'));
    events.stop();
    const order = events.events
      .filter((event) => event.name === 'project.removed' || (event.payload as { id?: string; threadId?: string }).id === created.id || (event.payload as { threadId?: string }).threadId === created.id)
      .map((event) => (event.name === 'thread.updated' ? `thread.updated archived=${(event.payload as ThreadSummary).archived}` : event.name));
    same(order.filter((entry, index) => index === 0 || entry !== order[index - 1]), ['thread.updated archived=true', 'thread.removed', 'project.removed'], 'the events');
  },
};

/**
 * Scenarios allowed to fail on one side, each with why. A runner fails a
 * listed scenario that passes, so a fixed drift leaves the list with its fix.
 */
export const KNOWN_DIVERGENCES: Record<string, { side: 'core' | 'fake'; reason: string }> = {};
