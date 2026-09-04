import { app } from "$lib/app/store.svelte";
import { backend } from "$lib/backend/active.svelte";
import { settings } from "$lib/features/settings/store.svelte";
import { orchestratorEnabledFor } from "$lib/features/settings/orchestratorEnabledFor";
import { logger } from "$lib/shared/services/logger.svelte";
import { Conversation } from "./conversation.svelte";

/**
 * The orchestrator conversations this window shows, and how they stay fresh.
 *
 * One conversation per scope: `null` is the workspace, a project id is that
 * project's own orchestrator. The chat shows one at a time (`scope`), but
 * every conversation already opened keeps refreshing, so switching back is a
 * read from memory rather than a refetch from zero.
 *
 * Fresh means event-driven. On desktop the Rust side emits
 * `boite://orchestrator-changed` when the log grows; on remote the control
 * plane pushes `moment.appended` / `orchestrator.changed` and
 * `control-events.ts` calls in here. There is no timer anywhere in this file,
 * and the conversation's test pins that a quiet store makes zero fetches.
 */
class OrchestratorStore {
  posting = $state(false);

  /** Which conversation the chat shows. `null` is the workspace. */
  scope = $state<string | null>(null);

  #conversations = new Map<string | null, Conversation>();

  conversationFor(scope: string | null): Conversation {
    let held = this.#conversations.get(scope);
    if (!held) {
      held = new Conversation(async (sinceId) => {
        const conduct = backend().conduct;
        if (!conduct) return [];
        return conduct.messages({ scope, sinceId });
      });
      this.#conversations.set(scope, held);
    }
    return held;
  }

  get conversation(): Conversation {
    return this.conversationFor(this.scope);
  }

  /**
   * The chat thread answering for a scope, when the orchestrator is one.
   *
   * `null` is the terminal orchestrator and the absence of one at all, which
   * the card draws the same way it always did. Read off the row rather than
   * from a flag of its own: the runtime is a column, and a window that decided
   * from settings would draw a chat over a thread launched before the
   * experiment was turned on.
   */
  pilotThreadIdFor(scope: string | null): string | null {
    const held = app.threads.find(
      (th) =>
        th.role === "orchestrator" &&
        (th.orchestratorScope ?? null) === (scope ?? null) &&
        !th.settledAt,
    );
    return held?.runtime === "pilot" ? held.id : null;
  }

  /** The same, for the conversation the card is showing. */
  get pilotThreadId(): string | null {
    return this.pilotThreadIdFor(this.scope);
  }

  /** Whether the home card draws at all. Same resolver the tri-state uses. */
  get enabled(): boolean {
    return orchestratorEnabledFor(settings.state, null);
  }

  /** Whether a given project is watched, overrides included. */
  enabledFor(projectId: string | null): boolean {
    return orchestratorEnabledFor(settings.state, projectId);
  }

  /** Something changed workspace-side; pull what is new, every scope held. */
  onWorkspaceEvent() {
    if (!this.enabled) return;
    for (const conversation of this.#conversations.values()) {
      void conversation.refresh().catch((err) => {
        logger.warn("orchestrator", "refresh failed", String(err));
      });
    }
    // Nothing opened yet: the current scope still deserves its catch-up read.
    if (this.#conversations.size === 0) {
      void this.conversation.refresh().catch((err) => {
        logger.warn("orchestrator", "refresh failed", String(err));
      });
    }
  }

  /**
   * Desktop only: the webview never long-polls, Tauri events wake it instead.
   * Same shape as the todo store's watch.
   */
  watch(): () => void {
    let stop: (() => void) | null = null;
    let cancelled = false;
    void import("@tauri-apps/api/event")
      .then(({ listen }) =>
        listen("boite://orchestrator-changed", () => this.onWorkspaceEvent()),
      )
      .then((un) => {
        if (cancelled) un();
        else stop = un;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      stop?.();
    };
  }

  /** The user's line into the shown scope: ensure a listener, then post. */
  async post(text: string): Promise<boolean> {
    const trimmed = text.trim();
    if (!trimmed || this.posting) return false;
    this.posting = true;
    const scope = this.scope;
    try {
      const { postToOrchestrator } = await import("./api");
      const ok = await postToOrchestrator(trimmed, scope);
      if (ok) await this.conversationFor(scope).refresh();
      return ok;
    } finally {
      this.posting = false;
    }
  }

  reset() {
    for (const conversation of this.#conversations.values()) conversation.reset();
    this.#conversations.clear();
    this.scope = null;
  }
}

export const orchestrator = new OrchestratorStore();
