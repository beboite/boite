import { describe, expect, it } from "vitest";
import { keyIntent, type KeyContext } from "./key-intent";

type Key = Parameters<typeof keyIntent>[0];

function press(code: string, mods: Partial<Key> = {}): Key {
  return {
    type: "keydown",
    code,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    ...mods,
  };
}

const WINDOWS: KeyContext = { isMacOS: false, hasSelection: () => false };
const MAC: KeyContext = { isMacOS: true, hasSelection: () => false };
const SELECTED: KeyContext = { isMacOS: false, hasSelection: () => true };

describe("Ctrl+C", () => {
  it("interrupts when nothing is selected", () => {
    // The only way to stop a runaway process. Swallowing it to copy an empty
    // selection would leave a user watching an agent they cannot stop.
    expect(keyIntent(press("KeyC", { ctrlKey: true }), WINDOWS, false)).toBe("pass");
  });

  it("copies when something is selected, and clears it after", () => {
    // Clearing is what makes the next press an interrupt again. Without it a
    // selection left behind turns Ctrl+C into a key that copies forever.
    expect(keyIntent(press("KeyC", { ctrlKey: true }), SELECTED, false)).toBe("copy-and-clear");
  });

  it("copies unconditionally with Shift, selection or not", () => {
    expect(keyIntent(press("KeyC", { ctrlKey: true, shiftKey: true }), WINDOWS, false)).toBe("copy");
    expect(keyIntent(press("KeyC", { ctrlKey: true, shiftKey: true }), SELECTED, false)).toBe("copy");
  });

  it("leaves Ctrl+Alt+C to the shell", () => {
    // A third modifier is somebody else's binding, and guessing at it would
    // take a key combination away from whatever is running.
    expect(
      keyIntent(press("KeyC", { ctrlKey: true, altKey: true }), SELECTED, false),
    ).toBe("pass");
  });
});

describe("the command palette combos", () => {
  it("swallows Ctrl+K on Windows and Linux", () => {
    expect(keyIntent(press("KeyK", { ctrlKey: true }), WINDOWS, false)).toBe("swallow");
  });

  it("leaves Ctrl+K to the shell on macOS", () => {
    // The palette is Cmd+K there, and Ctrl+K is readline's kill-line. Taking it
    // would break editing a command in every shell on the machine.
    expect(keyIntent(press("KeyK", { ctrlKey: true }), MAC, false)).toBe("pass");
    expect(keyIntent(press("KeyK", { metaKey: true }), MAC, false)).toBe("swallow");
  });

  it("does not swallow Cmd+K on Windows, where nothing sends it", () => {
    expect(keyIntent(press("KeyK", { metaKey: true }), WINDOWS, false)).toBe("pass");
  });

  it("swallows Ctrl+Shift+P everywhere", () => {
    expect(keyIntent(press("KeyP", { ctrlKey: true, shiftKey: true }), WINDOWS, false)).toBe(
      "swallow",
    );
    expect(keyIntent(press("KeyP", { ctrlKey: true, shiftKey: true }), MAC, false)).toBe("swallow");
  });
});

describe("the rest", () => {
  it("pastes on either paste combo", () => {
    expect(keyIntent(press("KeyV", { ctrlKey: true }), WINDOWS, false)).toBe("paste");
    expect(keyIntent(press("KeyV", { ctrlKey: true, shiftKey: true }), WINDOWS, false)).toBe(
      "paste",
    );
  });

  it("restores the last closed thread on Ctrl+Shift+T", () => {
    expect(keyIntent(press("KeyT", { ctrlKey: true, shiftKey: true }), WINDOWS, false)).toBe(
      "restore-thread",
    );
  });

  it("sends a line feed only when the caller already decided one is due", () => {
    // Whether Shift+Enter is a line feed depends on which agent is running and
    // on a setting, so it is not something the keyboard can answer.
    expect(keyIntent(press("Enter", { shiftKey: true }), WINDOWS, true)).toBe("line-feed");
    expect(keyIntent(press("Enter", { shiftKey: true }), WINDOWS, false)).toBe("pass");
  });

  it("a shortcut wins over a line feed", () => {
    // Both can be true at once. The shortcut is the one the user pressed a
    // modifier for.
    expect(keyIntent(press("KeyV", { ctrlKey: true }), WINDOWS, true)).toBe("paste");
  });

  it("ignores anything that is not a keydown", () => {
    // keyup and keypress arrive here too, and acting on them fires every
    // shortcut twice.
    expect(keyIntent({ ...press("KeyC", { ctrlKey: true }), type: "keyup" }, SELECTED, true)).toBe(
      "pass",
    );
  });

  it("hands an ordinary key straight to the shell", () => {
    expect(keyIntent(press("KeyA"), WINDOWS, false)).toBe("pass");
    expect(keyIntent(press("KeyC"), WINDOWS, false)).toBe("pass");
  });
});
