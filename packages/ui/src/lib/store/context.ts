import { RpcFailure, type Client } from '../client';
import type { Store } from '../store.svelte';
import { Accounts } from './accounts.svelte';
import { Composer } from './composer.svelte';
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

/**
 * What the parts of one Store share and the Store keeps off its public
 * surface: the client it speaks to, the failure path, and each part for the
 * others to reach. A part calls another part's public method through `store`,
 * the facade, so a spy set on the Store sees every call it saw before the split.
 */
export class StoreContext {
  client: Client | null = null;
  off: (() => void)[] = [];

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
  readonly requests: Requests;
  readonly delegation: Delegation;
  readonly workbench: Workbench;

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
    this.requests = new Requests(this);
    this.delegation = new Delegation(this);
    this.workbench = new Workbench(this);
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
}
