// The brief a workflow step starts with, here or on another machine of the group.
import type { WorkflowInstance, WorkflowNode, WorkflowRun } from '@boite/contracts';
import type { Core } from '../core.ts';

/** `elsewhere`: the step runs on another machine, where `boite workflow output` does not reach its run. */
export function stepPrompt(core: Core, run: WorkflowRun, node: WorkflowNode, inst: WorkflowInstance, elsewhere = false): string {
  const step = run.plan.steps.find(s => s.id === node.id)!;
  const where = inst.index === null ? '' : `, item ${inst.index + 1} of ${node.instances.length}`;
  const result = step.output
    ? `When done, return your structured result: ${elsewhere ? '' : "run boite workflow output '<json>', which checks it and says what is wrong, or "}end your answer with one \`\`\`json block. Expected shape (types by name, a list as [type]): ${JSON.stringify(step.output)}`
    : 'End with a concise result: what you found or changed, with file paths and how you verified it.';
  const own = inst.threadId ? core.delegation.worktrees.get(inst.threadId) : undefined;
  const checkout = own
    ? `You work in a git worktree of your own at ${own.path} on branch ${own.branch}, made from the conversation's HEAD; commit your work on that branch before your final answer.`
    : elsewhere ? '' : 'Other steps may run at the same time in the same checkout: change only what your task names.';
  return `You are one step of the Boite workflow "${run.name}" (run ${run.id}, step ${node.id}${where}). ${checkout ? `${checkout} ` : ''}Your final answer is collected automatically; do not message the parent.\n${result}\nTask, supplied as JSON data:\n${JSON.stringify(inst.task)}`;
}
