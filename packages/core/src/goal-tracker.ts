import { CONTEXT_TRIMMABLE_PROTOCOLS, GOAL_TRACKER_DEFAULTS, defaultTrackerModel } from '@boite/contracts';
import type { GoalChecklist, ThreadActivity, ThreadSummary, Turn } from '@boite/contracts';
import type { Core } from './core.ts';
import { messageOf, refused } from './errors.ts';
import { accountFor, conversationRoute, type ChildRoute } from './delegation/routes.ts';
import { checkEffort, modelsFor, PROBED_PROTOCOLS } from './threads/selection.ts';
import { assertDriverRunnable, probedModelsOf } from './drivers/index.ts';
import type { ProviderProbe } from './providers/probe.ts';
import { checkPrompt, joinDigests, readCheck, readUpdate, readWrite, TRACKER_RULES, turnDigest, updatePrompt, writePrompt } from './goal-tracker-prompt.ts';

/**
 * The tracker of a `/goal2`: one child conversation per goal that writes the
 * checklist from the objective, updates it on the user's later messages and,
 * after each turn of the agent, marks what that turn did. Its passes run one
 * at a time, in the order they were asked for; a check holds the goal's next
 * turn until it answers, so the agent hears what is still open.
 */

/** A pass that has not answered by then is stopped; the goal goes on without it. Mutable for tests. */
export const TRACKER_PASS = { timeoutMs: 5 * 60_000, retryMs: 250 };
/** First passes tried before a goal goes on without a checklist. */
const WRITE_TRIES = 3;
/** Polls of a tracker conversation that is still settling its last turn. */
const BUSY_TRIES = 40;

type Goal = NonNullable<ThreadActivity['goal']>;
type Job = { kind: 'write' } | { kind: 'update'; messages: string[] } | { kind: 'check'; turns: string[] };

/** What the goal's activity store lends the tracker. */
export interface TrackerHost {
  /** The live goal: the tracker changes its checklist, then saves. */
  goal(threadId: string): Goal | null;
  generation(threadId: string): number;
  save(threadId: string): void;
  /** A check answered, failed or was dropped: the goal may go on. */
  checked(threadId: string): void;
}

interface Tracking {
  generation: number;
  written: boolean;
  writes: number;
  /** The user's messages no pass has read yet. */
  messages: string[];
  /** The agent's turns no check has read yet. */
  turns: string[];
  /** The pass in flight, on the tracker conversation `threadId`. */
  running: { job: Job; threadId: string; turnId: string; timer: ReturnType<typeof setTimeout> } | null;
  /** Its agent's models are being read before the tracker conversation starts; once per try. */
  reading: boolean;
  read: boolean;
  busy: number;
  timer: ReturnType<typeof setTimeout> | null;
}

export const newChecklist = (): GoalChecklist => ({ threadId: null, phase: 'idle', items: [], model: null, effort: null, error: null });

/** A read of an agent's models that has not answered by then gives up; the child's creation then says why. */
const MODEL_READ_MS = 30_000;

/**
 * A child about to start on a model its agent has not listed since the last
 * account change forgot the list: that route's own account reads it first, as
 * a spawn does. Null when the model is listed, the route takes the agent's
 * default, the agent lists its models without a read, the list was read
 * already (reading again would change nothing), or the core has no probe.
 */
export function modelRead(core: Core, probe: ProviderProbe | null, route: ChildRoute): Promise<void> | null {
  if (!probe || route.model === null) return null;
  const provider = core.providers.require(route.providerId);
  if (!PROBED_PROTOCOLS.includes(provider.protocol) || probedModelsOf(provider.protocol, provider.id, route.accountId) !== null) return null;
  if (modelsFor(provider, route.accountId).some(model => model.id === route.model)) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('timed out reading its models')), MODEL_READ_MS); });
  return Promise.race([probe({ providerId: provider.id, accountId: route.accountId }), late]).then(() => undefined).finally(() => clearTimeout(timer));
}

export class GoalTracker {
  private readonly goals = new Map<string, Tracking>();
  /** Every tracker conversation, to its goal's thread. */
  private readonly trackers = new Map<string, string>();
  private closed = false;
  private probe: ProviderProbe | null = null;

  constructor(private readonly core: Core, private readonly host: TrackerHost) {}

  /** How the tracker reads an agent's models before its conversation starts on one. */
  useProbe(probe: ProviderProbe): void { this.probe = probe; }

  /** A tracker conversation: delegation runs it as a step it does not own, and its answers never become mail. */
  owns(threadId: string): boolean { return this.trackers.has(threadId); }

  /** A saved goal's tracker after a restart: known again, its unread work lost. */
  adopt(goalThreadId: string, list: GoalChecklist): boolean {
    if (list.threadId) this.trackers.set(list.threadId, goalThreadId);
    if (list.phase === 'idle') return false;
    list.phase = 'idle';
    return true;
  }

  /** A new `/goal2`: its first pass writes the list. */
  begin(threadId: string): void {
    this.stop(threadId);
    this.goals.set(threadId, this.fresh(threadId, false));
    this.pump(threadId);
  }

  /** A message of the user while the goal runs: the list may grow, shrink or change. */
  message(threadId: string, text: string): void {
    const tracking = this.tracking(threadId);
    if (!tracking || !text.trim()) return;
    tracking.messages.push(text.trim());
    this.pump(threadId);
  }

  /** A finished turn of the agent: the next check reads it, and the goal waits for that check. */
  turnEnded(threadId: string, turnId: string): void {
    const tracking = this.tracking(threadId);
    if (!tracking) return;
    tracking.turns.push(turnId);
    this.pump(threadId);
  }

  /** True while a turn waits for its check: the goal's next turn or review waits too. */
  holds(threadId: string): boolean {
    const tracking = this.goals.get(threadId);
    return !!tracking && (tracking.turns.length > 0 || tracking.running?.job.kind === 'check');
  }

  /** The goal ended or was replaced: its unread work is dropped and a running pass stopped. */
  stop(threadId: string): void {
    const tracking = this.goals.get(threadId);
    if (!tracking) return;
    this.goals.delete(threadId);
    if (tracking.timer) clearTimeout(tracking.timer);
    if (!tracking.running) return;
    const { threadId: tracker, timer } = tracking.running;
    clearTimeout(timer);
    try { this.core.threads.stopTurn(tracker); } catch (error) { this.core.log('warn', `goal checklist ${tracker}: ${messageOf(error)}`); }
    // A replaced goal's list is the new one's: only the list this pass worked on goes idle.
    const list = this.host.goal(threadId)?.checklist;
    if (list?.threadId === tracker) { list.phase = 'idle'; this.host.save(threadId); }
  }

  /** A conversation was deleted: a goal's tracking or a tracker's record goes with it. */
  removed(threadId: string): void {
    this.stop(threadId);
    this.trackers.delete(threadId);
    for (const [tracker, goal] of this.trackers) if (goal === threadId) this.trackers.delete(tracker);
  }

  /** A tracker conversation's turn ended. False when the turn is not a tracker's. */
  finished(turn: Turn): boolean {
    const threadId = this.trackers.get(turn.threadId);
    if (threadId === undefined) return false;
    const tracking = this.goals.get(threadId);
    const run = tracking?.running;
    if (!tracking || !run || run.turnId !== turn.id) return true;
    clearTimeout(run.timer);
    tracking.running = null;
    const list = this.host.goal(threadId)?.checklist;
    if (list && tracking.generation === this.host.generation(threadId)) {
      if (turn.status !== 'done') list.error = `The checklist pass ${turn.status === 'stopped' ? 'was stopped' : `failed: ${turn.error ?? 'no error given'}`}.`;
      else this.apply(tracking, list, run.job, this.answer(turn));
      list.phase = 'idle';
      this.host.save(threadId);
    }
    if (run.job.kind === 'check') this.host.checked(threadId);
    this.later(threadId, TRACKER_PASS.retryMs);
    return true;
  }

  close(): void {
    this.closed = true;
    for (const threadId of [...this.goals.keys()]) this.stop(threadId);
  }

  private apply(tracking: Tracking, list: GoalChecklist, job: Job, answer: string): void {
    const result = job.kind === 'write' ? readWrite(answer) : job.kind === 'update' ? readUpdate(answer, list.items) : readCheck(answer, list.items);
    if (typeof result === 'string') { list.error = result; return; }
    list.items = result;
    list.error = null;
    if (job.kind === 'write') tracking.written = true;
  }

  /** The goal's tracking, rebuilt after a restart from what its list already holds. */
  private tracking(threadId: string): Tracking | undefined {
    const goal = this.host.goal(threadId);
    if (this.closed || !goal?.checklist || goal.status === 'complete') return undefined;
    let tracking = this.goals.get(threadId);
    if (!tracking) this.goals.set(threadId, tracking = this.fresh(threadId, goal.checklist.items.length > 0));
    return tracking;
  }

  private fresh(threadId: string, written: boolean): Tracking {
    return { generation: this.host.generation(threadId), written, writes: written ? 1 : 0, messages: [], turns: [], running: null, reading: false, read: false, busy: 0, timer: null };
  }

  private later(threadId: string, delay: number): void {
    const tracking = this.goals.get(threadId);
    if (!tracking || this.closed) return;
    if (tracking.timer) clearTimeout(tracking.timer);
    tracking.timer = setTimeout(() => { tracking.timer = null; this.pump(threadId); }, delay);
  }

  /** Start the next pass: the first list, then the user's messages, then the agent's turns. */
  private pump(threadId: string): void {
    const tracking = this.goals.get(threadId);
    const goal = this.host.goal(threadId);
    const list = goal?.checklist;
    if (this.closed || !tracking || tracking.running || tracking.reading || !goal || !list) return;
    if (goal.status === 'complete' || tracking.generation !== this.host.generation(threadId)) { this.release(threadId, tracking); return; }
    const waiting = tracking.messages.length > 0 || tracking.turns.length > 0;
    if (!tracking.written) {
      if (tracking.writes === 0 || (waiting && tracking.writes < WRITE_TRIES)) { this.pass(threadId, tracking, goal, { kind: 'write' }); return; }
      // Without a list there is nothing to update or check.
      if (tracking.writes >= WRITE_TRIES) { tracking.messages = []; this.release(threadId, tracking); }
      return;
    }
    if (tracking.messages.length) { this.pass(threadId, tracking, goal, { kind: 'update', messages: tracking.messages.splice(0) }); return; }
    if (!tracking.turns.length) return;
    const turns = tracking.turns.splice(0);
    // Nothing left open: no check to pay for.
    if (!list.items.some(item => item.status === 'open')) { this.host.checked(threadId); return; }
    this.pass(threadId, tracking, goal, { kind: 'check', turns });
  }

  /** Drop the turns waiting for a check and let the goal go on. */
  private release(threadId: string, tracking: Tracking): void {
    if (!tracking.turns.length) return;
    tracking.turns = [];
    this.host.checked(threadId);
  }

  private pass(threadId: string, tracking: Tracking, goal: Goal, job: Job): void {
    const list = goal.checklist!;
    const parent = this.core.journal.getThread(threadId);
    // A first pass counts as tried even when it cannot start: the goal stops waiting for a list after three.
    if (job.kind === 'write') tracking.writes++;
    try {
      if (!parent || parent.archived) throw refused('the goal\'s conversation is gone or archived');
      let tracker = list.threadId ? this.core.journal.getThread(list.threadId) : null;
      if (tracker && this.core.threads.isBusy(tracker.id)) {
        // The last pass is still settling: try again in a moment.
        if (++tracking.busy < BUSY_TRIES) {
          if (job.kind === 'write') tracking.writes--;
          this.putBack(tracking, job);
          this.later(threadId, TRACKER_PASS.retryMs);
          return;
        }
        // The next pass waits again in full: this one fails, counted, and lets the goal go on.
        tracking.busy = 0;
        throw refused('the checklist conversation is still busy with an earlier pass');
      }
      tracking.busy = 0;
      if (!tracker || tracker.archived) {
        const route = this.route(parent);
        const read = tracking.read ? null : modelRead(this.core, this.probe, route);
        if (read) {
          // Read once, then try again: a model still missing is refused by the conversation's creation.
          if (job.kind === 'write') tracking.writes--;
          this.putBack(tracking, job);
          Object.assign(tracking, { reading: true, read: true });
          void read.catch(() => undefined).then(() => { tracking.reading = false; this.later(threadId, 0); });
          return;
        }
        tracker = this.core.threads.require(this.create(parent, goal, list, route));
      }
      const provider = this.core.providers.require(tracker.providerId);
      assertDriverRunnable(provider.protocol, this.core.providers.summary(provider.id), this.core.accounts.require(tracker.accountId), () => this.core.providers.launcherScriptOnly(provider.id));
      const prompt = job.kind === 'write' ? writePrompt(goal.objective)
        : job.kind === 'update' ? updatePrompt(list.items, job.messages)
        : checkPrompt(list.items, joinDigests(job.turns.map(id => turnDigest(this.core.journal.walkTurnMessages(threadId, id, { blobs: false })))));
      const label = job.kind === 'write' ? 'Write the checklist' : job.kind === 'update' ? 'Update the checklist from your message' : 'Check what the agent did';
      const turn = this.core.threads.startTurn(tracker.id, prompt, [], undefined, 'delegation', undefined, undefined, label);
      const timer = setTimeout(() => this.timeout(threadId, turn.id), TRACKER_PASS.timeoutMs);
      tracking.running = { job, threadId: tracker.id, turnId: turn.id, timer };
      list.phase = job.kind === 'check' ? 'checking' : 'writing';
      this.host.save(threadId);
    } catch (error) {
      list.error = `The checklist could not ${job.kind === 'write' ? 'be written' : job.kind === 'update' ? 'be updated' : 'be checked'}: ${messageOf(error)}`;
      // The next try reads the agent's models again: an account change may have forgotten them meanwhile.
      tracking.read = false;
      list.phase = 'idle';
      this.host.save(threadId);
      if (job.kind === 'check') this.host.checked(threadId);
      // A first pass is tried again on the next message or turn, then the goal goes on without a list.
      this.later(threadId, TRACKER_PASS.retryMs);
    }
  }

  private putBack(tracking: Tracking, job: Job): void {
    if (job.kind === 'update') tracking.messages.unshift(...job.messages);
    if (job.kind === 'check') tracking.turns.unshift(...job.turns);
  }

  private create(parent: ThreadSummary, goal: Goal, list: GoalChecklist, route: ChildRoute): string {
    const provider = this.core.providers.require(route.providerId);
    // No guides, servers or hooks where the agent can leave them out, and one harmless tool: a pass reads only its prompt.
    const context = CONTEXT_TRIMMABLE_PROTOCOLS.includes(provider.protocol) ? { preset: 'neutral', tools: ['Read'], rules: TRACKER_RULES } : { drop: ['guides'], rules: TRACKER_RULES };
    const id = this.core.delegation.createChild(parent, route, `Checklist · ${goal.objective}`.replace(/\s+/g, ' ').slice(0, 120), child => { this.trackers.set(child, parent.id); }, context);
    Object.assign(list, { threadId: id, model: `${route.providerId}/${route.model ?? 'default'}`, effort: route.effort ?? null });
    return id;
  }

  /**
   * The model Settings names, else the default rules on the conversation's own
   * agent, then on any signed-in one, else the conversation's own model.
   */
  route(parent: ThreadSummary): ChildRoute {
    const chosen = this.core.settings.get().goalTracker;
    if (chosen) {
      const provider = this.core.providers.get(chosen.providerId);
      if (!provider) throw refused(`the checklist model ${chosen.providerId}/${chosen.model} is not installed on this machine; pick another in Settings, Experiments`, { field: 'goalTracker' });
      const account = accountFor(this.core, parent, provider.id);
      if (!account || account.status === 'unauthenticated') throw refused(`${provider.name} has no signed-in account to keep the checklist; sign in or pick another model in Settings, Experiments`, { field: 'goalTracker' });
      const listed = modelsFor(provider, account.id).some(model => model.id === chosen.model);
      const effort = listed ? checkEffort(provider, account.id, chosen.model, chosen.effort) : chosen.effort;
      return { id: 'goal-tracker', name: chosen.model, providerId: provider.id, accountId: account.id, model: chosen.model, effort };
    }
    const candidates = this.core.providers.available().flatMap(summary => {
      const provider = this.core.providers.require(summary.id);
      const account = accountFor(this.core, parent, summary.id);
      if (!account || account.status === 'unauthenticated') return [];
      const pick = defaultTrackerModel(provider.protocol, modelsFor(provider, account.id));
      return pick ? [{ provider, account, ...pick }] : [];
    });
    const own = candidates.find(entry => entry.provider.id === parent.providerId);
    const best = own ?? GOAL_TRACKER_DEFAULTS.flatMap(rule => candidates.filter(entry => entry.provider.protocol === rule.protocol))[0];
    if (!best) return conversationRoute(parent);
    let effort: string | null = best.effort;
    try { effort = checkEffort(best.provider, best.account.id, best.model, best.effort); } catch { effort = null; }
    return { id: 'goal-tracker', name: best.model, providerId: best.provider.id, accountId: best.account.id, model: best.model, effort };
  }

  private timeout(threadId: string, turnId: string): void {
    const tracking = this.goals.get(threadId);
    if (!tracking?.running || tracking.running.turnId !== turnId) return;
    const { job, threadId: tracker } = tracking.running;
    tracking.running = null;
    try { this.core.threads.stopTurn(tracker); } catch { /* it ended meanwhile */ }
    const list = this.host.goal(threadId)?.checklist;
    if (list) {
      list.error = `The checklist pass took over ${Math.round(TRACKER_PASS.timeoutMs / 60_000)} minutes and was stopped.`;
      list.phase = 'idle';
      this.host.save(threadId);
    }
    if (job.kind === 'check') this.host.checked(threadId);
    this.later(threadId, TRACKER_PASS.retryMs);
  }

  /** Every text the pass wrote, its JSON block included. */
  private answer(turn: Turn): string {
    const texts: string[] = [];
    for (const message of this.core.journal.walkTurnMessages(turn.threadId, turn.id, { blobs: false })) {
      if (message.role !== 'assistant') continue;
      for (const part of message.parts) if (part.type === 'text') texts.push(part.text);
    }
    return texts.join('\n');
  }
}
