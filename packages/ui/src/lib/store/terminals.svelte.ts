import type { TerminalState, ThreadId } from '@boite/contracts';
import type { StoreContext } from './context';

/** The thread drawers and sign-in shells: which are shown, and the calls that drive them. */
export class Terminals {
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
    else this.terminalThreads = [...this.terminalThreads, open.id];
  }

  hideTerminal(threadId: ThreadId): void {
    this.terminalThreads = this.terminalThreads.filter((id) => id !== threadId);
  }

  /** The thread's shell, attached or started; null when the core refused, with the reason in the toast. */
  async openTerminal(threadId: ThreadId, cols: number, rows: number): Promise<TerminalState | null> {
    const client = this.ctx.client;
    if (!client) return null;
    try {
      return await client.call('terminals.open', { threadId, cols, rows });
    } catch (error) {
      this.ctx.fail(error);
      return null;
    }
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
    void this.ctx.client?.call('terminals.write', { id, data }).catch(() => undefined);
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
    } catch (error) {
      this.ctx.fail(error);
    }
  }
}
