import type { OrchestratorMessage } from "$lib/backend/types";

/**
 * The voice rules with no engine behind them: what gets spoken, and the
 * push-to-talk key machine. Split from the store so the tests can walk them
 * without dragging the settings store and the backend into the run — and
 * without a speech engine anywhere near a test.
 */

/** How long a transcription sits in the composer before sending itself. */
export const AUTO_SEND_MS = 1500;

/**
 * Whether this one message should be read aloud. The caller answers "was it
 * already spoken" itself; everything else is here: only the orchestrator's own
 * lines, only their `aloud` field, only with a voice explicitly picked, and
 * only when the window is being looked at unless the user said otherwise.
 */
export function shouldSpeak(
  message: Pick<OrchestratorMessage, "role" | "aloud">,
  opts: {
    enabled: boolean;
    voiceName: string | null;
    focused: boolean;
    speakWhenUnfocused: boolean;
  },
): boolean {
  if (!opts.enabled) return false;
  if (opts.voiceName === null) return false;
  if (message.role === "user") return false;
  if (!message.aloud || !message.aloud.trim()) return false;
  if (!opts.focused && !opts.speakWhenUnfocused) return false;
  return true;
}

/**
 * The push-to-talk key: Ctrl+Space held, on every platform. Cmd+Space is the
 * macOS Spotlight chord, so `mod` semantics would hand the key to the OS there.
 *
 * Window-level like `JumpModifier`, and for the same reason: a hold is keydown
 * plus keyup plus the two ways a keyup gets lost (a chord that switches
 * windows, a screen lock that hides it without a blur). The keyboard
 * controller dispatches single chords; a hold is a different machine.
 */
export class PushToTalk {
  down = $state(false);

  constructor(
    private readonly begin: () => void,
    private readonly end: () => void,
  ) {}

  private matches(e: KeyboardEvent): boolean {
    return e.code === "Space" && e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey;
  }

  private release(): void {
    if (!this.down) return;
    this.down = false;
    this.end();
  }

  // Public so tests can drive the machine without a DOM to dispatch into.
  onKeyDown = (e: KeyboardEvent): void => {
    if (!this.matches(e)) return;
    e.preventDefault();
    if (e.repeat || this.down) return;
    this.down = true;
    this.begin();
  };

  onKeyUp = (e: KeyboardEvent): void => {
    // Either half of the chord coming up ends the hold: someone who lets go of
    // Ctrl first would otherwise keep the microphone open on a lone Space.
    if (e.code === "Space" || e.key === "Control") this.release();
  };

  onBlur = (): void => {
    this.release();
  };

  onVisibility = (): void => {
    if (document.hidden) this.release();
  };

  /** Mounted while a voice button is on screen. Returns a cleanup. */
  watch(): () => void {
    if (typeof window === "undefined") return () => {};
    window.addEventListener("keydown", this.onKeyDown, { capture: true });
    window.addEventListener("keyup", this.onKeyUp, { capture: true });
    window.addEventListener("blur", this.onBlur);
    document.addEventListener("visibilitychange", this.onVisibility);
    return () => {
      window.removeEventListener("keydown", this.onKeyDown, { capture: true });
      window.removeEventListener("keyup", this.onKeyUp, { capture: true });
      window.removeEventListener("blur", this.onBlur);
      document.removeEventListener("visibilitychange", this.onVisibility);
      this.release();
    };
  }
}
