import { describe, expect, it } from "vitest";
import { DEFAULT_KEYBINDINGS } from "./defaults";
import {
  defaultsForCommand,
  mergeDefaultKeybindings,
  resetCommand,
  sanitizeKeybindings,
  setCommandKey,
} from "./merge";
import { KEY_COMMAND_BY_ID } from "./commands";
import { parseWhen } from "./when";
import type { Keybinding } from "./types";

const DEFAULTS: Keybinding[] = [
  { key: "mod+t", command: "thread.new", when: "!overlayOpen" },
  { key: "mod+k", command: "palette.toggle", when: "!modalOpen" },
  { key: "mod+shift+p", command: "palette.toggle", when: "!modalOpen" },
];

describe("sanitizeKeybindings", () => {
  it("tells no stored set apart from an empty one", () => {
    expect(sanitizeKeybindings(undefined)).toBeNull();
    expect(sanitizeKeybindings("[]")).toBeNull();
    expect(sanitizeKeybindings([])).toEqual([]);
  });

  it("drops anything that is not a rule", () => {
    expect(
      sanitizeKeybindings([
        null,
        42,
        { key: "mod+t" },
        { command: "thread.new" },
        { key: "  ", command: "thread.new" },
        { key: "mod+t", command: "thread.new", when: 7 },
      ]),
    ).toEqual([{ key: "mod+t", command: "thread.new", when: undefined }]);
  });

  it("trims and drops an empty clause", () => {
    expect(sanitizeKeybindings([{ key: " mod+t ", command: " thread.new ", when: " " }])).toEqual(
      [{ key: "mod+t", command: "thread.new", when: undefined }],
    );
  });
});

describe("mergeDefaultKeybindings", () => {
  it("seeds the whole table when nothing is stored", () => {
    const { bindings, changed } = mergeDefaultKeybindings(null, DEFAULTS);
    expect(changed).toBe(true);
    expect(bindings).toEqual(DEFAULTS);
    expect(bindings[0]).not.toBe(DEFAULTS[0]);
  });

  it("is idempotent once the set has been written", () => {
    const first = mergeDefaultKeybindings(null, DEFAULTS).bindings;
    const second = mergeDefaultKeybindings(first, DEFAULTS);
    expect(second.changed).toBe(false);
    expect(second.bindings).toEqual(first);
  });

  it("keeps both defaults on one command on a first run", () => {
    // Claims are read off the incoming set, never off the growing result, or
    // the palette's second key would be swallowed by its first.
    const { bindings } = mergeDefaultKeybindings(null, DEFAULTS);
    expect(bindings.filter((b) => b.command === "palette.toggle")).toHaveLength(2);
  });

  it("adds a newly shipped default to an existing set", () => {
    const user: Keybinding[] = [{ key: "mod+t", command: "thread.new" }];
    const { bindings, changed } = mergeDefaultKeybindings(user, [
      ...DEFAULTS,
      { key: "mod+j", command: "thread.next" },
    ]);
    expect(changed).toBe(true);
    expect(bindings.map((b) => b.command)).toEqual([
      "thread.new",
      "palette.toggle",
      "palette.toggle",
      "thread.next",
    ]);
  });

  it("never touches a rule the user already has", () => {
    const user: Keybinding[] = [
      { key: "mod+j", command: "thread.new", when: "terminalFocus" },
    ];
    const { bindings } = mergeDefaultKeybindings(user, DEFAULTS);
    expect(bindings[0]).toEqual(user[0]);
  });

  it("skips a default whose command the user already claims", () => {
    const user: Keybinding[] = [{ key: "mod+j", command: "thread.new" }];
    const { bindings } = mergeDefaultKeybindings(user, DEFAULTS);
    expect(bindings.filter((b) => b.command === "thread.new")).toHaveLength(1);
    expect(bindings[0].key).toBe("mod+j");
  });

  it("skips a default whose key the user already claims for something else", () => {
    // Handing Ctrl+T to another command means Ctrl+T is spoken for, and the
    // shipped rule must not be quietly added underneath it.
    const user: Keybinding[] = [{ key: "mod+t", command: "view.toggleSettings" }];
    const { bindings } = mergeDefaultKeybindings(user, DEFAULTS);
    expect(bindings.some((b) => b.command === "thread.new")).toBe(false);
  });

  it("compares keys by spelling, not by string", () => {
    const user: Keybinding[] = [{ key: "Shift+Mod+P", command: "view.toggleSettings" }];
    const { bindings } = mergeDefaultKeybindings(user, DEFAULTS);
    expect(bindings.filter((b) => b.key === "mod+shift+p")).toHaveLength(0);
  });

  it("appends rather than prepends, so a user rule stays in front of a newcomer", () => {
    // Last match wins, so position is the whole of what makes an override work
    // and a merge that unshifted would silently reverse every override.
    const user: Keybinding[] = [{ key: "mod+q", command: "thread.new" }];
    const { bindings } = mergeDefaultKeybindings(user, [
      { key: "mod+j", command: "view.toggleSidebar" },
    ]);
    expect(bindings.map((b) => b.command)).toEqual(["thread.new", "view.toggleSidebar"]);
  });
});

describe("setCommandKey and resetCommand", () => {
  it("moves a command to the end so it beats what it shadows", () => {
    const next = setCommandKey(DEFAULTS, "thread.new", "mod+q");
    expect(next.at(-1)).toEqual({ key: "mod+q", command: "thread.new", when: "!overlayOpen" });
    expect(next.filter((b) => b.command === "thread.new")).toHaveLength(1);
  });

  it("puts a command back the way it shipped, both of its keys included", () => {
    const rebound = setCommandKey(DEFAULTS, "palette.toggle", "mod+p");
    expect(rebound.filter((b) => b.command === "palette.toggle")).toHaveLength(1);
    const back = resetCommand(rebound, "palette.toggle", DEFAULTS);
    expect(back.filter((b) => b.command === "palette.toggle")).toEqual(
      defaultsForCommand("palette.toggle", DEFAULTS),
    );
  });

  it("leaves a command the defaults never bound unbound", () => {
    expect(resetCommand(DEFAULTS, "thread.new", []).some((b) => b.command === "thread.new")).toBe(
      false,
    );
  });
});

describe("the shipped table", () => {
  it("only names commands the catalogue knows", () => {
    for (const binding of DEFAULT_KEYBINDINGS) {
      expect(KEY_COMMAND_BY_ID[binding.command], binding.command).toBeDefined();
    }
  });

  it("carries a clause that parses on every rule", () => {
    for (const binding of DEFAULT_KEYBINDINGS) {
      expect(parseWhen(binding.when), binding.key).not.toBeNull();
    }
  });

  it("hands no key to two commands in the same context", () => {
    const seen = new Map<string, string>();
    for (const binding of DEFAULT_KEYBINDINGS) {
      const slot = `${binding.key}::${binding.when ?? ""}`;
      const other = seen.get(slot);
      expect(other === undefined || other === binding.command, slot).toBe(true);
      seen.set(slot, binding.command);
    }
  });
});
