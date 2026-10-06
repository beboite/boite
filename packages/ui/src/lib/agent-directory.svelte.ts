import type { AgentEntrustment, AgentProfile, AgentsSnapshot, ThreadSummary } from '@boite/contracts';
import { experimentOn } from './experiments.svelte';
import type { Store } from './store.svelte';

/** Threads an agent is busy in: a turn running, queued, or waiting on the user. */
const LIVE: ReadonlySet<ThreadSummary['status']> = new Set(['running', 'queued', 'waiting']);
/** The least time between two snapshots the thread list asks for: agents change many records per turn. */
const SETTLE_MS = 1500;

export interface AgentAtWork {
  agent: Pick<AgentProfile, 'id' | 'name' | 'avatar'>;
  /** Its thread, with the status the row reads: waiting when the user has something to answer. */
  thread: ThreadSummary;
  waiting: boolean;
}

/**
 * Which persistent agent owns or carries a thread, for the views outside the
 * Agents page: the thread list draws that agent's picture on its rows and lists
 * the agents in charge, the chat says whose thread it is, and the thread menu
 * lists the agents a thread can be entrusted to. A thread names its agent
 * session (`agentSessionId`), a delegated child its parent; the session names
 * the agent. An entrusted thread is named in the snapshot's `entrusted`. Only
 * with the Agents experiment on, the agents snapshot loads, at most once per
 * `SETTLE_MS`.
 */
export class AgentDirectory {
  snapshot = $state.raw<AgentsSnapshot | null>(null);
  private client: Store['client'] = null;
  private off: (() => void) | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private loading = false;
  private again = false;
  private users = 0;

  constructor(private readonly store: Store) {}

  /**
   * Whether the directory is worth loading: with the Agents experiment on, a
   * thread can be entrusted to an agent and the thread menu lists them.
   */
  get needed(): boolean {
    return experimentOn('resident-agents');
  }

  /** Keeps the directory current while the caller is mounted. Returns the release. */
  watch(): () => void {
    this.users++;
    this.attach();
    return () => {
      this.users--;
      if (this.users === 0) this.detach();
    };
  }

  private attach(): void {
    if (this.client === this.store.client && this.off) return;
    this.off?.();
    this.client = this.store.client;
    this.snapshot = null;
    this.off = this.client?.on('agents.changed', () => this.schedule()) ?? null;
    void this.load();
  }

  private detach(): void {
    this.off?.();
    this.off = null;
    this.client = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Follows a reconnection: a new client is a new subscription and a fresh snapshot. */
  refresh(): void {
    if (this.users > 0) this.attach();
  }

  /** Reads the snapshot again now, after a change this client made. */
  reload(): void {
    if (this.users > 0) void this.load();
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; void this.load(); }, SETTLE_MS);
  }

  private async load(): Promise<void> {
    if (this.loading) { this.again = true; return; }
    const client = this.client;
    if (!client) return;
    this.loading = true;
    try {
      const snapshot = await client.call('agents.snapshot', {});
      if (client === this.client) this.snapshot = snapshot;
    } catch {
      // An older core without agents, or a dropped connection: the rows keep their provider logo.
    } finally {
      this.loading = false;
      if (this.again) { this.again = false; this.schedule(); }
    }
  }

  /** The agents a thread can be entrusted to: every active one. */
  get agents(): AgentProfile[] {
    return this.snapshot?.profiles.filter(a => a.status === 'active') ?? [];
  }

  /** The agent a thread was entrusted to, and the entrustment. */
  entrustmentOf(threadId: string): { entrustment: AgentEntrustment; agent: AgentProfile } | null {
    const entrustment = this.snapshot?.entrusted?.find(e => e.threadId === threadId);
    const agent = entrustment ? this.snapshot?.profiles.find(a => a.id === entrustment.agentId) : undefined;
    return entrustment && agent ? { entrustment, agent } : null;
  }

  /** Every entrusted thread of this machine with its agent, newest first. */
  get entrusted(): { agent: AgentProfile; thread: ThreadSummary }[] {
    return [...(this.snapshot?.entrusted ?? [])].sort((a, b) => b.at - a.at).flatMap(e => {
      const agent = this.snapshot?.profiles.find(a => a.id === e.agentId);
      const thread = this.store.threads.find(t => t.id === e.threadId && !t.archived);
      return agent && thread ? [{ agent, thread }] : [];
    });
  }

  /** The agent a thread belongs to, through its session or its parent's. */
  ownerOf(thread: Pick<ThreadSummary, 'agentSessionId' | 'parentThreadId'>): AgentProfile | null {
    const snapshot = this.snapshot;
    if (!snapshot) return null;
    const sessionId = thread.agentSessionId ?? (thread.parentThreadId ? this.store.threads.find(t => t.id === thread.parentThreadId)?.agentSessionId : undefined);
    if (!sessionId) return null;
    const agentId = snapshot.sessions.find(s => s.id === sessionId)?.agentId;
    return agentId ? snapshot.profiles.find(a => a.id === agentId) ?? null : null;
  }

  /**
   * Every agent busy on this machine: a turn under way in its thread, or work
   * that waits on the user (a decision it asked for) even after its turn
   * ended. The one waiting on the user comes first, then the longest running.
   * `waiting` says the user has something to answer.
   */
  get atWork(): AgentAtWork[] {
    const snapshot = this.snapshot;
    if (!snapshot) return [];
    const byThread = new Map<string, AgentAtWork>();
    for (const thread of this.store.threads) {
      if (!thread.agentSessionId || !LIVE.has(thread.status) || thread.archived) continue;
      const agent = this.ownerOf(thread);
      if (agent) byThread.set(thread.id, { agent, thread, waiting: thread.status === 'waiting' });
    }
    for (const work of snapshot.work) {
      if (work.status !== 'waiting' && work.status !== 'running') continue;
      const run = work.runId ? snapshot.runs.find(r => r.id === work.runId) : undefined;
      const thread = run ? this.store.threads.find(t => t.id === run.threadId) : undefined;
      const agent = snapshot.profiles.find(a => a.id === work.agentId);
      if (!thread || !agent || thread.archived) continue;
      const held = byThread.get(thread.id);
      if (work.status === 'waiting') byThread.set(thread.id, { agent, thread: { ...thread, status: 'waiting' }, waiting: true });
      else if (!held) byThread.set(thread.id, { agent, thread: { ...thread, status: 'running', runningSince: thread.runningSince ?? run?.startedAt ?? null }, waiting: false });
    }
    return [...byThread.values()].sort((a, b) => Number(b.waiting) - Number(a.waiting) || (a.thread.runningSince ?? 0) - (b.thread.runningSince ?? 0));
  }
}

const directories = new WeakMap<Store, AgentDirectory>();

/** The one directory of a machine's Store. */
export function agentDirectory(store: Store): AgentDirectory {
  let directory = directories.get(store);
  if (!directory) { directory = new AgentDirectory(store); directories.set(store, directory); }
  return directory;
}
