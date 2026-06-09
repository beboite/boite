export interface ConfirmOptions {
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}

interface PendingConfirm extends ConfirmOptions {
  resolve: (ok: boolean) => void;
}

class ConfirmStore {
  pending = $state<PendingConfirm | null>(null);

  ask(options: ConfirmOptions): Promise<boolean> {
    this.pending?.resolve(false);
    return new Promise((resolve) => {
      this.pending = { ...options, resolve };
    });
  }

  settle(ok: boolean) {
    const p = this.pending;
    this.pending = null;
    p?.resolve(ok);
  }
}

export const confirmDialog = new ConfirmStore();
