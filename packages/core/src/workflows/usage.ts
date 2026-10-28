import type { Usage, WorkflowRun } from '@boite/contracts';
import type { Core } from '../core.ts';
import { usageGroups } from '../journal/usage-sums.ts';
import { sumGroups, usageTotal } from '../usage.ts';

/** Aggregate once per execution key, retaining turns from children replaced by a retry. */
export function workflowUsage(core: Core, run: WorkflowRun): WorkflowRun {
  const groups = usageGroups(core.journal.db, { key: 'steps.step_key', join: 'JOIN workflow_steps steps ON steps.thread_id = t.thread_id', where: 'steps.run_id = ?' }, run.id);
  const byKey = sumGroups(core, groups) as Map<string | null, Usage>;
  const usage = usageTotal(core, groups);
  return { ...run, usage, nodes: run.nodes.map(node => ({ ...node, instances: node.instances.map(inst => ({ ...inst, usage: byKey.get(inst.key) ?? null })) })) };
}
