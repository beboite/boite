import type { WorkflowRun } from '@boite/contracts';
import type { Core } from './core.ts';

/**
 * Every status change of a workflow run, its steps and their instances, as
 * one log line each. The run record is saved whole on every change, so the
 * transitions are found by comparing it with what the last save held. Error
 * texts stay out: a step's error is its turn's raw error, which can echo the
 * prompt; `turn.failed` carries the diagnostic cause.
 */
export class WorkflowLog {
  private readonly seen = new Map<string, Map<string, string>>();

  constructor(private readonly core: Core) {}

  saved(run: WorkflowRun): void {
    const before = this.seen.get(run.id);
    const now = new Map<string, string>();
    const base = { source: 'workflows', threadId: run.rootThreadId };
    now.set('', run.status);
    const was = before?.get('');
    if (was !== run.status) {
      const level = run.status === 'failed' ? 'warn' : 'info';
      const message = was === undefined ? `Workflow ${run.id} "${run.name}" ${run.status === 'running' ? 'started' : `loaded as ${run.status}`} by ${run.launchedBy} with ${run.nodes.length} steps`
        : `Workflow ${run.id} went from ${was} to ${run.status}`;
      this.core.logs.record(level, message, {
        ...base, event: `workflow.${run.status}`, ...(run.finishedAt !== null ? { durationMs: run.finishedAt - run.createdAt } : {}),
        data: { runId: run.id, from: was ?? null, status: run.status, steps: run.nodes.length, launchedBy: run.launchedBy, error: run.error !== null },
      });
    }
    for (const node of run.nodes) {
      const key = `n:${node.id}`;
      now.set(key, node.status);
      const previous = before?.get(key);
      if (previous !== undefined && previous !== node.status) {
        this.core.logs.record(node.status === 'failed' ? 'warn' : 'info', `Workflow ${run.id} step ${node.id} went from ${previous} to ${node.status}`, {
          ...base, event: 'workflow.step', ...(node.startedAt !== null && node.finishedAt !== null ? { durationMs: node.finishedAt - node.startedAt } : {}),
          data: { runId: run.id, step: node.id, from: previous, status: node.status, instances: node.instances.length, error: node.error !== null },
        });
      }
      node.instances.forEach((inst, index) => {
        const instKey = `i:${node.id}:${index}`;
        now.set(instKey, inst.status);
        const previousInst = before?.get(instKey);
        if (previousInst === inst.status || (inst.status !== 'running' && inst.status !== 'failed' && inst.status !== 'done')) return;
        this.core.logs.record(inst.status === 'failed' ? 'warn' : 'debug', `Workflow ${run.id} step ${node.id} instance ${index} ${inst.status}${inst.status === 'running' && inst.attempts > 1 ? ` (attempt ${inst.attempts})` : ''}`, {
          source: 'workflows', event: 'workflow.instance', threadId: inst.threadId ?? run.rootThreadId,
          ...(inst.startedAt !== null && inst.finishedAt !== null ? { durationMs: inst.finishedAt - inst.startedAt } : {}),
          data: { runId: run.id, step: node.id, index, status: inst.status, attempts: inst.attempts, providerId: inst.providerId, model: inst.model, root: run.rootThreadId },
        });
      });
    }
    this.seen.delete(run.id);
    this.seen.set(run.id, now);
    if (this.seen.size > 200) this.seen.delete(this.seen.keys().next().value!);
  }
}
