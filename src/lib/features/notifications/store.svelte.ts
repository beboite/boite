export type ToastKind = "info" | "success" | "error";

export interface Toast {
  id: string;
  kind: ToastKind;
  message: string;
  ttlMs: number;
}

class NotificationsStore {
  toasts = $state<Toast[]>([]);

  push(message: string, kind: ToastKind = "info", ttlMs = 2400) {
    const id = crypto.randomUUID();
    this.toasts.push({ id, kind, message, ttlMs });
    if (ttlMs > 0) {
      setTimeout(() => this.dismiss(id), ttlMs);
    }
  }

  success(message: string, ttlMs = 1800) {
    this.push(message, "success", ttlMs);
  }
  error(message: string, ttlMs = 4000) {
    this.push(message, "error", ttlMs);
  }
  info(message: string, ttlMs = 2400) {
    this.push(message, "info", ttlMs);
  }

  dismiss(id: string) {
    this.toasts = this.toasts.filter((t) => t.id !== id);
  }
}

export const notifications = new NotificationsStore();
