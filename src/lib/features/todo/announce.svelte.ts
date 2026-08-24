import type { TodoChange, TodoDelta } from "./diff";
import { notifications, type ToastKind } from "$lib/features/notifications/store.svelte";
import { t } from "$lib/i18n/index.svelte";
import type { MessageKey } from "$lib/i18n/messages";

/**
 * An agent touching the list is news, the same way a commit or a failed push
 * is: it goes on the toast stack, with the title as the message and the kind
 * of change as the detail. A separate card in the middle of the window was
 * the other format, and it was the one nobody could place next to the rest.
 *
 * Ids are kept so a workspace switch can drop these without touching a toast
 * that was already up for something else.
 */

const KIND: Record<TodoChange, ToastKind> = {
  claimed: "warning",
  done: "success",
  added: "info",
  reopened: "info",
  removed: "info",
};

const KEY: Record<TodoChange, MessageKey> = {
  claimed: "todo.announceClaimed",
  done: "todo.announceDone",
  added: "todo.announceAdded",
  reopened: "todo.announceReopened",
  removed: "todo.announceRemoved",
};

class TodoAnnouncer {
  #ids: string[] = [];

  push(deltas: TodoDelta[]) {
    for (const delta of deltas) {
      const verb = t(KEY[delta.change]);
      const detail =
        delta.change === "claimed" && delta.todo.claimedBy
          ? `${verb} · ${t("todo.announceBy", { agent: delta.todo.claimedBy })}`
          : verb;
      this.#ids.push(notifications[KIND[delta.change]](delta.todo.title, undefined, detail));
    }
  }

  /** A workspace switch: these cards described the previous list. */
  reset() {
    for (const id of this.#ids) notifications.dismiss(id);
    this.#ids = [];
  }
}

export const todoAnnouncer = new TodoAnnouncer();
