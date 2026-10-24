import { isThreadTerminal, type Thread, type ThreadArchiveReason, type ThreadId } from '@boite/contracts';
import type { FakeContext } from './context';
import { pathKey } from './checks';
import { describedProject } from './project-archive';
import { hasActiveSideQuestion, retainedFamilyIds } from './side-questions';

/** Deterministic disk/GitHub evidence for offline tests; the fake never polls a network. */
export interface MergedPrFixture {
  repository: string;
  /** The checkout's branch, which its agent may have changed from the thread's starting branch. */
  branch: string;
  tip: string;
  clean: boolean;
  /** `linked` PRs were attached with `boite pr link`: their head may have another name than the checkout's branch. */
  candidates: { repository: string; branch: string; sha: string; number: number; url: string; mergedAt: string; fork?: boolean; linked?: boolean }[];
  beforeValidate?: () => Promise<void>;
  workflowActive?: boolean;
}
export interface FakeArchiveState {
  generation: number;
  binding?: string;
  dismissed: string[];
  restoredCheckout?: string;
}
export const checkoutKey = (thread: { projectId: string | null; cwd: string; branch: string | null }): string => JSON.stringify([thread.projectId, thread.cwd, thread.branch]);

export function dismissMergedPr(ctx: FakeContext, id: ThreadId): void {
  const thread = ctx.thread(id);
  const state = ctx.mergedPrArchive.get(id) ?? { generation: 0, dismissed: [] };
  ctx.mergedPrArchive.set(id, { ...state, generation: state.generation + 1, dismissed: [...new Set([...state.dismissed, ...(state.binding ? [state.binding] : [])])], restoredCheckout: checkoutKey(thread) });
  delete thread.archiveReason;
}

function eligible(ctx: FakeContext, id: ThreadId, detected = false): boolean {
  if (ctx.bus.state !== 'ready') return false;
  const thread = ctx.threads.get(id);
  const fixture = ctx.mergedPrFixtures.get(id);
  if (!thread || !fixture || thread.archived || thread.parentThreadId || thread.agentSessionId || !thread.projectId || !thread.branch || thread.branch === 'HEAD' || thread.branchNamingPending || fixture.workflowActive) return false;
  const project = ctx.projects.find(project => project.id === thread.projectId);
  if (!project || project.archived || project.autoArchiveMergedPr === false || project.path === thread.cwd || (!detected && ctx.bus.focusedThreadId === id) || ctx.hasProtectedInput(id)) return false;
  if (ctx.removedWorktrees.has(pathKey(thread.cwd)) || ctx.goneFolders.has(pathKey(thread.cwd)) || ctx.goneFolders.has(pathKey(project.path)) || ctx.worktrees.some(checkout => pathKey(checkout.path) === pathKey(thread.cwd) && (checkout.dirty || checkout.missing))) return false;
  const all = [...ctx.threads.values(), ...[...ctx.deletedThreads.values()].flatMap(family => family.threads)];
  if ([...retainedFamilyIds(ctx, id)].some(memberId => {
    const member = ctx.threads.get(memberId);
    return !member || !quiescent(ctx, member, memberId !== id, detected);
  })) return false;
  return all.filter(holder => !holder.parentThreadId && !holder.agentSessionId && holder.branch === thread.branch && (holder.projectId === thread.projectId || ctx.mergedPrFixtures.get(holder.id)?.repository === fixture.repository)).length === 1;
}

function quiescent(ctx: FakeContext, thread: Thread, child = false, detected = false): boolean {
  const id = thread.id;
  const finishing = detected && !child && thread.status === 'running';
  if (thread.agentSessionId || (thread.status !== 'idle' && !finishing) || (!detected && (thread.unread || ctx.bus.focusedThreadId === id)) || thread.pinned || thread.pendingMove || (!finishing && thread.background?.length) || ctx.workflows.active(id) || ctx.hasProtectedInput(id)) return false;
  if (hasActiveSideQuestion(ctx, id)) return false;
  if ((!finishing && (ctx.inFlight.has(id) || [...ctx.scheduler.running, ...ctx.scheduler.queued].some(entry => entry.threadId === id) || ctx.processes.some(process => process.threadId === id && process.exitedAt === null))) || ctx.heldAnswers.get(id)?.length || ctx.processes.some(process => isThreadTerminal(id, process.threadId) && process.exitedAt === null) || [...ctx.terminals.keys()].some(key => isThreadTerminal(id, key))) return false;
  if ([...ctx.pendingPermissions.values(), ...ctx.pendingQuestions.values()].some(entry => entry.request.threadId === id)) return false;
  if ((thread.activity?.goal && thread.activity.goal.status !== 'complete') || (thread.activity?.loop && thread.activity.loop.status !== 'complete')) return false;
  const last = thread.turns.at(-1);
  if ((child && !last) || (last && last.status !== 'done' && !(finishing && last.status === 'running'))) return false;
  if ([...(ctx.delegationLetters.get(id) ?? []), ...(ctx.letters.get(id) ?? [])].some(letter => !['delivered', 'expired', 'rejected'].includes(letter.status))) return false;
  return true;
}

export async function sweepMergedPrFixtures(ctx: FakeContext, detectedId?: ThreadId): Promise<number> {
  let count = 0;
  const detected = detectedId !== undefined;
  for (const id of (detected ? [detectedId] : [...ctx.mergedPrFixtures.keys()]).filter(id => eligible(ctx, id, detected)).slice(0, 8)) {
    const thread = ctx.thread(id), fixture = ctx.mergedPrFixtures.get(id)!;
    const state = ctx.mergedPrArchive.get(id) ?? { generation: 0, dismissed: [] };
    const checkout = checkoutKey(thread), updatedAt = thread.updatedAt;
    const candidate = fixture.candidates.length === 1 ? fixture.candidates[0] : undefined;
    const proof = candidate ? { ...candidate, branch: fixture.branch } : undefined;
    if (!proof || proof.fork || proof.repository !== fixture.repository || (!candidate!.linked && candidate!.branch !== fixture.branch) || proof.sha !== fixture.tip || !/^[a-f0-9]{40,64}$/.test(fixture.tip) || !fixture.clean || !Number.isFinite(Date.parse(proof.mergedAt)) || !Number.isInteger(proof.number) || proof.number < 1) continue;
    let url: URL;
    try { url = new URL(proof.url); } catch { continue; }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || `${url.host}${url.pathname}`.toLowerCase() !== `${fixture.repository}/pull/${proof.number}`.toLowerCase()) continue;
    if (state.dismissed.includes(proof.url) || state.restoredCheckout === checkout) continue;
    ctx.mergedPrArchive.set(id, { ...state, binding: proof.url });
    await fixture.beforeValidate?.();
    const currentFixture = ctx.mergedPrFixtures.get(id);
    if (!eligible(ctx, id, detected) || (!detected && ctx.thread(id).updatedAt !== updatedAt) || checkoutKey(ctx.thread(id)) !== checkout || (ctx.mergedPrArchive.get(id)?.generation ?? 0) !== state.generation || !currentFixture || currentFixture.repository !== proof.repository || !currentFixture.clean || currentFixture.tip !== proof.sha || currentFixture.branch !== proof.branch) continue;
    const reason: ThreadArchiveReason = { type: 'pr-merged', number: proof.number, url: proof.url, archivedAt: ctx.now() };
    thread.archived = true;
    thread.doneAt = Date.now();
    thread.archivedAt = thread.doneAt;
    thread.archiveReason = reason;
    ctx.touch(thread);
    if (thread.turns.at(-1)?.execution?.operation === 'compact') void ctx.stopTurn(id);
    const project = ctx.projects.find(project => project.id === thread.projectId)!;
    ctx.emit('project.updated', describedProject(ctx, project));
    count++;
  }
  return count;
}
