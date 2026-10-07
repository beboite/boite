/**
 * A live view (the agent's browser, a device) driven from a computer: once its
 * picture has been clicked, the keyboard and the clipboard belong to it until
 * a click or a focus lands elsewhere. The listeners sit on the document
 * because the picture is a button that is disabled while an input is in
 * flight, and a disabled button hears neither keys nor clipboard events.
 */
export interface LiveInputHandlers {
  /** Returns true when the key went to the view: the app then never sees it. */
  key(event: KeyboardEvent): boolean;
  paste(text: string): void;
  /** The view's selected text; absent or an empty answer leaves the clipboard as it was. */
  copy?(): Promise<string>;
  /** After a cut reached the clipboard: erase the selection in the view. */
  cut?(): void;
  /** A copy that could not be written, with the reason. */
  failed?(reason: string): void;
}

const editable = (target: EventTarget | null) => target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));

/**
 * A computer rather than a touch screen: it drives a live view directly, with
 * no keys or text field under it. The app's other touch rules ask the same
 * question (`pointer: coarse`), so a tablet keeps the phone's controls.
 */
export function hasKeyboard(): boolean {
  return typeof matchMedia === 'function' && matchMedia('not all and (pointer: coarse)').matches;
}

/**
 * Writes text that is still on its way. Safari only lets a page write the
 * clipboard inside the gesture, so the promise itself is handed over where the
 * browser takes one. Resolves false when there was nothing to write.
 */
export async function writeClipboardLater(text: Promise<string>): Promise<boolean> {
  const clipboard = navigator.clipboard;
  if (!clipboard) throw new Error('this browser gives pages no clipboard here');
  if (typeof ClipboardItem === 'function' && typeof clipboard.write === 'function') {
    const empty = new Error('nothing selected');
    try {
      await clipboard.write([new ClipboardItem({ 'text/plain': text.then(value => { if (!value) throw empty; return new Blob([value], { type: 'text/plain' }); }) })]);
      return true;
    } catch (cause) {
      const value = await text;
      if (cause === empty || !value) return false;
      // An engine that takes no promise in a ClipboardItem: the plain call below still has the gesture's allowance.
    }
  }
  const value = await text;
  if (!value) return false;
  await clipboard.writeText(value);
  return true;
}

export interface LiveInput { arm(): void; readonly armed: boolean; destroy(): void }

export function liveInput(screen: () => Element | null | undefined, handlers: LiveInputHandlers): LiveInput {
  let armed = false;
  const mine = (event: Event) => armed && !editable(event.target);
  const pointer = (event: Event) => { armed = event.target instanceof Node && !!screen()?.contains(event.target); };
  const focus = (event: Event) => { if (editable(event.target)) armed = false; };
  const key = (event: KeyboardEvent) => {
    if (!mine(event) || event.isComposing) return;
    if (handlers.key(event)) { event.preventDefault(); event.stopPropagation(); }
  };
  const paste = (event: ClipboardEvent) => {
    if (!mine(event)) return;
    event.preventDefault();
    const text = event.clipboardData?.getData('text/plain') ?? '';
    if (text) handlers.paste(text);
  };
  const copy = (event: ClipboardEvent) => {
    if (!mine(event) || !handlers.copy) return;
    event.preventDefault();
    writeClipboardLater(handlers.copy()).then(
      written => { if (written && event.type === 'cut') handlers.cut?.(); },
      cause => handlers.failed?.(cause instanceof Error ? cause.message : String(cause)));
  };
  document.addEventListener('pointerdown', pointer, true);
  document.addEventListener('focusin', focus, true);
  document.addEventListener('keydown', key, true);
  document.addEventListener('paste', paste);
  document.addEventListener('copy', copy);
  document.addEventListener('cut', copy);
  return {
    arm() { armed = true; },
    get armed() { return armed; },
    destroy() {
      armed = false;
      document.removeEventListener('pointerdown', pointer, true);
      document.removeEventListener('focusin', focus, true);
      document.removeEventListener('keydown', key, true);
      document.removeEventListener('paste', paste);
      document.removeEventListener('copy', copy);
      document.removeEventListener('cut', copy);
    },
  };
}

const NAMED = new Set(['Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', 'Insert']);

/**
 * What a key pressed on the live browser sends: a `press` key, the select-all,
 * text for a character no key event names (an emoji), or nothing. Copy, cut
 * and paste are left to the clipboard events, the function keys and every
 * other Control or Command chord to the app and the browser around it.
 */
export function browserKey(event: KeyboardEvent): { press: string } | { text: string } | 'select-all' | null {
  // AltGr reads as Control+Alt on Windows: the character it produced is what was typed.
  const altGraph = event.getModifierState?.('AltGraph') === true;
  const command = (event.ctrlKey || event.metaKey) && !altGraph;
  const key = event.key;
  if (command) {
    if (event.altKey) return null;
    const letter = key.toLowerCase();
    if (letter === 'a' && !event.shiftKey) return 'select-all';
    if (letter === 'z' || letter === 'y') return { press: `Control+${event.shiftKey ? 'Shift+' : ''}${letter}` };
    if (NAMED.has(key) && key !== 'Tab' && key !== 'Escape') return { press: `Control+${event.shiftKey ? 'Shift+' : ''}${key}` };
    return null;
  }
  if (event.altKey && !altGraph) return null;
  if (NAMED.has(key)) return { press: event.shiftKey ? `Shift+${key}` : key };
  if (key === ' ') return { press: 'Space' };
  if (key.length === 1 && !/\s/.test(key)) return { press: key };
  if ([...key].length === 1) return { text: key };
  return null;
}

const DEVICE_KEYS = { Enter: 'enter', Backspace: 'backspace', Delete: 'delete', Tab: 'tab', Escape: 'back', ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' } as const;

/** What a key pressed on a live device sends: a device key (Escape is Android's back), a printable ASCII character, or nothing. */
export function deviceKey(event: KeyboardEvent): { key: (typeof DEVICE_KEYS)[keyof typeof DEVICE_KEYS] } | { text: string } | null {
  const altGraph = event.getModifierState?.('AltGraph') === true;
  if (((event.ctrlKey || event.metaKey || event.altKey) && !altGraph)) return null;
  if (Object.hasOwn(DEVICE_KEYS, event.key)) return { key: DEVICE_KEYS[event.key as keyof typeof DEVICE_KEYS] };
  return /^[\x20-\x7e]$/.test(event.key) ? { text: event.key } : null;
}

/** Pasted text as `adb shell input text` can type it: one line, or null when a character is outside printable ASCII. */
export function devicePaste(text: string): string | null {
  const line = text.replace(/\s*[\r\n\t]+\s*/g, ' ').trim();
  return /^[\x20-\x7e]*$/.test(line) ? line : null;
}
