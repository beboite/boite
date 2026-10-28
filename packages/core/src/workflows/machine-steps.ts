/**
 * Workflow steps that name `machine`: each runs as a subagent of the run's
 * conversation on that machine of the group, through the remote delegation
 * module, and settles from that machine's reports as a local step settles from
 * its turn. No polling or extra runner: a listener on the reports.
 */
import { WORKFLOW_LIMITS, extractJson, shapeMismatch, type Turn, type WorkflowInstance, type WorkflowNode, type WorkflowRun, type WorkflowStepPlan } from '@boite/contracts';
import type { Core } from '../core.ts';
import { messageOf } from '../errors.ts';
import { fingerprint } from '../contacts/project-journal.ts';
import { memberNamed } from '../threads/group-spawn.ts';
import { INTERRUPTION_TEXT } from '../delegation/interruption.ts';
import { stepPrompt } from './prompt.ts';

interface Hooks {
  load: (id: string) => WorkflowRun | null;
  save: (run: WorkflowRun) => void;
  advance: (id: string) => void;
  runs: () => WorkflowRun[];
  /** The runs of a conversation with a step on another machine, ended ones included. */
  rooted: (rootId: string) => WorkflowRun[];
}

const INTERRUPTED = 'Interrupted by a core restart';
/** As much of an answer as a local step's JSON is read from. */
const ANSWER_CHARS = 64_000;

const find = (run: WorkflowRun | null, key: string) => run?.nodes.flatMap(n => n.instances).find(i => i.key === key);

export class MachineWorkflowSteps {
  readonly #off: () => void;
  #closed = false;
  readonly #pending = new Set<Promise<unknown>>();
  /** `run:key:turn` being read now, so a report arriving meanwhile does not judge the same turn twice. */
  readonly #judging = new Set<string>();
  /** Correction request ids out now, so a report arriving meanwhile does not send one twice at once. */
  readonly #sending = new Set<string>();

  readonly #core: Core;
  readonly #hooks: Hooks;

  constructor(core: Core, hooks: Hooks) {
    this.#core = core;
    this.#hooks = hooks;
    this.#off = core.delegation.remote.watch(rootId => {
      if (this.#closed) return;
      for (const run of hooks.rooted(rootId)) {
        this.#reconcile(run);
        if (run.status === 'running' || run.status === 'paused') for (const node of run.nodes) for (const inst of node.instances) if (inst.machine && inst.status === 'running') this.#receive(run.id, inst.key);
      }
    });
  }

  /** A worktree settled there after its step ended is shown as it is. */
  #reconcile(snapshot: WorkflowRun): void {
    const run = this.#hooks.load(snapshot.id);
    if (!run) return;
    let changed = false;
    for (const node of run.nodes) for (const inst of node.instances) {
      const worktree = inst.machine && this.#core.delegation.remote.record(run.rootThreadId, inst.machine.requestId)?.state?.worktree;
      if (worktree && JSON.stringify(worktree) !== JSON.stringify(inst.worktree)) inst.worktree = worktree, changed = true;
    }
    if (changed) this.#hooks.save(run);
  }

  /** A step with `machine` names a member of the group, refused with `delegate spawn --machine`'s words. */
  check(step: WorkflowStepPlan, field: string): boolean {
    if (step.machine === undefined) return false;
    memberNamed(this.#core, step.machine, field);
    return true;
  }

  launch(run: WorkflowRun, node: WorkflowNode, inst: WorkflowInstance): boolean {
    const step = run.plan.steps.find(s => s.id === node.id)!;
    if (step.machine === undefined) return false;
    const old = inst.machine;
    // Cut by a restart here: the same request id answers the subagent already at work there.
    const recovery = !!old && inst.error === INTERRUPTED;
    const attempts = recovery ? inst.attempts : inst.attempts + 1;
    const requestId = recovery ? old.requestId : `wf-${fingerprint([run.id, inst.key, attempts])}`;
    if (old && !recovery) this.#halt(run.rootThreadId, old.requestId);
    Object.assign(inst, {
      status: 'running', attempts, error: null, result: null, output: null, startedAt: inst.startedAt ?? Date.now(), finishedAt: null,
      machine: recovery ? old : { name: step.machine, coreId: null, requestId, childId: null, turnId: null, corrections: 0 },
    });
    this.#hooks.save(run);
    const task = (async () => {
      const brief = stepPrompt(this.#core, run, node, inst, true);
      if (brief.length > WORKFLOW_LIMITS.taskChars) throw new Error(`the brief for ${step.machine} is ${brief.length} characters with the step's instructions; the limit is ${WORKFLOW_LIMITS.taskChars}. Pass a field rather than a whole output`);
      const agent = await this.#core.delegation.remote.spawn({
        threadId: run.rootThreadId, requestId, task: brief, title: `${run.name} · ${node.title}${inst.label ? ` · ${inst.label}` : ''}`.slice(0, 120), machine: step.machine!,
        ...(step.project === undefined ? {} : { project: step.project }), ...(step.profile === undefined ? {} : { profileId: step.profile }),
        ...(step.model === undefined ? {} : { model: step.model }), ...(step.effort === undefined ? {} : { effort: step.effort }),
        ...(step.context === undefined ? {} : { context: step.context }), ...(step.worktree ? { worktree: true } : {}),
      }, true);
      if (this.#closed) return;
      const current = this.#hooks.load(run.id), found = find(current, inst.key);
      // Stopped, or launched again, while the request was out: the subagent there stops too.
      if (!current || !found?.machine || found.machine.requestId !== requestId || found.status !== 'running' || current.status === 'stopped') {
        this.#halt(run.rootThreadId, requestId);
        return;
      }
      found.machine = { ...found.machine, name: agent.machine?.name ?? found.machine.name, coreId: agent.machine?.coreId ?? null, childId: agent.thread.id };
      this.#hooks.save(current);
      this.#receive(run.id, inst.key);
    })().catch(error => this.#fail(run.id, inst.key, requestId, messageOf(error)));
    this.#track(task);
    return true;
  }

  #track(work: Promise<unknown>): void {
    this.#pending.add(work);
    void work.finally(() => this.#pending.delete(work));
  }

  /** Stops that subagent there, at once or, when no answer or report named it yet, as soon as one does, a restart here included. */
  #halt(rootId: string, requestId: string): void {
    try { this.#core.delegation.remote.stopRequest(rootId, requestId); } catch (error) { this.#core.log('warn', `workflow step on another machine ${requestId}: ${messageOf(error)}`); }
  }

  #fail(runId: string, key: string, requestId: string, error: string): void {
    if (this.#closed) return;
    const run = this.#hooks.load(runId), inst = find(run, key);
    if (!run || !inst || inst.status !== 'running' || inst.machine?.requestId !== requestId) return;
    // Its start answer was lost: a subagent started there anyway does not work on for a failed step.
    if (inst.machine.childId === null) this.#halt(run.rootThreadId, requestId);
    Object.assign(inst, { status: 'failed', error: error.slice(0, 500), finishedAt: Date.now() });
    this.#hooks.save(run);
    this.#hooks.advance(runId);
  }

  #running(run: WorkflowRun | null, key: string): boolean {
    return !this.#closed && !!run && (run.status === 'running' || run.status === 'paused') && find(run, key)?.status === 'running';
  }

  /** The subagent's last report: a turn it ended and that was not judged yet settles the step. */
  #receive(runId: string, key: string): void {
    const run = this.#hooks.load(runId);
    if (!this.#running(run, key)) return;
    const inst = find(run, key)!, machine = inst.machine!;
    const record = this.#core.delegation.remote.record(run!.rootThreadId, machine.requestId);
    if (!record) {
      // Its record goes only once that machine says the subagent was deleted there.
      if (machine.childId !== null) this.#fail(runId, key, machine.requestId, `the subagent on ${machine.name} was deleted there`);
      return;
    }
    const state = record.state;
    if (state === null || record.childId === null) return;
    const turn = state.lastTurn;
    const seen = { providerId: state.thread.providerId, model: state.thread.model, effort: state.thread.effort, ...(state.worktree ? { worktree: state.worktree } : {}) };
    const fresh = machine.childId !== record.childId || inst.providerId !== seen.providerId || inst.model !== seen.model || inst.effort !== seen.effort || JSON.stringify(inst.worktree) !== JSON.stringify(state.worktree ?? inst.worktree);
    Object.assign(inst, seen, { machine: { ...machine, childId: record.childId, coreId: record.coreId } });
    if (fresh) this.#hooks.save(run!);
    // A correction decided before it was taken there: it goes again under its request id, and its turn settles the step.
    if (machine.correction) {
      this.#correct(run!, key, machine.requestId, record.childId, machine.correction);
      return;
    }
    // At work, or ended to wait on its own background work, or cut by a restart there that resumes it, or already judged.
    if (turn === null || ['queued', 'running'].includes(turn.status) || state.thread.backgroundWait?.state === 'waiting' || state.restarting || turn.id === machine.turnId) return;
    if (record.interruption?.turnId === turn.id) {
      this.#fail(runId, key, machine.requestId, record.interruption.error);
      return;
    }
    const wait = state.thread.backgroundWait;
    if (wait?.state === 'interrupted') {
      this.#fail(runId, key, machine.requestId, `Its last message was a checkpoint, not its final result: ${wait.for} ${INTERRUPTION_TEXT[wait.reason]}`);
      return;
    }
    // A worktree of its own is settled there after the turn: the step ends once it is kept or removed, so the summary names what to merge.
    if (state.worktree?.state === 'active' && !state.worktree.error) return;
    const mark = `${runId}:${key}:${turn.id}`;
    if (this.#judging.has(mark)) return;
    this.#judging.add(mark);
    const step = run!.plan.steps.find(s => s.id === key.split('#')[0])!;
    const work = (async () => {
      const answer = turn.status === 'done' ? await this.#answer(run!.rootThreadId, record.childId!, turn.id, state.result) : '';
      this.#judge(runId, key, machine.requestId, turn, answer, step);
    })().catch(error => this.#fail(runId, key, machine.requestId, messageOf(error))).finally(() => this.#judging.delete(mark));
    this.#track(work);
  }

  /** The whole answer, read from that machine when JSON may run past the bounded result it reported. */
  async #answer(rootId: string, childId: string, turnId: string, reported: string | null): Promise<string> {
    let text = '', offset = 0;
    try {
      // Offsets count code points there; the text counts UTF-16 units here, so only the page says where the next begins.
      while (text.length < ANSWER_CHARS) {
        const page = await this.#core.delegation.remote.read({ threadId: rootId, agentId: childId, turnId, offset, limit: 16_000 });
        text += page.text;
        if (page.nextOffset === null) break;
        if (typeof page.nextOffset !== 'number' || !Number.isInteger(page.nextOffset) || page.nextOffset <= offset || !page.text) throw new Error(`a page at ${offset} did not move on (next ${String(page.nextOffset)})`);
        offset = page.nextOffset;
      }
    } catch (error) {
      this.#core.log('warn', `workflow step ${childId}: its whole answer could not be read, the reported one is used: ${messageOf(error)}`);
      return reported ?? '';
    }
    return text.slice(0, ANSWER_CHARS);
  }

  #judge(runId: string, key: string, requestId: string, turn: Pick<Turn, 'id' | 'status' | 'error'>, answer: string, step: WorkflowStepPlan): void {
    const run = this.#hooks.load(runId), inst = find(run, key);
    if (!this.#running(run, key) || inst!.machine?.requestId !== requestId || inst!.machine.turnId === turn.id) return;
    const machine = inst!.machine;
    machine.turnId = turn.id;
    const now = Date.now();
    if (turn.status === 'done') {
      inst!.result = answer ? (answer.length > WORKFLOW_LIMITS.resultChars ? `${answer.slice(0, WORKFLOW_LIMITS.resultChars - 40)}\n[Truncated; the step's conversation has the rest.]` : answer) : null;
      if (step.output !== undefined) {
        const parsed = extractJson(answer);
        const size = parsed ? JSON.stringify(parsed.value).length : 0;
        const mismatch = parsed ? shapeMismatch(parsed.value, step.output) ?? (size > WORKFLOW_LIMITS.outputChars ? `the output is ${size} characters as JSON; the limit is ${WORKFLOW_LIMITS.outputChars}` : null) : 'the answer has no ```json block';
        if (!mismatch) inst!.output = parsed!.value;
        else if (machine.corrections < WORKFLOW_LIMITS.attempts - 1) {
          // Saved before it is sent: a restart in between sends it again under the same request id.
          machine.corrections += 1;
          machine.correction = { requestId: `${requestId}:output-${machine.corrections}`, text: `Your result does not match this workflow step's output shape: ${mismatch}. Reply with only one \`\`\`json block matching ${JSON.stringify(step.output)}.` };
          this.#hooks.save(run!);
          this.#correct(run!, key, requestId, machine.childId!, machine.correction);
          return;
        } else Object.assign(inst!, { status: 'failed', error: `output: ${mismatch}`, finishedAt: now });
      }
      if (inst!.status === 'running') Object.assign(inst!, { status: 'done', finishedAt: now });
    } else if (turn.status === 'stopped') Object.assign(inst!, { status: 'stopped', error: 'Stopped', finishedAt: now });
    else Object.assign(inst!, { status: 'failed', error: turn.error ?? 'The turn failed', finishedAt: now });
    this.#hooks.save(run!);
    this.#hooks.advance(runId);
  }

  /** One more turn of the same subagent there, as a local step gets on a mismatch. Taken there, it is no longer pending here. */
  #correct(run: WorkflowRun, key: string, requestId: string, childId: string, correction: { requestId: string; text: string }): void {
    if (this.#sending.has(correction.requestId)) return;
    this.#sending.add(correction.requestId);
    const work = this.#core.delegation.remote.send({ threadId: run.rootThreadId, toThreadId: childId, requestId: correction.requestId, text: correction.text }, 'agent', true)
      .then(() => {
        if (this.#closed) return;
        const current = this.#hooks.load(run.id), inst = find(current, key);
        if (!current || inst?.machine?.requestId !== requestId || inst.machine.correction?.requestId !== correction.requestId) return;
        delete inst.machine.correction;
        this.#hooks.save(current);
        // Its turn may have ended there before this answer: the last report judges it now.
        this.#receive(run.id, key);
      })
      .catch(error => this.#fail(run.id, key, requestId, `output retry: ${messageOf(error)}`))
      .finally(() => this.#sending.delete(correction.requestId));
    this.#track(work);
  }

  /** The subagents of a stopped run stop there, once that machine takes the stop; one whose start answer has not come yet, once its answer or a report names it. */
  stop(run: WorkflowRun): void {
    for (const node of run.nodes) for (const inst of node.instances) if ((inst.status === 'running' || inst.status === 'waiting') && inst.machine) this.#halt(run.rootThreadId, inst.machine.requestId);
  }

  beginClose(): void { this.#closed = true; this.#off(); }
  async close(): Promise<void> { this.beginClose(); await Promise.allSettled([...this.#pending]); }
}
