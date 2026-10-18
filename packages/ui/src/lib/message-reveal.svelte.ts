import type { Message, Turn } from '@boite/contracts';

/** What a tap on a control does to the row: one in the open row keeps it, any other only closes it. */
const CONTROL = 'button, a, input, textarea, select, summary, label, [role="button"], [contenteditable="true"]';

/**
 * A phone draws a message's buttons under the last prompt and the last answer
 * only; any other message shows its row once tapped, until the next tap on it
 * or anywhere else. `attrs` marks each row for the rule in app.css; a desktop
 * keeps the buttons on every message.
 */
export class MessageReveal {
  revealed = $state<string | null>(null);
  #messages: () => Message[];
  #turns: () => Turn[];
  #phone: () => boolean;
  #lastPrompt = $derived.by(() => this.#messages().findLast((message) => message.role === 'user')?.id ?? null);
  #lastTurn = $derived.by(() => this.#turns().at(-1)?.id ?? null);

  constructor(messages: () => Message[], turns: () => Turn[], phone: () => boolean) {
    this.#messages = messages;
    this.#turns = turns;
    this.#phone = phone;
    $effect(() => {
      if (this.revealed === null) return;
      const away = (event: PointerEvent) => { if (!(event.target instanceof Element) || !event.target.closest(`[data-reveal="${this.revealed}"]`)) this.revealed = null; };
      window.addEventListener('pointerdown', away, true);
      return () => window.removeEventListener('pointerdown', away, true);
    });
  }

  key(message: Message): string { return message.role === 'user' ? `prompt:${message.id}` : `turn:${message.turnId}`; }

  /** A row's marks: its key, and whether its buttons show. */
  attrs(message: Message): Record<string, string | undefined> {
    const key = this.key(message);
    const latest = message.role === 'user' ? message.id === this.#lastPrompt : message.turnId === this.#lastTurn;
    return { 'data-reveal': key, 'data-latest': latest ? '' : undefined, 'data-revealed': this.revealed === key ? '' : undefined };
  }

  /** A tap in the timeline: on a message it shows or hides that message's row. A selection is being read, not tapped. */
  tap = (event: MouseEvent): void => {
    if (!this.#phone() || !(event.target instanceof Element)) return;
    const key = event.target.closest<HTMLElement>('[data-reveal]')?.dataset.reveal ?? null;
    if (event.target.closest(CONTROL)) {
      if (key !== this.revealed) this.revealed = null;
      return;
    }
    if (window.getSelection()?.isCollapsed === false) return;
    this.revealed = key !== null && key !== this.revealed ? key : null;
  };
}
