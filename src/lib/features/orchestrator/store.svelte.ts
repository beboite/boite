import { backend } from "$lib/backend/active.svelte";
import { settings } from "$lib/features/settings/store.svelte";
import { logger } from "$lib/shared/services/logger.svelte";
import { Conversation } from "./conversation.svelte";

/**
 * The one orchestrator conversation this window shows, and how it stays fresh.
 *
 * Fresh means event-driven. On desktop the Rust side emits
 * `boite://orchestrator-changed` when the log grows; on remote the control
 * plane pushes `moment.appended` / `orchestrator.changed` and
 * `control-events.ts` calls in here. There is no timer anywhere in this file,
 * and the conversation's test pins that a quiet store makes zero fetches.
 */
class OrchestratorStore {
  posting = $state(false);

  readonly conversation = new Conversation(async (sinceId) => {
    const conduct = backend().conduct;
    if (!conduct) return [];
    return conduct.messages({ scope: null, sinceId });
  });

  /** Whether the home card draws at all. Same resolver the status engine uses. */
  get enabled(): boolean {
    return (
      settings.state.experimentOrchestrator && !!settings.state.orchestratorAgent
    );
  }

  /** Something changed workspace-side; pull what is new. */
  onWorkspaceEvent() {
    if (!this.enabled) return;
    void this.conversation.refresh().catch((err) => {
      logger.warn("orchestrator", "refresh failed", String(err));
    });
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

  /** The user's line: make sure someone is listening, then post it. */
  async post(text: string): Promise<boolean> {
    const trimmed = text.trim();
    if (!trimmed || this.posting) return false;
    this.posting = true;
    try {
      const { postToOrchestrator } = await import("./api");
      const ok = await postToOrchestrator(trimmed);
      if (ok) await this.conversation.refresh();
      return ok;
    } finally {
      this.posting = false;
    }
  }

  reset() {
    this.conversation.reset();
  }
}

export const orchestrator = new OrchestratorStore();
