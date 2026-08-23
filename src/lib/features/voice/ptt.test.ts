import { describe, expect, it, vi } from "vitest";
import { PushToTalk, shouldSpeak } from "./ptt.svelte";

// No audio anywhere in here: `shouldSpeak` is the rule table and PushToTalk is
// a key machine, both driven with plain objects. The engines stay untouched.

const aloud = { role: "orchestrator", aloud: "done" };

describe("shouldSpeak", () => {
  const base = {
    enabled: true,
    voiceName: "Amelie",
    focused: true,
    speakWhenUnfocused: false,
  };

  it("speaks the orchestrator's aloud line when everything is armed", () => {
    expect(shouldSpeak(aloud, base)).toBe(true);
  });

  it("never speaks with the experiment or the engine off", () => {
    expect(shouldSpeak(aloud, { ...base, enabled: false })).toBe(false);
  });

  it("refuses without an explicitly picked voice, no fallback", () => {
    expect(shouldSpeak(aloud, { ...base, voiceName: null })).toBe(false);
  });

  it("never reads the user's own lines back", () => {
    expect(shouldSpeak({ role: "user", aloud: "hm" }, base)).toBe(false);
  });

  it("stays silent when there is no aloud field", () => {
    expect(shouldSpeak({ role: "orchestrator", aloud: null }, base)).toBe(false);
    expect(shouldSpeak({ role: "orchestrator", aloud: "  " }, base)).toBe(false);
  });

  it("follows the eyes: unfocused is silent unless the user said otherwise", () => {
    expect(shouldSpeak(aloud, { ...base, focused: false })).toBe(false);
    expect(
      shouldSpeak(aloud, { ...base, focused: false, speakWhenUnfocused: true }),
    ).toBe(true);
  });
});

type KeyShape = Partial<KeyboardEvent> & { preventDefault?: () => void };

function key(shape: KeyShape): KeyboardEvent {
  return {
    code: "",
    key: "",
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    repeat: false,
    preventDefault: () => {},
    ...shape,
  } as KeyboardEvent;
}

const hold = key({ code: "Space", ctrlKey: true });

describe("PushToTalk", () => {
  function machine() {
    const begin = vi.fn();
    const end = vi.fn();
    return { ptt: new PushToTalk(begin, end), begin, end };
  }

  it("begins on Ctrl+Space down and ends when either half comes up", () => {
    const { ptt, begin, end } = machine();
    ptt.onKeyDown(hold);
    expect(begin).toHaveBeenCalledTimes(1);
    ptt.onKeyUp(key({ key: "Control" }));
    expect(end).toHaveBeenCalledTimes(1);
  });

  it("ignores auto-repeat while held", () => {
    const { ptt, begin } = machine();
    ptt.onKeyDown(hold);
    ptt.onKeyDown(key({ code: "Space", ctrlKey: true, repeat: true }));
    ptt.onKeyDown(hold);
    expect(begin).toHaveBeenCalledTimes(1);
  });

  it("leaves every other chord alone", () => {
    const { ptt, begin } = machine();
    ptt.onKeyDown(key({ code: "Space" }));
    ptt.onKeyDown(key({ code: "Space", ctrlKey: true, shiftKey: true }));
    ptt.onKeyDown(key({ code: "KeyA", ctrlKey: true }));
    expect(begin).not.toHaveBeenCalled();
  });

  it("a lost keyup (blur) releases the microphone", () => {
    const { ptt, end } = machine();
    ptt.onKeyDown(hold);
    ptt.onBlur();
    expect(end).toHaveBeenCalledTimes(1);
    // And a release with nothing held stays quiet.
    ptt.onBlur();
    expect(end).toHaveBeenCalledTimes(1);
  });
});
