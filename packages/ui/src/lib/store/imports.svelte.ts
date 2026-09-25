import type { ImportableSession, ProjectId } from '@boite/contracts';
import { isExperimentEnabled } from '../experiments';
import type { StoreContext } from './context';

/** The import dialog: agent sessions found on disk, brought in as threads. */
export class Imports {
  /** The import dialog while it is open: the project, what `imports.list` found, the session being imported. */
  imports = $state<{ projectId: ProjectId; sessions: ImportableSession[]; loading: boolean; running: string | null } | null>(null);

  constructor(private readonly ctx: StoreContext) {}

  /**
   * The import dialog for one project: opens at once, the list arrives when the
   * core has read the files. Behind the `session-import` experiment: a chord or
   * a palette row that reaches here with it off does nothing.
   */
  async openImports(projectId: ProjectId): Promise<void> {
    const client = this.ctx.client;
    if (!client || !isExperimentEnabled('session-import')) return;
    this.imports = { projectId, sessions: [], loading: true, running: null };
    try {
      const sessions = await client.call('imports.list', { projectId });
      if (this.imports?.projectId === projectId) this.imports = { ...this.imports, sessions, loading: false };
    } catch (error) {
      this.imports = null;
      this.ctx.fail(error);
    }
  }

  closeImports(): void {
    if (this.imports?.running === null) this.imports = null;
  }

  /** One session into a new thread, opened on arrival; the dialog closes with it. */
  async importSession(accountId: string, sessionId: string): Promise<void> {
    const client = this.ctx.client;
    const dialog = this.imports;
    if (!client || !dialog || dialog.running !== null) return;
    this.imports = { ...dialog, running: sessionId };
    try {
      const summary = await client.call('imports.run', { projectId: dialog.projectId, accountId, sessionId });
      this.imports = null;
      this.ctx.threads.upsertThread(summary);
      this.ctx.store.showChat();
      await this.ctx.store.open(summary.id);
    } catch (error) {
      this.imports = { ...dialog, running: null };
      this.ctx.fail(error);
    }
  }
}
