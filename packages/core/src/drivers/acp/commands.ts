/**
 * Antigravity's shell commands that outlive their turn. The agent may answer a
 * prompt while a command it started still runs, and `session/cancel` stops a
 * prompt, not that command: the agent ends it only when its own process ends.
 * A command still running when its prompt ends becomes the thread's background
 * work, so Stop on the idle thread closes the process and the command with it,
 * and the session keeps its process for as long as one runs.
 */
import type { SessionNotification } from '@agentclientprotocol/sdk';
import type { BackgroundTask } from '@boite/contracts';
import { normalizeAntigravityTool } from '../antigravity.ts';
import type { SessionContext } from '../types.ts';

type Update = SessionNotification['update'];
type Owner = Pick<SessionContext, 'background' | 'backgroundFinished'>;

interface Command {
  task: BackgroundTask;
  /** The turn that left it running, which hears how it ended; null while its turn runs. */
  owner: Owner | null;
}

export class OpenCommands {
  /** Shell calls by tool call id, `kind` included: a later update often omits it. */
  private readonly shells = new Set<string>();
  private readonly open = new Map<string, Command>();

  /** True while a command that outlived its turn still runs. */
  outlived(): boolean {
    for (const command of this.open.values()) if (command.owner !== null) return true;
    return false;
  }

  /**
   * One tool update, during a turn or between two. Returns true when it ended
   * the last command that outlived its turn.
   */
  note(update: Update): boolean {
    if (update.sessionUpdate !== 'tool_call' && update.sessionUpdate !== 'tool_call_update') return false;
    const id = update.toolCallId;
    if (update.kind === 'execute') this.shells.add(id);
    else if (update.kind !== undefined && update.kind !== null) this.shells.delete(id);
    if (!this.shells.has(id)) return false;
    if (update.status === 'completed' || update.status === 'failed') {
      this.shells.delete(id);
      const command = this.open.get(id);
      this.open.delete(id);
      if (command === undefined || command.owner === null) return false;
      command.owner.backgroundFinished?.(id, update.status === 'completed' ? 'completed' : 'error');
      this.report(command.owner);
      return !this.outlived();
    }
    if (!this.open.has(id)) {
      const input = normalizeAntigravityTool(update.rawInput, undefined)?.input;
      const command = typeof input === 'object' && input !== null ? (input as { command?: unknown }).command : undefined;
      const description = typeof command === 'string' ? command : update.title ?? id;
      this.open.set(id, { task: { id, kind: 'shell', description, toolId: id, startedAt: Date.now() }, owner: null });
    }
    return false;
  }

  /** The prompt ended: what it left running is the thread's background work. True when there is some. */
  promote(owner: Owner): boolean {
    let promoted = false;
    for (const command of this.open.values()) {
      if (command.owner !== null) continue;
      command.owner = owner;
      promoted = true;
    }
    if (promoted) this.report(owner);
    return this.outlived();
  }

  /** The process is gone, and every command with it. */
  clear(): void {
    const owners = new Set([...this.open.values()].map((command) => command.owner).filter((owner) => owner !== null));
    this.open.clear();
    this.shells.clear();
    for (const owner of owners) owner.background?.([]);
  }

  private report(owner: Owner): void {
    owner.background?.([...this.open.values()].filter((command) => command.owner !== null).map((command) => command.task));
  }
}
