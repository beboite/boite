/*
 * The agents that stand as the companion, followed for its window
 * (`CompanionApp.svelte`): the agents snapshot, read again when the core says
 * it changed; the threads the agents work their conversations in, subscribed
 * so their answers stream into the bubbles; and each answer not seen yet,
 * whose directives (`directives.ts`) are carried out once: the facts go to the
 * agent's own memory, the reminders to this computer, the rest to the page.
 *
 * The companion keeps its role in each of its agents' instructions
 * (`withRole`), with Boite's projects, and the first time it makes an agent of
 * its own, Bots, which takes over the facts the companion kept on this
 * computer before it had agents.
 */
import type { AgentConversationMessage, AgentProfile, AgentsSnapshot } from '@boite/contracts';
import type { Client } from '../client';
import { fill, strings } from '../strings';
import { COMPANION_DOMAIN, permissionModeOf, pickBrain, ROLE_START, roleBlock, withoutRole, withRole } from './brain';
import { CLASSIC_SKIN, companionAgent, FIRST_AGENT_NAME, lastMessageAt, liveMemories, membersOf, memoriesToForget, memoryToKeep, profileWith, repliesAfter, sessionThreadOf } from './crew';
import { parseDirectives, type Directives } from './directives';
import { addReminder, clearMemory, readMemory } from './memory';
import { writeCompanionPrefs, type CompanionPrefs } from './prefs';

/** An answer older than this when first seen was written while the companion was away: only what lasts is carried out. */
const FRESH_MS = 2 * 60_000;
/** Per agent, when the newest answer already carried out was written. */
const MARKS_KEY = 'boite.companion.marks';
/** How soon the snapshot is read again after a change: sooner while an answer is awaited. */
const SOON_MS = 150;
const LATER_MS = 1200;
/** A first agent that could not be made is tried again after this long. */
const RETRY_MS = 60_000;

export interface CrewHost {
  client(): Client | null;
  prefs(): CompanionPrefs;
  /** The projects `[[task: …]]` may go to, by name; null until they are read. */
  projects(): string[] | null;
  /** A request waits for its answer: changes are read sooner. */
  waiting(): boolean;
  /** An answer not seen yet; `fresh` while the user may still be waiting for it. */
  answered(agentId: string, message: AgentConversationMessage, directives: Directives, fresh: boolean): void;
  /** The snapshot was read again. */
  loaded(): void;
}

const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function readMarks(): Record<string, number> {
  try {
    const raw = JSON.parse(window.localStorage.getItem(MARKS_KEY) ?? '{}') as Record<string, unknown>;
    return Object.fromEntries(Object.entries(raw).filter((entry): entry is [string, number] => typeof entry[1] === 'number'));
  } catch {
    return {};
  }
}

function writeMarks(marks: Record<string, number>): void {
  try {
    window.localStorage.setItem(MARKS_KEY, JSON.stringify(marks));
  } catch {
    /* a refused storage still runs for this session */
  }
}

/** The agent no longer stands as the companion: its instructions lose the role, and keep what the user wrote. */
export async function releaseAgent(client: Client, profile: AgentProfile): Promise<void> {
  const instructions = withoutRole(profile.instructions);
  if (instructions !== profile.instructions) await client.call('agents.profile.save', profileWith(profile, { instructions }));
}

export class Crew {
  snapshot = $state.raw<AgentsSnapshot | null>(null);
  /** Why the companion has no agent of its own yet: none could run, or making it failed. */
  problem = $state<string | null>(null);

  private loading = false;
  private again = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private marks = readMarks();
  private subscribed = new Set<string>();
  /** The revision each profile's role was written at: one save per revision, whatever the core answers. */
  private synced = new Map<string, number>();
  private making = false;
  private failedAt = 0;
  /** Memory saves, one after the other: two answers keeping the same fact keep it once. */
  private saving: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(private readonly host: CrewHost) {}

  /** The agents in the row, the leader first. */
  get members(): AgentProfile[] {
    return membersOf(this.snapshot, this.host.prefs().agents);
  }

  /** `agents.changed`: the snapshot is read again once the changes settle. */
  changed(): void {
    this.schedule(this.host.waiting() ? SOON_MS : LATER_MS);
  }

  private schedule(delay: number): void {
    if (this.timer !== undefined) {
      if (delay > SOON_MS) return;
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.load();
    }, delay);
  }

  async load(): Promise<void> {
    const client = this.host.client();
    if (!client || this.disposed) return;
    if (this.loading) {
      this.again = true;
      return;
    }
    this.loading = true;
    try {
      const snapshot = await client.call('agents.snapshot', {});
      if (this.disposed) return;
      this.snapshot = snapshot;
      this.take(client, snapshot);
      this.follow(client, snapshot);
      void this.keepRoles(client, snapshot);
      void this.makeFirst(client, snapshot);
    } catch {
      // An older core without agents, or a dropped connection: the next change reads it again.
    } finally {
      this.loading = false;
      if (this.again) {
        this.again = false;
        this.schedule(SOON_MS);
      }
    }
    if (!this.disposed) this.host.loaded();
  }

  /** After a reconnection: the core forgot the subscriptions. */
  resubscribe(): void {
    this.subscribed.clear();
    void this.load();
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.timer);
  }

  // -------------------------------------------------------------------------
  // Answers
  // -------------------------------------------------------------------------

  /**
   * The answers written since the last look, each carried out once. An agent
   * seen for the first time starts from its newest message: what it said
   * before it joined the row was not said to the companion.
   */
  private take(client: Client, snapshot: AgentsSnapshot): void {
    const now = Date.now();
    const marks: Record<string, number> = {};
    for (const member of membersOf(snapshot, this.host.prefs().agents)) {
      const mark = this.marks[member.id];
      marks[member.id] = mark ?? lastMessageAt(snapshot, member.id);
      if (mark === undefined) continue;
      for (const message of repliesAfter(snapshot, member.id, mark)) {
        marks[member.id] = message.createdAt;
        const directives = parseDirectives(message.text, new Date(message.createdAt));
        this.keep(client, member.id, directives);
        this.host.answered(member.id, message, directives, now - message.createdAt < FRESH_MS);
      }
    }
    if (JSON.stringify(marks) !== JSON.stringify(this.marks)) writeMarks(marks);
    this.marks = marks;
  }

  /** The reminders an answer asked for, and the facts it keeps or forgets in the agent's memory. */
  private keep(client: Client, agentId: string, { remind, remember, forget }: Directives): void {
    for (const reminder of remind) addReminder(reminder.text, reminder.at);
    if (remember.length === 0 && forget.length === 0) return;
    this.saving = this.saving.then(async () => {
      let memories = liveMemories(this.snapshot, agentId);
      for (const query of forget) {
        for (const save of memoriesToForget(memories, query)) {
          await client.call('agents.memory.save', save).catch(() => {});
          memories = memories.filter((memory) => memory.id !== save.id);
        }
      }
      for (const fact of remember) {
        const save = memoryToKeep(memories, agentId, fact);
        if (!save) continue;
        const kept = await client.call('agents.memory.save', save).catch(() => null);
        if (kept) memories = [...memories, kept];
      }
    });
  }

  // -------------------------------------------------------------------------
  // The agents' threads and instructions
  // -------------------------------------------------------------------------

  /** The threads the row's agents answer in, subscribed so their answers stream. */
  private follow(client: Client, snapshot: AgentsSnapshot): void {
    const wanted = new Set(membersOf(snapshot, this.host.prefs().agents).flatMap((member) => sessionThreadOf(snapshot, member.id) ?? []));
    for (const threadId of this.subscribed) {
      if (wanted.has(threadId)) continue;
      this.subscribed.delete(threadId);
      void client.call('threads.unsubscribe', { threadId }).catch(() => {});
    }
    for (const threadId of wanted) {
      if (this.subscribed.has(threadId)) continue;
      this.subscribed.add(threadId);
      void client.call('threads.subscribe', { threadId }).catch(() => this.subscribed.delete(threadId));
    }
  }

  /** The role, with the projects as they are now, in each agent of the row. A refused save waits for the next revision. */
  private async keepRoles(client: Client, snapshot: AgentsSnapshot): Promise<void> {
    const projects = this.host.projects();
    if (projects === null) return;
    const block = roleBlock(projects);
    for (const member of membersOf(snapshot, this.host.prefs().agents)) {
      const instructions = withRole(member.instructions, block);
      if (instructions === member.instructions || this.synced.get(member.id) === member.revision) continue;
      this.synced.set(member.id, member.revision);
      await client.call('agents.profile.save', profileWith(member, { instructions })).catch(() => {});
    }
  }

  // -------------------------------------------------------------------------
  // The first agent
  // -------------------------------------------------------------------------

  /**
   * Bots, the first time the companion runs with agents: on the agent the
   * brain settings pick, looking like the companion always did. An agent that
   * already holds the role, made before and forgotten by these preferences,
   * stands again instead.
   */
  private async makeFirst(client: Client, snapshot: AgentsSnapshot): Promise<void> {
    const prefs = this.host.prefs();
    const projects = this.host.projects();
    if (prefs.agents.length > 0 || prefs.crewMade || this.making || projects === null || Date.now() - this.failedAt < RETRY_MS) return;
    this.making = true;
    try {
      let id = snapshot.profiles.find((profile) => profile.status === 'active' && profile.instructions.includes(ROLE_START))?.id;
      if (!id) {
        const [providers, accounts] = await Promise.all([client.call('providers.list', {}), client.call('accounts.list', {})]);
        const brain = pickBrain(prefs, providers.loaded, accounts);
        if (!brain) {
          this.problem = prefs.providerId === null ? strings.companion.noBrain : strings.companion.brainOff;
          this.failedAt = Date.now();
          return;
        }
        const agent = companionAgent(FIRST_AGENT_NAME, COMPANION_DOMAIN, roleBlock(projects), CLASSIC_SKIN, brain, permissionModeOf(prefs.control));
        id = (await client.call('agents.profile.save', agent)).id;
        await this.carryMemory(client, id);
      }
      this.problem = null;
      writeCompanionPrefs({ agents: [id], crewMade: true });
      void this.load();
    } catch (error) {
      this.problem = fill(strings.companion.failed, { reason: reasonOf(error) });
      this.failedAt = Date.now();
    } finally {
      this.making = false;
    }
  }

  /** The facts the companion kept on this computer, moved to the agent's memory; kept here when one could not go. */
  private async carryMemory(client: Client, agentId: string): Promise<void> {
    const facts = readMemory();
    if (facts.length === 0) return;
    try {
      for (const fact of facts) {
        const save = memoryToKeep([], agentId, fact.text);
        if (save) await client.call('agents.memory.save', save);
      }
      clearMemory();
    } catch {
      /* the facts stay on this computer, in Settings, Companion */
    }
  }
}
