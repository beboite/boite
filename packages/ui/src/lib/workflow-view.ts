/**
 * What the workflow surface and the chat card read off a run: its columns,
 * its edges, each step's route and progress. Pure, so the layout rules are
 * tested without a DOM.
 */
import { workflowLevels, type DelegationProfile, type WorkflowNode, type WorkflowRun, type WorkflowStepStatus } from '@boite/contracts';

/** Under this width per column the graph reads as a list of phases instead. */
export const COLUMN_MIN = 168;
/** The horizontal room the arrows take between two columns. */
export const COLUMN_GAP = 36;

/** One column per dependency level, in plan order inside a column. */
export function columnsOf(run: WorkflowRun): WorkflowNode[][] {
  const byId = new Map(run.nodes.map(node => [node.id, node]));
  return workflowLevels(run.nodes).map(ids => ids.map(id => byId.get(id)!));
}

/**
 * The arrows of the graph, from a dependency to the step that waits for it.
 * A dependency another one already implies draws no arrow: `report` after
 * `fix` after `review` shows two arrows, not a third jumping over `fix`.
 * The step's detail still lists every dependency.
 */
export function edgesOf(run: WorkflowRun): { from: string; to: string }[] {
  const byId = new Map(run.nodes.map(node => [node.id, node]));
  const reach = new Map<string, Set<string>>();
  const upstream = (id: string): Set<string> => {
    const known = reach.get(id);
    if (known) return known;
    const found = new Set<string>();
    reach.set(id, found);
    for (const dep of byId.get(id)?.after ?? []) {
      if (!byId.has(dep)) continue;
      found.add(dep);
      for (const further of upstream(dep)) found.add(further);
    }
    return found;
  };
  return run.nodes.flatMap(node => {
    const deps = node.after.filter(dep => byId.has(dep));
    return deps.filter(dep => !deps.some(other => other !== dep && upstream(other).has(dep))).map(dep => ({ from: dep, to: node.id }));
  });
}

/** Whether `columns` columns fit side by side in `width` pixels. */
export function fitsColumns(width: number, columns: number): boolean {
  return columns <= 1 || width >= columns * COLUMN_MIN + (columns - 1) * COLUMN_GAP;
}

export function ended(status: WorkflowStepStatus): boolean {
  return status === 'done' || status === 'skipped';
}

/** Steps that ended, of all steps: a fan-out counts once. */
export function runProgress(run: WorkflowRun): { done: number; total: number } {
  return { done: run.nodes.filter(node => ended(node.status)).length, total: run.nodes.length };
}

/** Executions of one step, for its count and its segmented bar. */
export function nodeProgress(node: WorkflowNode): { done: number; total: number; running: number; failed: number } {
  const count = (status: WorkflowStepStatus) => node.instances.filter(inst => inst.status === status).length;
  return { done: count('done'), total: node.instances.length, running: count('running'), failed: count('failed') + count('stopped') };
}

/** The route a step runs on: its first execution's once started, its profile's before. */
export function routeOf(node: WorkflowNode, profiles: DelegationProfile[]): { providerId: string; model: string; profile: string } | null {
  const started = node.instances.find(inst => inst.providerId !== null);
  const profile = profiles.find(entry => entry.id === node.profileId);
  if (started?.providerId) return { providerId: started.providerId, model: started.model ?? profile?.model ?? '', profile: profile?.name ?? node.profileId };
  return profile ? { providerId: profile.providerId, model: profile.model, profile: profile.name } : null;
}

/** When the step started and ended, across its executions. */
export function nodeTiming(node: WorkflowNode): { startedAt: number | null; finishedAt: number | null; active: boolean } {
  const starts = node.instances.map(inst => inst.startedAt).filter((at): at is number => at !== null);
  const active = node.instances.some(inst => inst.status === 'running');
  const startedAt = starts.length ? Math.min(...starts) : node.startedAt;
  const ends = node.instances.map(inst => inst.finishedAt).filter((at): at is number => at !== null);
  const finishedAt = active ? null : ends.length ? Math.max(...ends) : node.finishedAt;
  return { startedAt, finishedAt, active };
}

export function runTokens(run: WorkflowRun): number {
  return run.usage.inputTokens + run.usage.outputTokens + run.usage.cacheReadTokens + run.usage.cacheWriteTokens;
}

export function isLive(run: WorkflowRun): boolean {
  return run.status === 'running' || run.status === 'paused';
}

/** Anything a retry could start again. */
export function retryable(run: WorkflowRun): boolean {
  return run.status !== 'done' && run.nodes.some(node => node.status === 'failed' || node.status === 'stopped' || node.instances.some(inst => inst.status === 'failed' || inst.status === 'stopped'));
}

/** A step's output as the detail pane prints it: JSON indented, a string as itself. */
export function shown(value: unknown): string {
  if (value === null || value === undefined) return '';
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}
