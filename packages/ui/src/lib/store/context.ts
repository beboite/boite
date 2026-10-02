import { RpcFailure, type Client } from '../client';
import type { Store } from '../store.svelte';
import { Accounts } from './accounts.svelte';
import { Composer } from './composer.svelte';
import { Drafts } from './drafts.svelte';
import { Connection } from './connection.svelte';
import { Delegation } from './delegation.svelte';
import { Imports } from './imports.svelte';
import { Layout } from './layout.svelte';
import { Models } from './models.svelte';
import { Pairing } from './pairing.svelte';
import { Projects } from './projects.svelte';
import { Requests } from './requests.svelte';
import { CoreSettings } from './settings.svelte';
import { Terminals } from './terminals.svelte';
import { Threads } from './threads.svelte';
import { Workbench } from './workbench.svelte';
import { Workflows } from './workflows.svelte';
import { ServerUpdater } from './server-update.svelte';
import type { Account, Project, ThreadSummary } from '@boite/contracts';
import { SnapshotReads } from './snapshot-reads';

/**
 * What the parts of one Store share and the Store keeps off its public
 * surface: the client it speaks to, the failure path, and each part for the
 * others to reach. A part calls another part's public method through `store`,
 * the facade, so a spy set on the Store sees every call it saw before the split.
 */
export class StoreContext {
  #client: Client | null = null;
  clientGeneration = 0;
  off: (() => void)[] = [];
  readonly threadReads = new SnapshotReads<ThreadSummary>(row => row.id);
  readonly projectReads = new SnapshotReads<Project>(row => row.id);
  readonly accountReads = new SnapshotReads<Account>(row => row.id);
  readonly metadataRevision = { providers: 0, settings: 0, scheduler: 0, keybindings: 0 };

  get client(): Client | null { return this.#client; }
  set client(client: Client | null) {
    if (client !== this.#client) this.connection.invalidateReads();
    this.#client = client;
  }

  readonly connection: Connection;
  readonly pairing: Pairing;
  readonly layout: Layout;
  readonly settings: CoreSettings;
  readonly terminals: Terminals;
  readonly models: Models;
  readonly accounts: Accounts;
  readonly projects: Projects;
  readonly threads: Threads;
  readonly imports: Imports;
  readonly composer: Composer;
  readonly drafts: Drafts;
  readonly requests: Requests;
  readonly delegation: Delegation;
  readonly workbench: Workbench;
  readonly workflows: Workflows;
  readonly serverUpdater: ServerUpdater;

  constructor(readonly store: Store) {
    this.connection = new Connection(this);
    this.pairing = new Pairing(this);
    this.layout = new Layout(this);
    this.settings = new CoreSettings(this);
    this.terminals = new Terminals(this);
    this.models = new Models(this);
    this.accounts = new Accounts(this);
    this.projects = new Projects(this);
    this.threads = new Threads(this);
    this.imports = new Imports(this);
    this.composer = new Composer(this);
    this.drafts = new Drafts(this);
    this.requests = new Requests(this);
    this.delegation = new Delegation(this);
    this.workbench = new Workbench(this);
    this.workflows = new Workflows(this);
    this.serverUpdater = new ServerUpdater(this);
  }

  /**
   * The sentence one failure reads as, whether it lands in a surface or the
   * toast. The JSON-RPC code used to ride along as `(-32011)`: it says nothing
   * to the person reading the toast, and every refusal already names what to
   * do. It belongs in the console, which `fail` writes it to.
   */
  reason(error: unknown): string {
    if (error instanceof RpcFailure) return error.message;
    if (error instanceof Error) return error.message;
    return String(error);
  }

  fail(error: unknown): void {
    if (error instanceof RpcFailure) console.error(`rpc ${error.code}: ${error.message}`, error);
    else console.error(error);
    this.store.error = this.reason(error);
  }

  currentNavigation(client: Client, generation: number): boolean {
    return this.client === client && this.threads.openGeneration === generation;
  }

  currentClient(client: Client, generation: number): boolean {
    return this.client === client && this.clientGeneration === generation;
  }
}
