import { backend } from "$lib/backend";
import { logger } from "$lib/shared/services/logger.svelte";
import { uuid } from "$lib/shared/utils/uuid";
import type { PendingApproval } from "$lib/backend/types";

/**
 * Questions the user has to answer, from wherever they come.
 *
 * Two sources, one dock. An agent asking through the endpoint is a row in the
 * workspace database, which is what makes it survive the app being closed and
 * reach a second window. Anything the front end wants answered the same way —
 * without stealing focus, without a scrim, while the terminal underneath keeps
 * running — calls {@link ApprovalStore.ask} and gets a promise back.
 *
 * The difference from `shared/components/confirm.svelte.ts` is who is waiting.
 * A confirm dialog is the answer to something the user just did, so it owns the
 * screen until they answer. These arrive on their own schedule, so they queue
 * in a corner and the work underneath carries on.
 *
 * Nothing here decides anything for a backend row: the dispatch that will run
 * lives in the database beside the request, so `decide` sends an id and a yes or
 * no and the host replays what was stored. A card that rebuilt the request from
 * what it was rendering would be a second idea of what the user agreed to.
 */

/** How loud a card is. `danger` is for an answer that cannot be taken back. */
export type ApprovalTone = "normal" | "danger";

/** What any use case has to say to put a card up. */
export interface ApprovalAsk {
  /** Who or what is asking: an agent, a device, Boite itself. */
  title: string;
  /** The question, in one or two lines. */
  message: string;
  /** Where it comes from, shown small beside the title. A project, a host. */
  where?: string;
  tone?: ApprovalTone;
  allowLabel?: string;
  refuseLabel?: string;
}

interface LocalAsk extends ApprovalAsk {
  id: string;
  settle: (allow: boolean) => void;
}

/**
 * One card, whichever source it came from.
 *
 * The two halves are kept apart rather than flattened into one shape: an agent
 * row names a thread and a project by id and a verb the dictionary has a
 * sentence for, and turning that into words needs the project list and the
 * locale. That is the dock's job, not the store's.
 */
export type ApprovalItem =
  | { id: string; source: "agent"; row: PendingApproval }
  | { id: string; source: "local"; ask: ApprovalAsk };

/**
 * Past this many the dock stops drawing cards and says how many are left.
 *
 * A loop in an agent can open one of these per turn, and a column of forty
 * covers the window it is asking about. The rest are not lost: answering one
 * uncovers the next.
 */
export const MAX_VISIBLE = 3;

class ApprovalStore {
  /** Rows the endpoint opened, as the host reports them. */
  pending = $state<PendingApproval[]>([]);
  /** Questions this window asked itself, oldest first. */
  local = $state<LocalAsk[]>([]);
  /** Ids being answered right now, so a double click does not send twice. */
  deciding = $state<string[]>([]);

  /** Everything waiting, agents first: they have been waiting the longest. */
  readonly items: ApprovalItem[] = $derived([
    ...this.pending.map((row): ApprovalItem => ({ id: row.id, source: "agent", row })),
    ...this.local.map((ask): ApprovalItem => ({ id: ask.id, source: "local", ask })),
  ]);

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

  /**
   * Puts a question in the dock and resolves when it is answered.
   *
   * Resolves `false` if the workspace goes away under it, because a caller
   * cannot tell an unanswered question from a refused one and refused is the
   * half that does nothing.
   */
  ask(request: ApprovalAsk): Promise<boolean> {
    return new Promise((settle) => {
      this.local = [...this.local, { ...request, id: uuid(), settle }];
    });
  }

  /** Answers one card, whichever source it came from. */
  async decide(id: string, allow: boolean): Promise<void> {
    if (this.deciding.includes(id)) return;
    const asked = this.local.find((l) => l.id === id);
    if (asked) {
      this.local = this.local.filter((l) => l.id !== id);
      asked.settle(allow);
      return;
    }
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
   * Answers everything on screen the same way.
   *
   * Sequential, not `Promise.all`: allowing three moves at once is three
   * dispatches racing for the same terminal, and the host replays them in the
   * order it is told.
   */
  async decideAll(allow: boolean): Promise<void> {
    for (const item of this.items) {
      await this.decide(item.id, allow);
    }
  }

  /** A workspace switch invalidates everything: the rows live in that DB. */
  reset() {
    // The local half is settled rather than dropped, so a caller awaiting one
    // is not left holding a promise nothing will ever resolve.
    for (const l of this.local) l.settle(false);
    this.local = [];
    this.pending = [];
    this.deciding = [];
  }

  /**
   * Follows the host's notice that something changed.
   *
   * Desktop only, like the todo list's: an agent writes through the loopback
   * endpoint, so the change arrives as a Rust event rather than through any
   * call this store made. The remote transport has its own control plane and
   * reloads on `approvals.changed` (`app/control-events.ts`); what it needs
   * beyond that is the first read, which `adoptRemote` does once the workspace
   * is up. This comment used to name a `workspace.boot` that has never
   * existed, and nothing was reading the table on that path at all.
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
}

export const approvals = new ApprovalStore();
