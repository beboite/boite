/**
 * What a key sends, as bytes, before anything is written to a PTY.
 *
 * Pulled out of `Terminal.svelte` because none of it is about a terminal
 * component: it is the encoding a VT expects, and the only reason it lived
 * inside a 1 592-line file is that the two armed modifiers were component
 * state. They are an argument here, and the answer is a value, so what
 * `Ctrl+Alt+Up` actually puts on the wire is a question with a test rather
 * than a question you answer by opening a phone.
 */

/** The two modifiers the key bar can arm. Sticky: tapped, then used once. */
export type Modifiers = { ctrl: boolean; alt: boolean };

export const NO_MODIFIERS: Modifiers = { ctrl: false, alt: false };

/** What a press produces: bytes to send, if any, and what is armed after it. */
export type Press = {
  /** Null when the press only armed or disarmed a modifier. */
  send: string | null;
  modifiers: Modifiers;
};

const ARROW: Record<string, string> = {
  up: "A",
  down: "B",
  right: "C",
  left: "D",
};

/**
 * The control character a letter stands for.
 *
 * Two ranges rather than one, because the C0 block is reached from both cases:
 * `a`-`z` map by subtracting 96 and `@` through `_` by subtracting 64, which is
 * how `Ctrl+[` produces the same byte as Escape.
 */
export function applyCtrl(ch: string): string {
  const c = ch.charCodeAt(0);
  if (c >= 97 && c <= 122) return String.fromCharCode(c - 96);
  if (c >= 64 && c <= 95) return String.fromCharCode(c - 64);
  return ch;
}

/** A single character with whatever is armed applied to it. */
export function encodeChar(ch: string, mods: Modifiers): string {
  let out = ch;
  if (mods.ctrl) out = applyCtrl(out);
  if (mods.alt) out = "\x1b" + out;
  return out;
}

/**
 * Text arriving from the mobile input takeover.
 *
 * One character honours the armed modifiers, so the key bar works with the soft
 * keyboard. Anything longer is a committed word or a paste and goes through
 * untouched: applying Ctrl to the first letter of a pasted line is never what
 * anybody meant.
 */
export function encodeText(data: string, mods: Modifiers): Press {
  if (!data) return { send: null, modifiers: mods };
  if ((mods.ctrl || mods.alt) && data.length === 1) {
    return { send: encodeChar(data, mods), modifiers: NO_MODIFIERS };
  }
  return { send: data, modifiers: mods };
}

/**
 * One press on the CLI key bar.
 *
 * `ctrl` and `alt` toggle and send nothing. Everything else sends and clears
 * both, which is what makes them sticky rather than held.
 */
export function encodeBarKey(id: string, mods: Modifiers): Press {
  if (id === "ctrl") {
    return { send: null, modifiers: { ...mods, ctrl: !mods.ctrl } };
  }
  if (id === "alt") {
    return { send: null, modifiers: { ...mods, alt: !mods.alt } };
  }

  const spent = (send: string): Press => ({ send, modifiers: NO_MODIFIERS });
  switch (id) {
    case "esc":
      return spent("\x1b");
    case "tab":
      return spent(mods.alt ? "\x1b\t" : "\t");
    case "intr":
      return spent("\x03");
    case "up":
    case "down":
    case "left":
    case "right": {
      // The xterm modifier encoding: 1 plus a bit per modifier, and the short
      // form when nothing is armed because `ESC [ 1 ; 1 A` is not what a plain
      // arrow looks like to every reader.
      const mod = 1 + (mods.alt ? 2 : 0) + (mods.ctrl ? 4 : 0);
      const letter = ARROW[id];
      return spent(mod === 1 ? `\x1b[${letter}` : `\x1b[1;${mod}${letter}`);
    }
    case "home":
      return spent("\x1b[H");
    case "end":
      return spent("\x1b[F");
    case "pgup":
      return spent("\x1b[5~");
    case "pgdn":
      return spent("\x1b[6~");
    default:
      // A literal character on the bar, which honours what is armed.
      return spent(encodeChar(id, mods));
  }
}

/**
 * What a soft keyboard's own key event means, when it sends one at all.
 *
 * Only the keys that are not text. `null` means printable, and printable is
 * left to `beforeinput` and composition, which are the only two that know
 * whether a tap is one letter or a whole predicted word.
 */
export function softKeySequence(key: string): string | null {
  const KEYS: Record<string, string> = {
    Backspace: "\x7f",
    Enter: "\r",
    Tab: "\t",
    Escape: "\x1b",
    ArrowUp: "\x1b[A",
    ArrowDown: "\x1b[B",
    ArrowRight: "\x1b[C",
    ArrowLeft: "\x1b[D",
  };
  return KEYS[key] ?? null;
}

/**
 * How far a wheel event should scroll, in lines.
 *
 * Three units arrive depending on the device and the browser, and a page is
 * only a page if you know how tall the terminal is. Clamped to twelve because a
 * trackpad fling arrives as one enormous delta and scrolling a whole scrollback
 * in one frame is not a scroll, it is a jump.
 */
export function wheelLines(deltaY: number, deltaMode: number, rows: number): number {
  const raw =
    deltaMode === 1 /* DOM_DELTA_LINE */
      ? deltaY
      : deltaMode === 2 /* DOM_DELTA_PAGE */
        ? deltaY * rows
        : deltaY / 20;
  if (raw === 0) return 0;
  return Math.sign(raw) * Math.max(1, Math.min(12, Math.round(Math.abs(raw))));
}

/**
 * Whether this keypress means "newline inside the prompt" rather than "send".
 *
 * Two shapes, and codex is the reason there are two. `Shift+Enter` is what
 * everyone reaches for, and codex also takes `Ctrl+J`, which is the literal
 * line feed and what its own docs say. The `key` values are checked alongside
 * `code` because a non-QWERTY layout does not have `KeyJ` where the user's
 * finger is.
 */
export function isLineFeed(
  e: Pick<KeyboardEvent, "ctrlKey" | "shiftKey" | "altKey" | "key">,
  code: string,
  opts: { codex: boolean; powershellNewline: boolean },
): boolean {
  const isEnter = code === "Enter" || code === "NumpadEnter";
  if (isEnter && e.shiftKey && !e.ctrlKey && !e.altKey) {
    return opts.powershellNewline || opts.codex;
  }
  const isCtrlJ =
    e.ctrlKey &&
    !e.shiftKey &&
    !e.altKey &&
    (code === "KeyJ" || e.key === "j" || e.key === "J" || e.key === "\n" || e.key === "LineFeed");
  return opts.codex && isCtrlJ;
}
