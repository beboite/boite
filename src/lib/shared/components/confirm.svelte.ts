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

/**
 * Long enough for the answered dialog to leave the screen before the next one
 * arrives. The host renders on `pending`, so the gap also unmounts and remounts
 * ConfirmDialog, which is what re-runs its focus effect: promoted in place, the
 * second question would inherit the first one's focused button.
 */
const HANDOVER_MS = 160;

class ConfirmStore {
  pending = $state<PendingConfirm | null>(null);

  /**
   * Asked while a dialog is already up: the newcomer waits its turn.
   *
   * Swapping the question into the open dialog changed the title, the message
   * and what the already-focused button did, under the hands of someone about to
   * press it. Resolving the newcomer `false` instead would be this module
   * answering "no" on the user's behalf, which a caller cannot tell from a real
   * refusal. Queueing is the only option that leaves every question to the user
   * and every answer to the question it was asked for.
   */
  private queue: PendingConfirm[] = [];
  private handover: ReturnType<typeof setTimeout> | null = null;

  ask(options: ConfirmOptions): Promise<boolean> {
    return new Promise((resolve) => {
      const next: PendingConfirm = { ...options, resolve };
      if (this.pending || this.handover) {
        this.queue.push(next);
        return;
      }
      this.pending = next;
    });
  }

  settle(ok: boolean) {
    const p = this.pending;
    this.pending = null;
    p?.resolve(ok);
    this.promoteNext();
  }

  private promoteNext() {
    if (this.handover || this.queue.length === 0) return;
    this.handover = setTimeout(() => {
      this.handover = null;
      this.pending = this.queue.shift() ?? null;
    }, HANDOVER_MS);
  }
}

export const confirmDialog = new ConfirmStore();
