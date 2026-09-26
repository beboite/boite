import {
  RpcErrorCode,
  WorkflowPlanError,
  WORKFLOW_LIMITS,
  checkPlan,
  checkSteps,
  conditionHolds,
  itemLabel,
  renderTask,
  resolvePath,
  shapeMismatch,
  workflowLevels,
  type DelegationConfig,
  type DelegationProfile,
  type Principal,
  type RpcMethodName,
  type RpcParams,
  type RpcResult,
  type Thread,
  type ThreadId,
  type WorkflowInstance,
  type WorkflowNode,
  type WorkflowPlan,
  type WorkflowRun,
  type WorkflowShape,
  type WorkflowStepPlan,
  type WorkflowStepStatus,
  type WorkflowTemplate,
} from '@boite/contracts';
import { RpcFailure } from '../client';
import { refusal } from './shared';

type WorkflowMethod = Extract<RpcMethodName, `workflows.${string}`>;
type Handlers = { [M in WorkflowMethod]: (params: RpcParams<M>) => RpcResult<M> | Promise<RpcResult<M>> };

/** What the in-memory engine asks of the fake core around it. */
export interface WorkflowHost {
  thread(threadId: ThreadId): Thread;
  config(rootId: ThreadId): DelegationConfig;
  /** Unpauses the delegation team, what an owner resume does in the core. */
  resumeTeam(rootId: ThreadId): void;
  /** A child thread of the root on that profile, its task as the first message. */
  child(root: Thread, profile: DelegationProfile, title: string, task: string): ThreadId;
  /** The child's answer lands and it goes idle; `ok` false leaves an error instead. */
  answer(threadId: ThreadId, text: string, ok: boolean): void;
  changed(rootId: ThreadId, runId: string): void;
  now(): number;
  delayMs(): number;
  principal(): Principal;
}

const ACTIVE_RUNS = 3;
const LIST_LIMIT = 20;
/** A fake step works for this many ticks of the client's delay before it answers. */
const STEP_TICKS = 60;
const ended = (status: WorkflowStepStatus) => status === 'done' || status === 'skipped';
const broken = (status: WorkflowStepStatus) => status === 'failed' || status === 'stopped';

function invalid(message: string): RpcFailure {
  return new RpcFailure({ code: RpcErrorCode.InvalidParams, message });
}

function planError<T>(run: () => T): T {
  try {
    return run();
  } catch (error) {
    if (error instanceof WorkflowPlanError) throw invalid(error.message);
    throw error;
  }
}

const WORDS = ['lexer', 'tokens', 'errors'];

/** A value of that shape, named after the key it sits under, so a fan-out has something to fan over. */
export function sampleOf(shape: WorkflowShape, key = '', depth = 0, index = 0): unknown {
  if (shape === 'string' || shape === 'any') return /file|path/i.test(key) ? `src/parser/${WORDS[index % WORDS.length]}.ts` : `${key || 'value'} ${index + 1}`;
  if (shape === 'number') return /line/i.test(key) ? 12 + index * 17 : index + 1;
  if (shape === 'boolean') return true;
  if (Array.isArray(shape)) return Array.from({ length: depth === 0 ? 3 : 1 }, (_, i) => sampleOf(shape[0]!, key, depth + 1, depth === 0 ? i : index));
  return Object.fromEntries(Object.entries(shape).map(([name, inner]) => [name, sampleOf(inner, name, depth, index)]));
}

/**
 * The core's `Workflows` in memory: the same refusals, states and columns, with
 * steps that answer on a timer instead of running an agent. A task that says
 * "fail" fails, so a retry has something to do on `?fake=1`.
 */
export class FakeWorkflows {
  #runs = new Map<string, WorkflowRun>();
  #requests = new Map<string, { fingerprint: string; runId: string }>();
  #templates = new Map<string, WorkflowTemplate>();
  #steps = new Map<ThreadId, { runId: string; key: string }>();
  #timers = new Set<ReturnType<typeof setTimeout>>();
  #seq = 0;
  /** Set while a demo is seeded: its steps wait for `finish` instead of a timer. */
  #held = false;

  constructor(private readonly host: WorkflowHost) {}

  /** Runs `seed` with no step timers, so a seeded run stays where it was put. */
  hold(seed: () => void): void {
    this.#held = true;
    try {
      seed();
    } finally {
      this.#held = false;
    }
  }

  handles(method: RpcMethodName): method is WorkflowMethod { return Object.hasOwn(this.handlers, method); }
  async call(method: WorkflowMethod, params: unknown): Promise<unknown> { return this.handlers[method](params as never); }
  close(): void {
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers.clear();
  }
  /** The step threads, so the Agents panel does not drop one it is showing. */
  owns(threadId: ThreadId): boolean { return this.#steps.has(threadId); }

  private readonly handlers: Handlers = {
    'workflows.list': ({ threadId }) => {
      const root = this.#rootOf(threadId);
      return [...this.#runs.values()].filter(run => run.rootThreadId === root.id)
        .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id)).slice(0, LIST_LIMIT).map(run => structuredClone(run));
    },
    'workflows.get': ({ threadId, runId }) => {
      const run = this.#runs.get(runId);
      if (!run || run.rootThreadId !== this.#rootOf(threadId).id) throw invalid(`runId: no workflow run ${String(runId)} on this thread`);
      return structuredClone(run);
    },
    'workflows.check': ({ threadId, plan }) => {
      const config = this.#team(this.#rootOf(threadId).id);
      const checked = planError(() => checkPlan(plan, { profiles: config.profiles.map(p => p.id) }));
      return { levels: workflowLevels(checked.steps.map(s => ({ id: s.id, after: s.deps }))) };
    },
    'workflows.start': (params) => structuredClone(this.start(params.threadId, params.plan, params.requestId, params.templateId, 'user')),
    'workflows.extend': (params) => {
      const run = this.#own(params.threadId, params.runId);
      const key = `${run.id}:${params.requestId}`;
      const fingerprint = JSON.stringify(params.steps);
      const prior = this.#requests.get(key);
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw refusal('requestId already used for different content');
        return structuredClone(this.#runs.get(prior.runId)!);
      }
      if (run.status !== 'running' && run.status !== 'paused') throw refusal(`the run is ${run.status}; only a running or paused run takes new steps`);
      const config = this.#team(run.rootThreadId);
      const steps = planError(() => checkSteps(params.steps, { profiles: config.profiles.map(p => p.id), existing: run.nodes.map(n => ({ id: n.id, after: n.after })) }));
      run.plan.steps.push(...steps.map(({ deps: _deps, ...step }) => step));
      run.nodes.push(...steps.map(step => this.#node(step, step.deps)));
      this.#requests.set(key, { fingerprint, runId: run.id });
      this.#save(run);
      this.#advance(run.id);
      return structuredClone(this.#runs.get(run.id)!);
    },
    'workflows.control': (params) => structuredClone(this.#control(params)),
    'workflows.output': ({ threadId, value }) => {
      const entry = this.#steps.get(threadId);
      if (!entry) throw refusal('boite workflow output works only inside a workflow step');
      const run = this.#runs.get(entry.runId)!;
      const inst = this.#instance(run, entry.key);
      if (!inst || inst.status !== 'running') throw refusal(`step ${entry.key} is not running`);
      const shape = run.plan.steps.find(s => s.id === entry.key.split('#')[0])?.output;
      const mismatch = shape === undefined ? null : shapeMismatch(value, shape);
      if (mismatch) throw invalid(`${mismatch}; expected shape ${JSON.stringify(shape)}`);
      inst.output = value;
      this.#save(run);
      return { runId: run.id, step: entry.key };
    },
    'workflows.templates.list': ({ threadId }) => {
      const root = this.#rootOf(threadId);
      return [...this.#templates.values()].filter(t => t.projectId === root.projectId).sort((a, b) => a.name.localeCompare(b.name)).map(t => structuredClone(t));
    },
    'workflows.templates.save': (params) => {
      const root = this.#rootOf(params.threadId);
      const name = typeof params.name === 'string' ? params.name.trim() : '';
      if (!name || name.length > 80) throw invalid('name: expected 1 to 80 characters');
      const named = Array.isArray((params.plan as { steps?: unknown } | null)?.steps) ? params.plan.steps.map(s => String(s?.profile ?? '')) : [];
      const { plan } = planError(() => checkPlan(params.plan, { profiles: named }));
      const mine = [...this.#templates.values()].filter(t => t.projectId === root.projectId);
      const byId = params.templateId === undefined ? null : mine.find(t => t.id === params.templateId) ?? null;
      if (params.templateId !== undefined && !byId) throw invalid(`templateId: no template ${params.templateId} in this project`);
      const previous = byId ?? mine.find(t => t.name === name) ?? null;
      const now = this.host.now();
      const template: WorkflowTemplate = { id: previous?.id ?? `wft_${++this.#seq}`, projectId: root.projectId, name, plan: { ...plan, name }, createdAt: previous?.createdAt ?? now, updatedAt: now };
      this.#templates.set(template.id, template);
      this.host.changed(root.id, '');
      return structuredClone(template);
    },
    'workflows.templates.remove': ({ threadId, templateId }) => {
      const root = this.#rootOf(threadId);
      const found = this.#templates.get(templateId);
      const removed = found !== undefined && found.projectId === root.projectId;
      if (removed) this.#templates.delete(templateId);
      this.host.changed(root.id, '');
      return { removed };
    },
  };

  /** What `workflows.start` does, also the seed's way in. */
  start(threadId: ThreadId, plan: WorkflowPlan, requestId: string, templateId: string | undefined, by: 'agent' | 'user'): WorkflowRun {
    const root = this.host.thread(threadId);
    if (root.parentThreadId) throw refusal('a workflow step or delegated agent cannot start a workflow; ask its parent');
    if (root.archived) throw refusal('cannot start a workflow on an archived thread');
    const fingerprint = JSON.stringify([plan, templateId ?? null]);
    const key = `${root.id}:${requestId}`;
    const prior = this.#requests.get(key);
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw refusal('requestId already used for different content');
      return this.#runs.get(prior.runId)!;
    }
    const config = this.#team(root.id);
    const checked = planError(() => checkPlan(plan, { profiles: config.profiles.map(p => p.id) }));
    if (templateId !== undefined && !this.#templates.has(templateId)) throw invalid(`templateId: no template ${templateId}`);
    const active = [...this.#runs.values()].filter(run => run.rootThreadId === root.id && (run.status === 'running' || run.status === 'paused')).length;
    if (active >= ACTIVE_RUNS) throw refusal(`this thread already has ${active} unfinished workflows; stop or finish one first`);
    const now = this.host.now();
    const run: WorkflowRun = {
      id: `wfr_${++this.#seq}`, rootThreadId: root.id, name: checked.plan.name, status: 'running', plan: checked.plan,
      nodes: checked.steps.map(step => this.#node(step, step.deps)), limits: checked.limits, error: null, launchedBy: by,
      templateId: templateId ?? null, delivered: false,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsdEquivalent: null },
      createdAt: now, updatedAt: now, finishedAt: null,
    };
    this.#runs.set(run.id, run);
    this.#requests.set(key, { fingerprint, runId: run.id });
    this.#save(run);
    this.#advance(run.id);
    return this.#runs.get(run.id)!;
  }

  /** Ends one running execution now, the way its timer would, for a demo that must not move. */
  finish(runId: string, key: string, ok = true): void {
    const run = this.#runs.get(runId);
    const inst = run && this.#instance(run, key);
    if (!run || !inst || inst.status !== 'running') return;
    const step = run.plan.steps.find(s => s.id === key.split('#')[0])!;
    const failing = !ok || /\bfail\b/i.test(inst.task ?? '');
    const output = step.output === undefined || failing ? null : sampleOf(step.output, step.id, 0, inst.index ?? 0);
    const answer = failing ? 'The step could not finish: the task asked it to fail.' : output === null ? `${step.title ?? step.id}: done, nothing else to report.` : `Done.\n\n\`\`\`json\n${JSON.stringify(output, null, 2)}\n\`\`\``;
    if (inst.threadId) this.host.answer(inst.threadId, answer, !failing);
    const now = this.host.now();
    if (failing) Object.assign(inst, { status: 'failed', error: 'The turn failed', finishedAt: now });
    else Object.assign(inst, { status: 'done', result: answer.slice(0, WORKFLOW_LIMITS.resultChars), output, finishedAt: now });
    this.#save(run);
    this.#advance(run.id);
  }

  /** Stops and holds the runs of a thread whose turn the user stopped. */
  stopRoot(rootId: ThreadId, reason: string): void {
    for (const run of this.#runs.values()) if (run.rootThreadId === rootId && (run.status === 'running' || run.status === 'paused')) this.#stop(run, reason);
  }

  #rootOf(threadId: ThreadId): Thread {
    const thread = this.host.thread(threadId);
    return thread.parentThreadId ? this.host.thread(thread.parentThreadId) : thread;
  }

  #own(threadId: ThreadId, runId: unknown): WorkflowRun {
    const run = typeof runId === 'string' ? this.#runs.get(runId) : undefined;
    if (!run) throw invalid(`runId: no workflow run ${String(runId)}; boite workflow list shows this thread's runs`);
    if (run.rootThreadId !== threadId) throw refusal('runId belongs to another thread; only the thread that started a run controls it');
    return run;
  }

  #team(rootId: ThreadId): DelegationConfig {
    const config = this.host.config(rootId);
    if (!config.enabled) throw refusal('workflows run on delegation profiles: the owner enables delegation for this thread in Agents first');
    if (config.paused) throw refusal('delegation is paused for this thread; the owner resumes it in Agents');
    return config;
  }

  #node(step: WorkflowStepPlan, after: string[]): WorkflowNode {
    return { id: step.id, title: step.title ?? step.id, profileId: step.profile, after, forEach: step.forEach ?? null, status: 'waiting', instances: [], error: null, startedAt: null, finishedAt: null };
  }

  #save(run: WorkflowRun): void {
    run.updatedAt = this.host.now();
    this.host.changed(run.rootThreadId, run.id);
  }

  #instance(run: WorkflowRun, key: string): WorkflowInstance | undefined {
    for (const node of run.nodes) {
      const found = node.instances.find(i => i.key === key);
      if (found) return found;
    }
    return undefined;
  }

  #values(run: WorkflowRun): Record<string, unknown> {
    const values: Record<string, unknown> = {};
    const valueOf = (inst: WorkflowInstance) => inst.output ?? inst.result;
    for (const node of run.nodes) {
      if (node.status === 'skipped') values[node.id] = null;
      else if (node.status === 'done') values[node.id] = node.forEach ? node.instances.map(valueOf) : node.instances[0] ? valueOf(node.instances[0]) : null;
    }
    return values;
  }

  #halted(run: WorkflowRun): boolean {
    return run.nodes.some(node => broken(node.status) || node.instances.some(i => broken(i.status)));
  }

  #advance(runId: string): void {
    const run = this.#runs.get(runId);
    if (!run || run.status !== 'running') return;
    this.#settleNodes(run);
    const config = this.host.config(run.rootThreadId);
    if (!config.enabled || config.paused) {
      Object.assign(run, { status: 'paused', error: 'Delegation is paused or disabled for this thread. Resume to continue.' });
      this.#save(run);
      return;
    }
    for (let progress = true; progress;) {
      progress = false;
      const values = this.#values(run);
      for (const node of run.nodes) {
        if (node.status !== 'waiting' || node.instances.length) continue;
        const deps = node.after.map(id => run.nodes.find(n => n.id === id)!);
        if (!deps.every(dep => ended(dep.status))) continue;
        this.#open(run, node, values);
        progress = true;
      }
    }
    for (;;) {
      if (this.#halted(run)) break;
      const running = run.nodes.reduce((n, node) => n + node.instances.filter(i => i.status === 'running').length, 0);
      if (running >= run.limits.maxConcurrent) break;
      const node = run.nodes.find(n => n.instances.some(i => i.status === 'waiting'));
      if (!node) break;
      this.#launch(run, node, node.instances.find(i => i.status === 'waiting')!, config);
    }
    this.#settleNodes(run);
    const now = this.host.now();
    if (!run.nodes.some(node => node.instances.some(i => i.status === 'running'))) {
      const failure = run.nodes.find(node => broken(node.status));
      if (failure) Object.assign(run, { status: 'failed', error: `${failure.title}: ${failure.error ?? failure.status}`, finishedAt: now });
      else if (run.nodes.every(node => ended(node.status))) Object.assign(run, { status: 'done', error: null, finishedAt: now, delivered: true });
    }
    this.#save(run);
  }

  #open(run: WorkflowRun, node: WorkflowNode, values: Record<string, unknown>): void {
    const step = run.plan.steps.find(s => s.id === node.id)!;
    const now = this.host.now();
    const fail = (error: string) => Object.assign(node, { status: 'failed', error, startedAt: now, finishedAt: now });
    if (step.when && !conditionHolds(step.when, values)) {
      Object.assign(node, { status: 'skipped', startedAt: now, finishedAt: now });
      return;
    }
    let items: unknown[] | null = null;
    if (step.forEach) {
      const list = resolvePath(values, step.forEach.split('.'));
      if (!Array.isArray(list)) return void fail(`forEach: ${step.forEach} is not a list`);
      items = list;
    }
    const used = run.nodes.reduce((n, other) => n + other.instances.length, 0);
    const count = items ? items.length : 1;
    if (used + count > run.limits.maxSteps) return void fail(`${count} executions would pass this run's limit of ${run.limits.maxSteps} (${used} used); raise limits.maxSteps up to ${WORKFLOW_LIMITS.maxSteps} or narrow the list`);
    if (items && items.length === 0) {
      Object.assign(node, { status: 'done', startedAt: now, finishedAt: now });
      return;
    }
    node.instances = (items ?? [undefined]).map((item, index) => ({
      key: items ? `${node.id}#${index}` : node.id, index: items ? index : null, label: items ? itemLabel(item) : '',
      threadId: null, providerId: null, model: null, status: 'waiting', attempts: 0,
      task: renderTask(step.task, items ? { ...values, item, index } : values), result: null, output: null,
      error: null, startedAt: null, finishedAt: null,
    }));
    Object.assign(node, { status: 'running', startedAt: now, error: null });
  }

  #launch(run: WorkflowRun, node: WorkflowNode, inst: WorkflowInstance, config: DelegationConfig): void {
    const now = this.host.now();
    if (inst.threadId === null) {
      const profile = config.profiles.find(p => p.id === node.profileId);
      if (!profile) {
        Object.assign(inst, { status: 'failed', error: `profile ${node.profileId} is no longer approved for this thread`, startedAt: now, finishedAt: now });
        return;
      }
      const title = `${run.name} · ${node.title}${inst.label ? ` · ${inst.label}` : ''}`.slice(0, 120);
      const threadId = this.host.child(this.host.thread(run.rootThreadId), profile, title, inst.task ?? '');
      this.#steps.set(threadId, { runId: run.id, key: inst.key });
      Object.assign(inst, { threadId, providerId: profile.providerId, model: profile.model });
    }
    Object.assign(inst, { status: 'running', attempts: 1, error: null, result: null, output: null, startedAt: now, finishedAt: null });
    if (this.#held) return;
    const runId = run.id, key = inst.key;
    const timer = setTimeout(() => {
      this.#timers.delete(timer);
      this.finish(runId, key);
    }, this.host.delayMs() * STEP_TICKS);
    this.#timers.add(timer);
  }

  #settleNodes(run: WorkflowRun): void {
    const halted = this.#halted(run);
    const now = this.host.now();
    for (const node of run.nodes) {
      if (node.status !== 'running' || !node.instances.length) continue;
      const running = node.instances.some(i => i.status === 'running');
      const done = node.instances.every(i => ended(i.status));
      if (!done && (running || !halted)) continue;
      const failed = node.instances.find(i => i.status === 'failed');
      const stopped = node.instances.find(i => i.status === 'stopped');
      if (!failed && !stopped && !done) continue;
      node.status = failed ? 'failed' : stopped ? 'stopped' : 'done';
      node.error = (failed ?? stopped)?.error ?? null;
      node.finishedAt = now;
    }
  }

  #control(params: RpcParams<'workflows.control'>): WorkflowRun {
    const run = this.#own(params.threadId, params.runId);
    const principal = this.host.principal();
    switch (params.action) {
      case 'pause':
        if (run.status !== 'running') throw refusal(`the run is ${run.status}, not running`);
        Object.assign(run, { status: 'paused', error: null });
        this.#save(run);
        return run;
      case 'resume':
        if (run.status !== 'paused') throw refusal(`the run is ${run.status}, not paused`);
        if (principal === 'session') throw refusal('resuming a workflow is an owner action');
        this.#resumeTeam(run.rootThreadId);
        Object.assign(run, { status: 'running', error: null });
        break;
      case 'stop':
        if (run.status !== 'running' && run.status !== 'paused') throw refusal(`the run is ${run.status} already`);
        this.#stop(run, 'Stopped');
        return run;
      case 'retry': {
        if (principal === 'session') throw refusal('retrying a workflow step is an owner action');
        if (run.status === 'done') throw refusal('the run finished; start it again instead');
        const nodes = params.stepId === undefined ? run.nodes.filter(n => broken(n.status) || n.instances.some(i => broken(i.status))) : run.nodes.filter(n => n.id === params.stepId);
        if (params.stepId !== undefined && !nodes.length) throw invalid(`stepId: no step ${params.stepId} in this run`);
        this.#resumeTeam(run.rootThreadId);
        for (const node of run.nodes) {
          const target = nodes.includes(node);
          for (const inst of node.instances) if (target && broken(inst.status)) Object.assign(inst, { status: 'waiting', finishedAt: null });
          if (target && !node.instances.length && broken(node.status)) Object.assign(node, { status: 'waiting', error: null, startedAt: null, finishedAt: null });
          else if (target && node.instances.some(i => i.status === 'waiting')) Object.assign(node, { status: 'running', error: null, finishedAt: null });
          else if (node.status === 'stopped' && !node.instances.length) Object.assign(node, { status: 'waiting', error: null, startedAt: null, finishedAt: null });
        }
        if (this.#halted(run)) throw refusal('nothing to retry in that step; retry the step that failed');
        Object.assign(run, { status: 'running', error: null, finishedAt: null, delivered: false });
        break;
      }
      default:
        throw invalid('action: expected pause, resume, stop or retry');
    }
    this.#save(run);
    this.#advance(run.id);
    return run;
  }

  #resumeTeam(rootId: ThreadId): void {
    const config = this.host.config(rootId);
    if (!config.enabled) throw refusal('delegation is disabled for this thread; the owner enables it in Agents');
    if (!config.paused) return;
    if (this.host.principal() !== 'owner') throw refusal('delegation is paused for this thread; the owner resumes it');
    this.host.resumeTeam(rootId);
  }

  #stop(run: WorkflowRun, reason: string): void {
    const now = this.host.now();
    for (const node of run.nodes) {
      for (const inst of node.instances) {
        if (inst.status === 'waiting' || inst.status === 'running') {
          if (inst.status === 'running' && inst.threadId) this.host.answer(inst.threadId, reason, false);
          Object.assign(inst, { status: 'stopped', error: reason, finishedAt: now });
        }
      }
      if (node.status === 'waiting') Object.assign(node, { status: 'stopped', error: reason, finishedAt: now });
      if (node.status === 'running') {
        const failed = node.instances.find(i => i.status === 'failed');
        Object.assign(node, { status: failed ? 'failed' : node.instances.every(i => i.status === 'done') ? 'done' : 'stopped', finishedAt: now });
      }
    }
    Object.assign(run, { status: 'stopped', error: reason, finishedAt: now, delivered: true });
    this.#save(run);
  }
}
