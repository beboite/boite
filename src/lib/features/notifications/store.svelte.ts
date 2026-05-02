export type ToastKind = "info" | "success" | "error";

export interface ToastAction {
  label: string;
  run: () => void;
}

export interface Toast {
  id: string;
  kind: ToastKind;
  message: string;
  durationMs: number | null;
  action?: ToastAction;
}

export interface AddToastOptions {
  kind?: ToastKind;
  durationMs?: number | null;
  action?: ToastAction;
}

class NotificationsStore {
  toasts = $state<Toast[]>([]);

  push(message: string, opts: AddToastOptions = {}): string {
    const id = crypto.randomUUID();
    this.toasts.push({
      id,
      kind: opts.kind ?? "info",
      message,
      durationMs: opts.durationMs ?? 3000,
      action: opts.action,
    });
    return id;
  }

  success(message: string, opts: Omit<AddToastOptions, "kind"> = {}) {
    return this.push(message, { ...opts, kind: "success", durationMs: opts.durationMs ?? 1800 });
  }
  error(message: string, opts: Omit<AddToastOptions, "kind"> = {}) {
    return this.push(message, { ...opts, kind: "error", durationMs: opts.durationMs ?? 4500 });
  }
  info(message: string, opts: Omit<AddToastOptions, "kind"> = {}) {
    return this.push(message, { ...opts, kind: "info" });
  }

  dismiss(id: string) {
    this.toasts = this.toasts.filter((t) => t.id !== id);
  }
}

export const notifications = new NotificationsStore();
