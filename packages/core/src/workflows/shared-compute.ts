/** Adapts host-owned compute jobs into the existing durable workflow runner. No polling or extra runner. */
import { extractJson, shapeMismatch, type SharedComputeJob, type WorkflowInstance, type WorkflowNode, type WorkflowRun, type WorkflowStepPlan } from '@boite/contracts';
import type { Core } from '../core.ts';
import { invalidParams, messageOf } from '../errors.ts';
import { sameProject } from '../contacts/project-policy.ts';
import { fingerprint } from '../contacts/project-journal.ts';
import { terminalCompute } from '../contacts/compute-journal.ts';

interface Hooks {
  load: (id: string) => WorkflowRun | null;
  save: (run: WorkflowRun) => void;
  advance: (id: string) => void;
  runs: () => WorkflowRun[];
}
export class SharedWorkflowCompute {
  private readonly off: () => void;
  private closed = false;
  private readonly pending = new Set<Promise<unknown>>();
  private readonly dispatching = new Map<string, string>();
  constructor(private readonly core: Core, private readonly hooks: Hooks) {
    this.off = core.sharedCompute.registerChanged(job => {
      if (this.closed) return;
      for (const run of hooks.runs()) for (const node of run.nodes) for (const inst of node.instances)
        if (inst.compute?.jobId === job.id && inst.compute.requestId === job.requestId && run.rootThreadId === job.source.threadId
          && (!this.dispatching.has(`${run.id}:${inst.key}`) || this.dispatching.get(`${run.id}:${inst.key}`) === job.requestId)) this.receive(run.id, inst.key, job);
    });
  }
  check(rootId: string, step: WorkflowStepPlan): boolean {
    const target = step.compute;
    if (!target) return false;
    const ctx = this.core.sharedProjects.scope({threadId: rootId, sharedProjectId: target.sharedProjectId});
    if (!sameProject(target.host, ctx.local) && !sameProject(target.host, ctx.remote)) throw invalidParams(`compute.host: step ${step.id} must use an associated host`);
    const access = ctx.shared.access.find(a => sameProject(a.project, target.host))!;
    if (!access.compute.enabled || !access.compute.profiles.includes(target.profileId)) throw invalidParams(`compute.profileId: step ${step.id} must use an explicitly offered host profile`);
    return true;
  }
  launch(run: WorkflowRun, node: WorkflowNode, inst: WorkflowInstance): boolean {
    const target = run.plan.steps.find(s => s.id === node.id)?.compute;
    if (!target) return false;
    const old = inst.compute;
    const recovery = !!old && inst.error === 'Interrupted by a core restart';
    const attempts = recovery ? inst.attempts : inst.attempts + 1;
    const requestId = recovery ? old.requestId : `wf-${fingerprint([run.id, inst.key, attempts])}`;
    const key = `${run.id}:${inst.key}`;
    this.dispatching.set(key, requestId);
    Object.assign(inst, {status: 'running', attempts, error: null, result: null, output: null, startedAt: inst.startedAt ?? Date.now(), finishedAt: null});
    // Preserve the previous job until cancellation is confirmed. Its identity is never lost on a failed retry.
    this.hooks.save(run);
    const task = (async () => {
      // No ledger row means rejection preceded reservation/dispatch. Rows are never pruned.
      if (old && !recovery && (this.core.sharedCompute.journal.get(old.jobId, 'source') || this.core.sharedCompute.journal.get(old.jobId, 'host'))) {
        const stopped = await this.core.sharedCompute.cancel({threadId: run.rootThreadId, sharedProjectId: target.sharedProjectId, jobId: old.jobId, requestId: `retry-${requestId}`});
        if (!terminalCompute(stopped)) throw invalidParams('compute.retry: the previous captured job has not confirmed cancellation');
      }
      if (!this.running(run.id, inst.key)) return;
      const before = this.hooks.load(run.id)!, admitted = before.nodes.flatMap(n => n.instances).find(i => i.key === inst.key)!;
      admitted.compute = {requestId, jobId: this.core.sharedCompute.identity({threadId: run.rootThreadId, sharedProjectId: target.sharedProjectId}, requestId), host: target.host, worker: null, result: null};
      this.hooks.save(before);
      const job = await this.core.sharedCompute.start({threadId: run.rootThreadId, ...target, requestId, task: inst.task!, title: `${run.name} · ${node.title}`.slice(0, 120)});
      if (this.closed) return;
      const current = this.hooks.load(run.id), found = current?.nodes.flatMap(n => n.instances).find(i => i.key === inst.key);
      if (!current || !found || current.status === 'stopped' || found.status === 'stopped') {
        await this.core.sharedCompute.cancel({threadId: run.rootThreadId, sharedProjectId: target.sharedProjectId, jobId: job.id, requestId: `stopped-${requestId}`}); return;
      }
      found.compute = {requestId, jobId: job.id, host: job.host, worker: job.worker, result: job.result};
      this.hooks.save(current); this.receive(run.id, inst.key, job);
    })().catch(error => {
      if (this.closed) return;
      const current = this.hooks.load(run.id), found = current?.nodes.flatMap(n => n.instances).find(i => i.key === inst.key);
      if (current && found && found.status === 'running') {
        Object.assign(found, {status: 'failed', error: messageOf(error).slice(0, 500), finishedAt: Date.now()}); this.hooks.save(current); this.hooks.advance(run.id);
      }
    });
    this.pending.add(task); void task.finally(() => {this.pending.delete(task); if (this.dispatching.get(key) === requestId) this.dispatching.delete(key);});
    return true;
  }
  private running(id: string, key: string): boolean {
    const run = this.hooks.load(id);
    return !this.closed && !!run && (run.status === 'running' || run.status === 'paused') && run.nodes.flatMap(n => n.instances).some(i => i.key === key && i.status === 'running');
  }
  private receive(runId: string, key: string, job: SharedComputeJob): void {
    if (!this.running(runId, key)) return;
    const run = this.hooks.load(runId)!, inst = run.nodes.flatMap(n => n.instances).find(i => i.key === key)!;
    if (inst.compute && inst.compute.requestId !== job.requestId) return;
    inst.providerId = job.providerId; inst.model = job.model; inst.effort = job.effort;
    inst.compute = {requestId: job.requestId, jobId: job.id, host: job.host, worker: job.worker, result: job.result};
    if (job.status === 'done') {
      const step = run.plan.steps.find(s => s.id === key.split('#')[0])!;
      const result = job.result!.text, parsed = step.output === undefined ? null : extractJson(result);
      const mismatch = step.output === undefined ? null : parsed ? shapeMismatch(parsed.value, step.output) : 'Shared worker result has no JSON block';
      Object.assign(inst, {status: mismatch ? 'failed' : 'done', result, output: parsed?.value ?? null, error: mismatch, finishedAt: Date.now()});
    } else if (['failed', 'uncertain', 'cancelled', 'revoked'].includes(job.status)) {
      Object.assign(inst, {status: 'failed', error: job.error ?? `Shared job ${job.status}`, finishedAt: Date.now()});
    }
    this.hooks.save(run); if (inst.status !== 'running') this.hooks.advance(runId);
  }
  stop(run: WorkflowRun): void {
    for (const node of run.nodes) for (const inst of node.instances) if (inst.compute && inst.status === 'running') {
      const target = run.plan.steps.find(s => s.id === node.id)!.compute!;
      const work = this.core.sharedCompute.cancel({threadId: run.rootThreadId, sharedProjectId: target.sharedProjectId, jobId: inst.compute.jobId, requestId: `stop-${inst.compute.requestId}`}).catch(() => undefined);
      this.pending.add(work); void work.finally(() => this.pending.delete(work));
    }
  }
  beginClose(): void {this.closed = true; this.off();}
  async close(): Promise<void> {this.beginClose(); await Promise.allSettled([...this.pending]);}
}
