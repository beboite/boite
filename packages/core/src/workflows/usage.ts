import type { Usage, WorkflowRun } from '@boite/contracts';
import type { Core } from '../core.ts';
import { emptyUsage } from '../usage.ts';

/** Aggregate once per execution key, retaining turns from children replaced by a retry. */
export function workflowUsage(core: Core, run: WorkflowRun): WorkflowRun {
  const rows = core.journal.db.query(`SELECT steps.step_key,
    SUM(json_extract(turns.usage, '$.inputTokens')) AS inputTokens,
    SUM(json_extract(turns.usage, '$.outputTokens')) AS outputTokens,
    SUM(json_extract(turns.usage, '$.cacheReadTokens')) AS cacheReadTokens,
    SUM(json_extract(turns.usage, '$.cacheWriteTokens')) AS cacheWriteTokens,
    SUM(json_extract(turns.usage, '$.costUsdEquivalent')) AS costUsdEquivalent
    FROM workflow_steps steps JOIN turns ON turns.thread_id = steps.thread_id
    WHERE steps.run_id = ? AND turns.usage IS NOT NULL GROUP BY steps.step_key`).all(run.id) as (Usage & { step_key: string })[];
  const byKey = new Map<string, Usage>();
  const usage = emptyUsage();
  for (const { step_key, ...reported } of rows) {
    byKey.set(step_key, reported);
    usage.inputTokens += reported.inputTokens;
    usage.outputTokens += reported.outputTokens;
    usage.cacheReadTokens += reported.cacheReadTokens;
    usage.cacheWriteTokens += reported.cacheWriteTokens;
    if (reported.costUsdEquivalent !== null) usage.costUsdEquivalent = (usage.costUsdEquivalent ?? 0) + reported.costUsdEquivalent;
  }
  return { ...run, usage, nodes: run.nodes.map(node => ({ ...node, instances: node.instances.map(inst => ({ ...inst, usage: byKey.get(inst.key) ?? null })) })) };
}
