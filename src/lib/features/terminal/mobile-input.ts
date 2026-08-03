import { softKeySequence } from "./keys";

/**
 * A soft keyboard driving a terminal, without the duplicated text.
 *
 * Android's Gboard is the problem this exists for. It does predictive
 * composition and emits `keyCode 229` events whose value-diffing duplicates
 * text: a tapped word completion re-sends the whole line, and deleted text
 * comes back on the next key. xterm reads the textarea, so it sees all of it.
 *
 * So the events are blocked before xterm's own listeners can run — capture
 * phase on the container, which is an ancestor of the textarea — and the
 * intent-based ones are translated to bytes here instead. Nothing is sent
 * mid-composition, so a completed word is sent exactly once.
 *
 * The scratch textarea is kept empty between words, which is what makes
 * Backspace at the start of a line still emit a real key event. A hardware
 * keyboard is untouched: [`Mobile.enabled`] is false and every handler returns.
 */
export type Mobile = {
  /** The element xterm's helper textarea lives under. */
  container: HTMLElement;
  /** Whether the mobile layout is on. Read per event, not captured. */
  enabled: () => boolean;
  /** A word, a paste, or one character with the bar's modifiers applied. */
  sendText: (data: string) => void;
  /** An escape sequence or a control byte, as it is. */
  sendSequence: (seq: string) => void;
};

/**
 * What an `inputType` means in bytes.
 *
 * A table rather than a switch because that is what it is, and because the
 * ones that are missing matter as much as the ones that are here: anything not
 * named is left to the browser, which is how a hardware keyboard keeps working.
 */
const EDITS: Record<string, string> = {
  insertLineBreak: "\r",
  insertParagraph: "\r",
  deleteContentBackward: "\x7f",
  deleteWordBackward: "\x17",
  deleteContentForward: "\x1b[3~",
};

const INSERTS = new Set(["insertText", "insertReplacementText", "insertFromPaste"]);

/**
 * Takes the container's input events over. Returns the undo.
 *
 * Every listener is capture phase on the container, so xterm's textarea
 * listeners never fire for any of them.
 */
export function installMobileInput(mobile: Mobile): () => void {
  const el = mobile.container;
  let composing = false;

  const helper = () =>
    el.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea") ?? null;

  const clearScratch = () => {
    const ta = helper();
    if (ta && ta.value !== "") ta.value = "";
  };

  const onCompositionStart = (e: Event) => {
    if (!mobile.enabled()) return;
    e.stopPropagation();
    composing = true;
  };

  const onCompositionEnd = (e: CompositionEvent) => {
    if (!mobile.enabled()) return;
    e.stopPropagation();
    composing = false;
    mobile.sendText(e.data ?? "");
    clearScratch();
  };

  const onBeforeInput = (e: InputEvent) => {
    if (!mobile.enabled()) return;
    e.stopPropagation();
    // Mid-composition keystrokes are committed together at compositionend.
    if (composing || e.inputType === "insertCompositionText") return;
    if (INSERTS.has(e.inputType)) {
      if (e.cancelable) e.preventDefault();
      mobile.sendText(e.data ?? "");
      return;
    }
    const seq = EDITS[e.inputType];
    if (seq === undefined) return;
    if (e.cancelable) e.preventDefault();
    mobile.sendSequence(seq);
  };

  const onInput = (e: Event) => {
    if (!mobile.enabled()) return;
    e.stopPropagation();
    // `beforeinput` already produced the bytes. Keeping the scratch buffer
    // empty is what stops it accumulating a stale baseline to diff against.
    if (!composing) clearScratch();
  };

  // Keys the soft keyboard emits as real key events — an empty field, or a
  // hardware key — rather than as `beforeinput`. Handled here and prevented, so
  // the matching `beforeinput` never fires and nothing is sent twice.
  const onKeyDown = (e: KeyboardEvent) => {
    if (!mobile.enabled()) return;
    e.stopPropagation();
    if (composing || e.keyCode === 229) return;
    const seq = softKeySequence(e.key);
    // Printable: left to `beforeinput` and composition, which know whether it
    // is one letter or a whole predicted word.
    if (seq === null) return;
    e.preventDefault();
    mobile.sendSequence(seq);
  };

  const onKeyOther = (e: Event) => {
    if (!mobile.enabled()) return;
    e.stopPropagation();
  };

  const cap = { capture: true } as const;
  const listeners: [string, EventListener][] = [
    ["compositionstart", onCompositionStart],
    ["compositionend", onCompositionEnd as EventListener],
    ["beforeinput", onBeforeInput as EventListener],
    ["input", onInput],
    ["keydown", onKeyDown as EventListener],
    ["keypress", onKeyOther],
    ["keyup", onKeyOther],
  ];
  for (const [name, fn] of listeners) el.addEventListener(name, fn, cap);
  return () => {
    for (const [name, fn] of listeners) el.removeEventListener(name, fn, cap);
  };
}
