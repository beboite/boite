import { uuid } from "$lib/shared/utils/uuid";

export type ToastKind = "info" | "success" | "error";

export interface Toast {
  id: string;
  kind: ToastKind;
  message: string;
  durationMs: number | null;
  // Bumped when the same message is raised again; the component restarts its
  // dismiss timer on a change instead of a second card appearing.
  resetKey: number;
}

interface AddOptions {
  kind?: ToastKind;
  durationMs?: number | null;
}

// Nothing dismisses a toast the user never saw, and the panels raise theirs
// from polls that repeat forever. Without a ceiling a repeatedly failing
// refresh grows this array for the whole session.
const MAX_TOASTS = 5;

class NotificationsStore {
  toasts = $state<Toast[]>([]);

  private push(message: string, opts: AddOptions = {}): string {
    // A git or explorer poll that keeps failing raises the same text every
    // 10s. Refresh the card that is already up rather than stacking a new one.
    const existing = this.toasts.find((t) => t.message === message);
    if (existing) {
      if (opts.kind) existing.kind = opts.kind;
      if (opts.durationMs !== undefined) existing.durationMs = opts.durationMs;
      existing.resetKey++;
      return existing.id;
    }

    const id = uuid();
    this.toasts.push({
      id,
      kind: opts.kind ?? "info",
      message,
      durationMs: opts.durationMs ?? 3000,
      resetKey: 0,
    });
    if (this.toasts.length > MAX_TOASTS) {
      this.toasts.splice(0, this.toasts.length - MAX_TOASTS);
    }
    return id;
  }

  success(message: string, durationMs?: number | null) {
    return this.push(message, { kind: "success", durationMs: durationMs ?? 1800 });
  }
  error(message: string, durationMs?: number | null) {
    return this.push(message, { kind: "error", durationMs: durationMs ?? 4500 });
  }

  // Splice, not a filtered reassignment: replacing the array invalidates every
  // consumer of the list, including the other cards' own render.
  dismiss(id: string) {
    const i = this.toasts.findIndex((t) => t.id === id);
    if (i !== -1) this.toasts.splice(i, 1);
  }
}

export const notifications = new NotificationsStore();
