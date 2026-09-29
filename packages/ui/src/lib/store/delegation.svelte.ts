import type {
  AgentContact,
  CoordinationConfig,
  CoordinationPeer,
  CoordinationView,
  DelegatedAgent,
  DelegationConfig,
  DelegationView,
  Thread,
  ThreadId
} from '@boite/contracts';
import type { Client } from '../client';
import { strings } from '../strings';
import { mergeResumed, resumeRequest } from '../thread-rows';
import type { StoreContext } from './context';

/** The open thread's native coordination with other agents, and its bounded child team. */
export class Delegation {
  /** Native agent-to-agent traffic for the open thread. It is separate from chat messages. */
  coordination = $state<CoordinationView | null>(null);
  coordinationDirectory = $state<{ agents: AgentContact[]; unavailable: string[] } | null>(null);
  coordinationLoading = $state(false);
  coordinationSaving = $state(false);
  coordinationEpoch = 0;
  coordinationError = $state<string | null>(null);
  /** The bounded child team of the open root or child thread. */
  delegation = $state<DelegationView | null>(null);
  delegationThread = $state<Thread | null>(null);
  delegationSelectedAgentId = $state<ThreadId | null>(null);
  delegationLoading = $state(false);
  delegationSaving = $state(false);
  delegationError = $state<string | null>(null);
  delegationEpoch = 0;
  delegationSelectionEpoch = 0;
  delegationConfigureEpoch = 0;
  /** The one child transcript shown in Agents, beside the normal open-thread subscription. */
  delegationSubscribedThreadId: ThreadId | null = null;

  constructor(private readonly ctx: StoreContext) {}

  async loadCoordination(threadId = this.ctx.store.openThread?.id, withDirectory = true): Promise<void> {
    const s = this.ctx.store;
    const client = this.ctx.client;
    if (!client || !threadId) return;
    const epoch = ++this.coordinationEpoch;
    const current = () => this.ctx.client === client && s.openThread?.id === threadId && this.coordinationEpoch === epoch;
    if (this.coordination?.self.threadId !== threadId) { this.coordination = null; this.coordinationDirectory = null; }
    this.coordinationLoading = true;
    this.coordinationError = null;
    try {
      const view = await client.call('collaboration.get', { threadId });
      if (!current()) return;
      this.coordination = view;
      if (withDirectory) {
        const directory = await client.call('collaboration.directory', { threadId });
        if (current()) this.coordinationDirectory = directory;
      }
    } catch (error) {
      if (current()) this.coordinationError = error instanceof Error ? error.message : String(error);
    } finally {
      if (current()) this.coordinationLoading = false;
    }
  }

  async configureCoordination(config: CoordinationConfig): Promise<void> {
    const s = this.ctx.store;
    const client = this.ctx.client;
    const threadId = s.openThread?.id;
    if (!client || !threadId || !s.owner || this.coordinationSaving) return;
    this.coordinationSaving = true;
    this.coordinationError = null;
    try {
      await client.call('collaboration.configure', { threadId, config });
      if (this.ctx.client === client && s.openThread?.id === threadId) await s.loadCoordination(threadId);
    } catch (error) {
      if (this.ctx.client === client && s.openThread?.id === threadId) this.coordinationError = error instanceof Error ? error.message : String(error);
    } finally {
      if (this.ctx.client === client) this.coordinationSaving = false;
    }
  }

  async loadDelegation(threadId = this.ctx.store.openThread?.id): Promise<void> {
    const s = this.ctx.store;
    const client = this.ctx.client;
    if (!client || !threadId) return;
    const epoch = ++this.delegationEpoch;
    const current = () => this.ctx.client === client && s.openThread?.id === threadId && this.delegationEpoch === epoch;
    this.delegationLoading = true;
    this.delegationError = null;
    try {
      const view = await client.call('delegation.get', { threadId });
      if (!current()) return;
      this.delegation = view;
      const selected = this.delegationSelectedAgentId;
      // A workflow step is shown the same way but is not a member of the team.
      if (selected && !view.agents.some(agent => agent.thread.id === selected) && !s.isWorkflowStep(selected)) {
        await s.selectDelegatedAgent(null);
      } else if (selected && this.delegationThread?.id === selected) {
        const summary = view.agents.find(agent => agent.thread.id === selected)?.thread;
        if (summary) Object.assign(this.delegationThread, summary);
      }
    } catch (error) {
      if (current()) this.delegationError = this.ctx.reason(error);
    } finally {
      if (current()) this.delegationLoading = false;
    }
  }

  #delegationRootId(): ThreadId | null {
    const thread = this.ctx.store.openThread;
    if (!thread) return null;
    const root = thread.parentThreadId ?? thread.id;
    if (this.delegation) return this.delegation.rootThreadId === root ? root : null;
    return thread.parentThreadId ? null : root;
  }

  async configureDelegation(config: DelegationConfig): Promise<void> {
    const s = this.ctx.store;
    const client = this.ctx.client;
    const openThreadId = s.openThread?.id;
    const threadId = this.#delegationRootId();
    if (!client || !threadId || !s.owner || this.delegationSaving) return;
    const epoch = ++this.delegationConfigureEpoch;
    this.delegationSaving = true;
    this.delegationError = null;
    try {
      const view = await client.call('delegation.configure', { threadId, config });
      if (client === this.ctx.client && s.openThread?.id === openThreadId && epoch === this.delegationConfigureEpoch) {
        if (openThreadId === threadId) this.delegation = view;
        else await s.loadDelegation(openThreadId);
      }
    } catch (error) {
      if (client === this.ctx.client && s.openThread?.id === openThreadId && epoch === this.delegationConfigureEpoch) this.delegationError = this.ctx.reason(error);
    } finally {
      if (client === this.ctx.client && epoch === this.delegationConfigureEpoch) this.delegationSaving = false;
    }
  }

  /** One child transcript in the panel, while the parent conversation keeps streaming. */
  async selectDelegatedAgent(threadId: ThreadId | null): Promise<void> {
    const threads = this.ctx.threads;
    const client = this.ctx.client;
    if (!client) return;
    const epoch = ++this.delegationSelectionEpoch;
    const previous = this.delegationSubscribedThreadId;
    this.delegationSelectedAgentId = threadId;
    this.delegationThread = null;
    this.delegationSubscribedThreadId = null;
    if (previous && previous !== threads.subscribedThreadId && previous !== threadId) {
      await client.call('threads.unsubscribe', { threadId: previous }).catch(() => undefined);
    }
    if (threadId === null) return;
    try {
      if (threadId !== threads.subscribedThreadId) {
        await client.call('threads.subscribe', { threadId });
        if (epoch !== this.delegationSelectionEpoch || client !== this.ctx.client) {
          if (this.delegationSelectedAgentId !== threadId && threads.subscribedThreadId !== threadId) {
            await client.call('threads.unsubscribe', { threadId }).catch(() => undefined);
          }
          return;
        }
      }
      if (epoch === this.delegationSelectionEpoch && client === this.ctx.client) this.delegationSubscribedThreadId = threadId;
      const thread = await client.call('threads.get', { threadId });
      if (epoch === this.delegationSelectionEpoch && client === this.ctx.client && this.delegationSelectedAgentId === threadId) {
        this.delegationThread = thread;
      }
    } catch (error) {
      if (epoch === this.delegationSelectionEpoch && client === this.ctx.client) this.delegationError = this.ctx.reason(error);
    }
  }

  async spawnDelegatedAgent(profileId: string, task: string, title?: string): Promise<DelegatedAgent | null> {
    const s = this.ctx.store;
    const client = this.ctx.client;
    const openThreadId = s.openThread?.id;
    const threadId = this.#delegationRootId();
    if (!client || !threadId || !s.owner || !task.trim()) return null;
    this.delegationError = null;
    try {
      const agent = await client.call('delegation.spawn', {
        threadId,
        profileId,
        task: task.trim(),
        ...(title?.trim() ? { title: title.trim() } : {}),
        requestId: crypto.randomUUID()
      });
      if (client !== this.ctx.client || s.openThread?.id !== openThreadId) return null;
      await s.loadDelegation(openThreadId);
      return agent;
    } catch (error) {
      if (client === this.ctx.client && s.openThread?.id === openThreadId) this.delegationError = this.ctx.reason(error);
      return null;
    }
  }

  async messageDelegatedAgent(toThreadId: ThreadId, text: string): Promise<boolean> {
    const s = this.ctx.store;
    const client = this.ctx.client;
    const threadId = this.#delegationRootId();
    if (!client || !threadId || !text.trim()) return false;
    this.delegationError = null;
    try {
      await client.call('delegation.send', { threadId, toThreadId, text: text.trim(), requestId: crypto.randomUUID() });
      if (client !== this.ctx.client || this.delegation?.rootThreadId !== threadId) return false;
      await s.loadDelegation(s.openThread?.id);
      return true;
    } catch (error) {
      if (client === this.ctx.client && this.delegation?.rootThreadId === threadId) this.delegationError = this.ctx.reason(error);
      return false;
    }
  }

  async stopDelegatedAgent(agentId?: ThreadId): Promise<void> {
    const s = this.ctx.store;
    const client = this.ctx.client;
    const threadId = this.#delegationRootId();
    if (!client || !threadId) return;
    this.delegationError = null;
    try {
      await client.call('delegation.stop', { threadId, ...(agentId ? { agentId } : {}) });
      if (client === this.ctx.client && this.delegation?.rootThreadId === threadId) await s.loadDelegation(s.openThread?.id);
    } catch (error) {
      if (client === this.ctx.client && this.delegation?.rootThreadId === threadId) this.delegationError = this.ctx.reason(error);
    }
  }

  async coordinationIdentity(): Promise<CoordinationPeer> {
    if (!this.ctx.client) throw new Error(strings.connection.unavailable);
    return this.ctx.client.call('collaboration.identity', {});
  }

  async coordinationPeers(): Promise<CoordinationPeer[]> {
    if (!this.ctx.client) throw new Error(strings.connection.unavailable);
    return this.ctx.client.call('collaboration.peers', {});
  }

  async checkCoordinationPeer(coreId: string): Promise<void> {
    if (!this.ctx.client) throw new Error(strings.connection.unavailable);
    await this.ctx.client.call('collaboration.check', { coreId });
  }

  async trustCoordinationPeer(peer: CoordinationPeer): Promise<CoordinationPeer> {
    if (!this.ctx.client) throw new Error(strings.connection.unavailable);
    return this.ctx.client.call('collaboration.trust', { peer });
  }

  async untrustCoordinationPeer(coreId: string): Promise<void> {
    if (!this.ctx.client) throw new Error(strings.connection.unavailable);
    await this.ctx.client.call('collaboration.untrust', { coreId });
  }

  /** The agent transcript on screen caught up in place, not blanked and fetched whole as a new selection is. */
  async refreshDelegated(client: Client): Promise<void> {
    const held = this.delegationThread;
    const threadId = this.delegationSelectedAgentId;
    if (!held || held.id !== threadId) return;
    const epoch = this.delegationSelectionEpoch;
    const current = () => epoch === this.delegationSelectionEpoch && client === this.ctx.client && this.delegationThread === held;
    try {
      const thread = await client.call('threads.get', resumeRequest(threadId, held));
      if (!current()) return;
      mergeResumed(held, thread);
      this.delegationThread = thread;
    } catch (error) {
      if (current()) this.delegationError = this.ctx.reason(error);
    }
  }
}
