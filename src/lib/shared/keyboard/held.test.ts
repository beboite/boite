import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JUMP_SLOTS, JumpModifier, jumpDigit } from "./held.svelte";

describe("which row a digit reaches", () => {
  it("numbers from one, not from zero", () => {
    expect(jumpDigit(0)).toBe(1);
    expect(jumpDigit(8)).toBe(9);
  });

  /**
   * Ctrl+0 is reset zoom, so there is no tenth slot to give away. A row past
   * the ninth wears nothing rather than a number that does nothing, which is
   * the whole failure this hint exists to fix.
   */
  it("stops at the ninth", () => {
    expect(jumpDigit(JUMP_SLOTS)).toBeNull();
    expect(jumpDigit(40)).toBeNull();
  });
});

interface FakeKeyInit {
  key?: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  alt?: boolean;
  repeat?: boolean;
}

// A plain object on purpose: the machine reads five booleans off the event and
// nothing else, so this is exactly what a real one looks like to it.
function key(init: FakeKeyInit): KeyboardEvent {
  return {
    key: init.key ?? "Control",
    ctrlKey: init.ctrl ?? false,
    metaKey: init.meta ?? false,
    shiftKey: init.shift ?? false,
    altKey: init.alt ?? false,
    repeat: init.repeat ?? false,
  } as unknown as KeyboardEvent;
}

/** Past the dwell, with room to spare. */
const HELD = 400;

describe("the jump modifier being held", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  /** Windows and Linux: the jump key is Ctrl. */
  const pc = () => new JumpModifier(false);

  it("waits out the dwell before lighting anything", () => {
    const m = pc();
    m.onKeyDown(key({ ctrl: true }));
    expect(m.down).toBe(false);
    vi.advanceTimersByTime(HELD);
    expect(m.down).toBe(true);
  });

  it("stays dark under a chord that comes and goes inside the dwell", () => {
    // mod+k opens the palette. It starts with the same key down, and before the
    // dwell existed it numbered the whole sidebar behind the palette.
    const m = pc();
    m.onKeyDown(key({ ctrl: true }));
    vi.advanceTimersByTime(50);
    m.onKeyDown(key({ key: "k", ctrl: true }));
    m.onKeyUp(key({ key: "k", ctrl: true }));
    m.onKeyUp(key({ key: "Control" }));
    vi.advanceTimersByTime(HELD);
    expect(m.down).toBe(false);
  });

  it("survives the auto-repeat a held modifier delivers", () => {
    // Regression: Chromium repeats a lone modifier keydown for as long as it is
    // held, and answering those events blanked the numbers half a second into
    // every hold, which is the one case the hint exists for.
    const m = pc();
    m.onKeyDown(key({ ctrl: true }));
    vi.advanceTimersByTime(HELD);
    for (let i = 0; i < 5; i++) {
      m.onKeyDown(key({ ctrl: true, repeat: true }));
      vi.advanceTimersByTime(100);
    }
    expect(m.down).toBe(true);
  });

  it("goes out when the modifier comes up", () => {
    const m = pc();
    m.onKeyDown(key({ ctrl: true }));
    vi.advanceTimersByTime(HELD);
    m.onKeyUp(key({ key: "Control" }));
    expect(m.down).toBe(false);
  });

  it("ignores a keyup that still carries Alt, the way keydown does", () => {
    // AltGr on AZERTY and QWERTZ sets ctrlKey as well as altKey, so typing an
    // @ or a | in any input ends on a keyup with Ctrl apparently down. Keyup
    // used to take that at face value and number every thread row.
    const m = pc();
    m.onKeyUp(key({ key: "@", ctrl: true, alt: true }));
    vi.advanceTimersByTime(HELD);
    expect(m.down).toBe(false);
  });

  it("does not relight when a chord's letter comes up under its modifiers", () => {
    // Ctrl+Shift+P is on its way to a command. Releasing P leaves Ctrl+Shift
    // down, and the flash this whole guard exists to refuse came from there.
    const m = pc();
    m.onKeyDown(key({ key: "P", ctrl: true, shift: true }));
    m.onKeyUp(key({ key: "P", ctrl: true, shift: true }));
    vi.advanceTimersByTime(HELD);
    expect(m.down).toBe(false);
  });

  it("refuses Ctrl+Cmd on both edges off macOS", () => {
    // Not a jump key on the way down, so it may not become one on the way up.
    const m = pc();
    m.onKeyDown(key({ ctrl: true, meta: true }));
    vi.advanceTimersByTime(HELD);
    expect(m.down).toBe(false);
    m.onKeyUp(key({ key: "Meta", ctrl: true, meta: true }));
    vi.advanceTimersByTime(HELD);
    expect(m.down).toBe(false);
  });

  it("reads Command on a Mac and Ctrl nowhere else", () => {
    const mac = new JumpModifier(true);
    mac.onKeyDown(key({ key: "Meta", meta: true }));
    vi.advanceTimersByTime(HELD);
    expect(mac.down).toBe(true);
    // Ctrl on a Mac is readline's, never the jump key.
    const other = new JumpModifier(true);
    other.onKeyDown(key({ ctrl: true }));
    vi.advanceTimersByTime(HELD);
    expect(other.down).toBe(false);
  });

  it("gives up the hold when the window loses focus", () => {
    // Alt+Tab takes the keyup with it, and the numbers would stay lit over an
    // app nobody is using.
    const m = pc();
    m.onKeyDown(key({ ctrl: true }));
    vi.advanceTimersByTime(HELD);
    m.onBlur();
    expect(m.down).toBe(false);
  });

  it("drops a dwell still counting when focus goes", () => {
    const m = pc();
    m.onKeyDown(key({ ctrl: true }));
    m.onBlur();
    vi.advanceTimersByTime(HELD);
    expect(m.down).toBe(false);
  });

  it("gives it up when the window is hidden without a blur", () => {
    // A screen lock or an OS-level focus theft can hide the window while the
    // window itself hears nothing.
    const m = pc();
    m.onKeyDown(key({ ctrl: true }));
    vi.advanceTimersByTime(HELD);
    vi.stubGlobal("document", { hidden: true });
    m.onVisibility();
    expect(m.down).toBe(false);
  });

  it("leaves a hold alone when the window merely comes back", () => {
    const m = pc();
    m.onKeyDown(key({ ctrl: true }));
    vi.advanceTimersByTime(HELD);
    vi.stubGlobal("document", { hidden: false });
    m.onVisibility();
    expect(m.down).toBe(true);
  });
});
