import { backend } from "$lib/backend";
import { logger } from "$lib/shared/services/logger.svelte";
import type { PendingApproval } from "$lib/backend/types";

/**
 * What an agent has asked the user to agree to, and has not been answered.
 *
 * The list is not scoped to the project on screen. An agent in another one
 * asking to move its thread is exactly the request that would otherwise sit
 * invisible until somebody happened to stand in the right place.
 *
 * Nothing here decides anything: the dispatch that will run lives in the
 * database beside the request, so `decide` sends an id and a yes or no and the
 * host replays what was stored. A card that rebuilt the request from what it
 * was rendering would be a second idea of what the user agreed to.
 */
class ApprovalStore {
  pending = $state<PendingApproval[]>([]);
  /** Ids being answered right now, so a double click does not send twice. */
  deciding = $state<string[]>([]);

  async reload(): Promise<void> {
    try {
      this.pending = await backend().approvals.list();
    } catch (err) {
      // A workspace with no endpoint running has no approvals to show, which
      // is not the same as an error worth a toast.
      logger.warn("approvals", "list failed", String(err));
      this.pending = [];
    }
  }

  async decide(id: string, allow: boolean): Promise<void> {
    if (this.deciding.includes(id)) return;
    this.deciding = [...this.deciding, id];
    try {
      await backend().approvals.decide(id, allow);
      // Dropped locally rather than waiting for the reload: the answer is
      // final either way, and a card that lingers invites a second click.
      this.pending = this.pending.filter((p) => p.id !== id);
    } catch (err) {
      logger.error("approvals", "decide failed", String(err));
      await this.reload();
    } finally {
      this.deciding = this.deciding.filter((x) => x !== id);
    }
  }

  /**
   * Follows the host's notice that something changed.
   *
   * Desktop only, like the todo list's: an agent writes through the loopback
   * endpoint, so the change arrives as a Rust event rather than through any
   * call this store made. The remote transport has its own control plane and
   * reloads from `workspace.boot`.
   */
  watch(): () => void {
    let stop: (() => void) | null = null;
    let cancelled = false;
    void import("@tauri-apps/api/event")
      .then(({ listen }) => listen("boite://approvals-changed", () => void this.reload()))
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

  /** A workspace switch invalidates everything: the rows live in that DB. */
  reset() {
    this.pending = [];
    this.deciding = [];
  }
}

export const approvals = new ApprovalStore();
