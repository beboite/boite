import type { GitDiff, GitStatus, Project, Thread, ThreadSummary } from '@boite/contracts';
import type { Client } from './client';
import type { Choice, Store } from './store.svelte';
import { strings } from './strings';
const text = strings.proposalComparison;

export interface Proposal {
  id: 'a' | 'b';
  choice: Choice;
  thread: ThreadSummary | null;
  snapshot: Thread | null;
  phase: 'starting' | 'started' | 'failed';
  error: string | null;
  readError: string | null;
  changes: GitStatus | null;
  changesError: string | null;
  selectedPath: string | null;
  diff: GitDiff | null;
  diffError: string | null;
  loadingDiff: boolean;
}

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const comparisons = new WeakMap<Store, Map<string, ProposalComparison>>();
const comparisonKey = (store: Store, projectId: string) => JSON.stringify([store.machineId, projectId]);

/** Retain a pair across header unmounts without carrying it to another Store. */
export function savedComparison(store: Store, projectId: string): ProposalComparison | null {
  const saved = comparisons.get(store)?.get(comparisonKey(store, projectId));
  return saved?.sameMachine ? saved : null;
}

/** One launch per comparison. Reads never change the chat's thread subscription. */
export class ProposalComparison {
  proposals = $state<Proposal[]>([]);
  pending = $state(false);
  error = $state<string | null>(null);
  prompt = $state('');
  project = $state<Project | null>(null);
  #client: Client | null = null;
  #reading = false;
  #diffRuns = new Map<Proposal['id'], number>();

  constructor(private store: Store) {}

  get sameMachine(): boolean { return this.#client === null || this.#client === this.store.client; }

  async start(project: Project, prompt: string, choices: [Choice, Choice]): Promise<void> {
    if (this.pending || this.proposals.length || !prompt.trim()) return;
    const client = this.store.client;
    this.error = null;
    if (!client || !this.store.owner || this.store.connection !== 'ready') {
      this.error = text.unavailable;
      return;
    }
    if (choices.some(choice => !this.store.providerOf(choice.providerId)?.available ||
      this.store.accountOf(choice.accountId)?.providerId !== choice.providerId ||
      this.store.accountOf(choice.accountId)?.status === 'unauthenticated')) {
      this.error = text.noTarget;
      return;
    }
    this.#client = client;
    this.project = { ...project };
    this.prompt = prompt;
    this.pending = true;
    this.proposals = choices.map((choice, index) => ({
      id: index === 0 ? 'a' : 'b', choice: { ...choice, permissionMode: 'default' },
      thread: null, snapshot: null, phase: 'starting', error: null, readError: null,
      changes: null, changesError: null, selectedPath: null, diff: null, diffError: null, loadingDiff: false
    }));
    let saved = comparisons.get(this.store);
    if (!saved) comparisons.set(this.store, saved = new Map());
    saved.set(comparisonKey(this.store, project.id), this);
    try {
      await Promise.all(this.proposals.map(async proposal => {
        try {
          const choice = await this.store.prepareDraftChoice(proposal.choice);
          if (!choice) throw new Error(this.store.error ?? text.noTarget);
          this.#checkMachine(client);
          const thread = await client.call('threads.create', {
            projectId: project.id,
            title: `${proposal.id.toUpperCase()}: ${prompt.trim().split('\n')[0]!.slice(0, 56)}`,
            providerId: choice.providerId, accountId: choice.accountId,
            permissionMode: 'default', effort: choice.effort, speed: choice.speed ?? null,
            ...(choice.model ? { model: choice.model } : {}), worktree: {}
          });
          proposal.thread = thread;
          this.#checkMachine(client);
          await client.call('turns.start', {
            threadId: thread.id, prompt, expectedSelectionVersion: thread.selectionVersion ?? 0,
            clientRequestId: crypto.randomUUID()
          });
          proposal.phase = 'started';
        } catch (error) {
          proposal.phase = 'failed';
          proposal.error = errorText(error);
        }
      }));
      await this.refresh();
    } finally {
      this.pending = false;
    }
  }

  #checkMachine(client: Client): void {
    if (this.store.client !== client || !this.store.owner) throw new Error(text.changed);
  }

  async refresh(): Promise<void> {
    const client = this.#client;
    if (!client || this.#reading) return;
    if (!this.sameMachine || !this.store.owner) { this.error = text.changed; return; }
    this.#reading = true;
    try {
      await Promise.all(this.proposals.map(async proposal => {
        if (!proposal.thread) return;
        try {
          const snapshot = await client.call('threads.get', { threadId: proposal.thread.id });
          this.#checkMachine(client);
          proposal.snapshot = snapshot;
          proposal.thread = snapshot;
          proposal.readError = null;
        } catch (error) { proposal.readError = errorText(error); }
        try {
          this.#checkMachine(client);
          const changes = await client.call('git.status', { threadId: proposal.thread.id });
          this.#checkMachine(client);
          proposal.changes = changes;
          proposal.changesError = null;
          if (proposal.selectedPath) await this.selectDiff(proposal.id, proposal.selectedPath);
        } catch (error) { proposal.changesError = errorText(error); }
      }));
    } finally { this.#reading = false; }
  }

  async selectDiff(id: Proposal['id'], path: string): Promise<void> {
    const proposal = this.proposals.find(item => item.id === id);
    const client = this.#client;
    if (!client || !proposal?.thread || !this.sameMachine || !this.store.owner) return;
    if (proposal.selectedPath === path && proposal.loadingDiff) return;
    const run = (this.#diffRuns.get(id) ?? 0) + 1;
    this.#diffRuns.set(id, run);
    if (proposal.selectedPath !== path) proposal.diff = null;
    proposal.selectedPath = path;
    proposal.diffError = null;
    proposal.loadingDiff = true;
    try {
      const diff = await client.call('git.diff', { threadId: proposal.thread.id, path });
      this.#checkMachine(client);
      if (this.#diffRuns.get(id) === run) proposal.diff = diff;
    } catch (error) {
      if (this.#diffRuns.get(id) === run) proposal.diffError = errorText(error);
    } finally {
      if (this.#diffRuns.get(id) === run) proposal.loadingDiff = false;
    }
  }
}

export function proposalResponse(thread: Thread | null): string {
  return thread?.messages.filter(message => message.role === 'assistant')
    .flatMap(message => message.parts.filter(part => part.type === 'text').map(part => part.text)).join('\n\n') ?? '';
}
