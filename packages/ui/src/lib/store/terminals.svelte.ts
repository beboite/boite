import { RpcErrorCode, type RpcEvents, type TerminalState, type ThreadId } from '@boite/contracts';
import { RpcFailure } from '../client';
import type { StoreContext } from './context';

/** The thread drawers and sign-in shells: which are shown, and the calls that drive them. */
export class Terminals {
  private readonly opening = new Map<ThreadId, { client: StoreContext['client']; result: Promise<TerminalState | null> }>();
  /** Threads whose terminal drawer shows. The shell lives in the core and outlasts a hidden drawer. */
  terminalThreads = $state<ThreadId[]>([]);
  /** Accounts whose sign-in terminal is open on the Providers page. */
  loginTerminals = $state<string[]>([]);

  constructor(private readonly ctx: StoreContext) {}

  terminalShown(threadId: ThreadId): boolean {
    return this.terminalThreads.includes(threadId);
  }

  /** Ctrl+J: the open thread's drawer, shown or hidden. A shell is the owner's to run. */
  toggleTerminal(): void {
    const s = this.ctx.store;
    const open = s.openThread;
    if (!open || !s.owner) return;
    if (s.terminalShown(open.id)) s.hideTerminal(open.id);
    else {
      this.terminalThreads = [...this.terminalThreads, open.id];
      const client = this.ctx.client;
      // Start the shell at the click, while the frame unfolds and xterm loads.
      // The view joins this request and fits the shell to its measured size.
      void s.openTerminal(open.id, 80, 24).then((state) => {
        if (state === null && this.ctx.client === client) s.hideTerminal(open.id);
      });
    }
  }

  hideTerminal(threadId: ThreadId): void {
    this.terminalThreads = this.terminalThreads.filter((id) => id !== threadId);
  }

  /** The thread's shell, attached or started; null when the core refused, with the reason in the toast. */
  openTerminal(threadId: ThreadId, cols: number, rows: number): Promise<TerminalState | null> {
    const client = this.ctx.client;
    if (!client) return Promise.resolve(null);
    const pending = this.opening.get(threadId);
    if (pending?.client === client) return pending.result;
    // A lazy view can join after output has already arrived while the opening
    // snapshot is in flight. Keep that gap and advance its sequence so the
    // view does not draw the same events twice.
    const output: RpcEvents['terminal.output'][] = [];
    const stop = client.on('terminal.output', (event) => {
      if (event.id === `terminal:${threadId}`) output.push(event);
    });
    const result = client.call('terminals.open', { threadId, cols, rows })
      .then((state) => {
        // An older core cannot identify snapshot overlap. Refresh its history
        // after the buffered events instead of dropping output the lazy view missed.
        if (state.sequence === undefined && output.length > 0) return client.call('terminals.open', { threadId, cols, rows });
        const after = output.filter((event) => state.sequence !== undefined && event.sequence !== undefined && event.sequence > state.sequence);
        return after.length === 0 ? state : {
          ...state, output: state.output + after.map((event) => event.data).join(''), sequence: after.at(-1)!.sequence
        };
      })
      .catch((error) => { if (this.ctx.client === client) this.ctx.fail(error); return null; })
      .finally(() => {
        stop();
        if (this.opening.get(threadId)?.result === result) this.opening.delete(threadId);
      });
    this.opening.set(threadId, { client, result });
    return result;
  }

  /** The account's sign-in shell with its login command typed in, attached or started. */
  async loginTerminal(accountId: string, cols: number, rows: number): Promise<TerminalState | null> {
    const client = this.ctx.client;
    if (!client) return null;
    try {
      return await client.call('accounts.loginTerminal', { accountId, cols, rows });
    } catch (error) {
      this.ctx.fail(error);
      return null;
    }
  }

  showLoginTerminal(accountId: string): void {
    if (!this.loginTerminals.includes(accountId)) this.loginTerminals = [...this.loginTerminals, accountId];
  }

  hideLoginTerminal(accountId: string): void {
    this.loginTerminals = this.loginTerminals.filter((id) => id !== accountId);
  }

  /** Keystrokes. A shell that ended in between has nothing to take them, which is not an error to show. */
  writeTerminal(id: string, data: string): void {
    void this.ctx.client?.call('terminals.write', { id, data }).catch(error => {
      if (error instanceof RpcFailure && error.code === RpcErrorCode.NotFound) return;
      this.ctx.fail(error);
    });
  }

  resizeTerminal(id: string, cols: number, rows: number): void {
    void this.ctx.client?.call('terminals.resize', { id, cols, rows }).catch(() => undefined);
  }

  /** Kills the shell; `terminal.exited` follows. */
  async closeTerminal(id: string): Promise<void> {
    const client = this.ctx.client;
    if (!client) return;
    try {
      await client.call('terminals.close', { id });
      // The display may still be loading and have no exit listener yet.
      if (this.ctx.client === client && id.startsWith('terminal:')) this.hideTerminal(id.slice('terminal:'.length) as ThreadId);
    } catch (error) {
      this.ctx.fail(error);
    }
  }
}
