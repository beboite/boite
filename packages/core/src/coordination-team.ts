/**
 * Team letters on the coordination transport (`docs/teams.md`): a bot's
 * inbox letter that carries the seqs of team posts, joined while it waits,
 * rendered from the posts at delivery and left alone by the bot's own
 * coordination switch. `Coordination` owns the transport; this owns what
 * differs for teams.
 */
import { randomUUID } from 'node:crypto';
import type { AgentAddress, AgentContact, AgentLetter, Team } from '@boite/contracts';
import type { Core } from './core.ts';
import { letterPrompt, RESIDENT_LETTER_TTL_MS } from './coordination-letter.ts';
import { projectName, senderContext } from './coordination-relation.ts';
import type { TeamChannel } from './teams/prompt.ts';

/** What `Coordination` lends: its letter rows and the steps of its own delivery. */
export interface TeamLetterSide {
  rows(where: string, ...params: (string | number)[]): { data: string }[];
  update(letter: AgentLetter, status: AgentLetter['status'], error: string): void;
  /** Journals and stores an inbox letter of `threadId`. */
  receive(letter: AgentLetter, threadId: string): void;
  accept(letter: AgentLetter): void;
  kick(threadId: string): void;
  changed(threadId: string): void;
  handToWaiter(threadId: string): void;
  self(threadId: string): AgentAddress;
}

export class TeamLetters {
  readonly #core: Core;
  readonly #side: TeamLetterSide;

  constructor(core: Core, side: TeamLetterSide) {
    this.#core = core;
    this.#side = side;
  }

  /**
   * A team post for a bot (`teams/store.ts`): it joins the bot's waiting
   * letter of that team, whose expiry moves to six hours after it, or starts
   * one. A letter already handed over is never joined. Team letters never go
   * through `send` or `#receive`, and their text is rendered at delivery.
   */
  accept(team: Team, threadId: string, seq: number, owner: boolean): void {
    const now = Date.now();
    const waiting = this.#side.rows("thread_id = ? AND direction = 'in' AND status = 'received' AND json_extract(data, '$.team.teamId') = ?", threadId, team.id)[0];
    if (waiting) {
      const letter = JSON.parse(waiting.data) as AgentLetter;
      const joined: AgentLetter = { ...letter, expiresAt: now + RESIDENT_LETTER_TTL_MS, team: { teamId: team.id, triggers: [...letter.team!.triggers, seq], owner: letter.team!.owner || owner } };
      this.#core.journal.append({ type: 'coordination.team', threadId, version: 1, payload: { id: letter.id, seq, owner } }, () => {
        this.#core.journal.db.query("UPDATE coordination_letters SET data = json_set(?, '$.createdAt', created_at) WHERE id = ? AND status = 'received'").run(JSON.stringify(joined), letter.id);
      });
      this.#core.threads.runner.noteMail(threadId, now);
      this.#side.changed(threadId);
      this.#side.handToWaiter(threadId);
      this.#side.kick(threadId);
      return;
    }
    const thread = this.#core.threads.require(threadId);
    const machine = this.#core.info().hostname ?? 'Boite';
    const from: AgentContact = { ...this.#side.self(team.threadId), title: `Team ${team.name}`.slice(0, 200), machine, resources: '', status: 'idle', mode: 'brief' };
    this.#side.accept({
      id: randomUUID(), from, to: this.#side.self(threadId), toTitle: thread.title.slice(0, 200), toProject: projectName(this.#core, threadId), toMachine: machine,
      text: `Posts of the team ${team.name}`, replyTo: null, createdAt: now, expiresAt: now + RESIDENT_LETTER_TTL_MS, status: 'received', error: null,
      team: { teamId: team.id, triggers: [seq], owner },
    });
  }

  /** A team archived, or a bot that left it: its waiting team letters, a queued wake's too, go nowhere. */
  reject(teamId: string, threadId: string | null, reason: string): void {
    const stopped = new Set<string>();
    for (const row of this.#side.rows("direction = 'in' AND status IN ('received', 'uncertain') AND json_extract(data, '$.team.teamId') = ?", teamId)) {
      const letter = JSON.parse(row.data) as AgentLetter;
      if (threadId !== null && letter.to.threadId !== threadId) continue;
      if (letter.status === 'uncertain' && letter.error !== 'Queued for provider delivery') continue;
      if (letter.status === 'uncertain') stopped.add(letter.to.threadId);
      this.#side.update(letter, 'rejected', reason);
    }
    for (const target of stopped) this.#core.threads.stopQueuedCoordination(target);
  }

  /** Delivery to one thread now, not at the next sweep: a resumed team's letters. */
  kick(threadId: string): void { this.#side.kick(threadId); }

  /** Whether the queued wake of a thread carries team letters only, which its own pause leaves to the team. */
  onlyQueued(threadId: string): boolean {
    const queued = this.#side.rows("thread_id = ? AND direction = 'in' AND status = 'uncertain'", threadId).map(row => JSON.parse(row.data) as AgentLetter)
      .filter(letter => letter.error === 'Queued for provider delivery');
    return queued.length > 0 && queued.every(letter => letter.team);
  }

  /**
   * A batch's prompt: ordinary letters as they always were, team letters
   * rendered from their posts (`teams/store.ts`). A team letter whose
   * triggers did not all fit keeps those that did; the rest wait in a new
   * letter. Only a batch of team letters alone can name a reply channel.
   */
  render(threadId: string, batch: AgentLetter[], mode: 'seen' | 'flight', reply = false): { prompt: string; texts: Map<string, string>; channel: TeamChannel | null } {
    const plain = batch.filter(letter => !letter.team);
    const team = batch.filter(letter => letter.team);
    const rendering = this.#core.teams.render(threadId, team, mode, reply && plain.length === 0);
    for (const { letter, seqs, owner } of rendering.leftovers) {
      const now = Date.now();
      this.#side.receive({ ...letter, id: randomUUID(), createdAt: now, expiresAt: now + RESIDENT_LETTER_TTL_MS, status: 'received', error: null, team: { teamId: letter.team!.teamId, triggers: seqs, owner } }, threadId);
      this.#side.kick(threadId);
    }
    const parts = plain.length ? [letterPrompt(plain, senderContext(this.#core, this.#side.self('').coreId, threadId))] : [];
    for (const letter of team) parts.push(rendering.texts.get(letter.id)!);
    return { prompt: parts.join('\n\n'), texts: rendering.texts, channel: rendering.channel };
  }
}
