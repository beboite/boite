/** An in-app confirm, in place of `window.confirm`, which draws the OS dialog over the family look. */
export interface ConfirmRequest {
  title: string;
  body?: string;
  confirmLabel: string;
  cancelLabel: string;
  /** A second way forward between Cancel and Confirm, answered as `'alt'` by `choose`. */
  altLabel?: string;
  danger?: boolean;
}

/** What `choose` answers: the confirm button, the second one, or Cancel, Escape and the scrim. */
export type ConfirmChoice = 'confirm' | 'alt' | 'cancel';

class ConfirmStore {
  current = $state<ConfirmRequest | null>(null);
  #resolve: ((answer: ConfirmChoice) => void) | null = null;

  ask(request: ConfirmRequest): Promise<boolean> {
    return this.choose(request).then((choice) => choice === 'confirm');
  }

  /** Like `ask`, for a dialog with a second way forward (`altLabel`). */
  choose(request: ConfirmRequest): Promise<ConfirmChoice> {
    this.#settle('cancel');
    this.current = request;
    return new Promise<ConfirmChoice>((resolve) => {
      this.#resolve = resolve;
    });
  }

  answer(value: boolean | ConfirmChoice): void {
    this.#settle(value === true ? 'confirm' : value === false ? 'cancel' : value);
  }

  #settle(value: ConfirmChoice): void {
    const resolve = this.#resolve;
    this.#resolve = null;
    this.current = null;
    resolve?.(value);
  }
}

export const confirm = new ConfirmStore();
