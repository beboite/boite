/** An in-app confirm, in place of `window.confirm`, which draws the OS dialog over the family look. */
export interface ConfirmRequest {
  title: string;
  body?: string;
  confirmLabel: string;
  cancelLabel: string;
  danger?: boolean;
}

class ConfirmStore {
  current = $state<ConfirmRequest | null>(null);
  #resolve: ((answer: boolean) => void) | null = null;

  ask(request: ConfirmRequest): Promise<boolean> {
    this.#settle(false);
    this.current = request;
    return new Promise<boolean>((resolve) => {
      this.#resolve = resolve;
    });
  }

  answer(value: boolean): void {
    this.#settle(value);
  }

  #settle(value: boolean): void {
    const resolve = this.#resolve;
    this.#resolve = null;
    this.current = null;
    resolve?.(value);
  }
}

export const confirm = new ConfirmStore();
