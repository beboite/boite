import { uuid } from "$lib/shared/utils/uuid";

export type ToastKind = "info" | "success" | "error";

export interface Toast {
  id: string;
  kind: ToastKind;
  message: string;
  durationMs: number | null;
}

interface AddOptions {
  kind?: ToastKind;
  durationMs?: number | null;
}

class NotificationsStore {
  toasts = $state<Toast[]>([]);

  private push(message: string, opts: AddOptions = {}): string {
    const id = uuid();
    this.toasts.push({
      id,
      kind: opts.kind ?? "info",
      message,
      durationMs: opts.durationMs ?? 3000,
    });
    return id;
  }

  success(message: string, durationMs?: number | null) {
    return this.push(message, { kind: "success", durationMs: durationMs ?? 1800 });
  }
  error(message: string, durationMs?: number | null) {
    return this.push(message, { kind: "error", durationMs: durationMs ?? 4500 });
  }

  dismiss(id: string) {
    this.toasts = this.toasts.filter((t) => t.id !== id);
  }
}

export const notifications = new NotificationsStore();
