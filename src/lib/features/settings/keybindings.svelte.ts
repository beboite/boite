import { settings } from "./store.svelte";
import { KEY_COMMAND_BY_ID } from "$lib/shared/keyboard/commands";
import { normalizeCombo, parseCombo } from "$lib/shared/keyboard/combo";
import { DEFAULT_KEYBINDINGS } from "$lib/shared/keyboard/defaults";
import {
  defaultsForCommand,
  resetCommand,
  setCommandKey,
} from "$lib/shared/keyboard/merge";
import type { CompiledRule, Keybinding } from "$lib/shared/keyboard/types";
import { compileWhen, whenOverlaps } from "$lib/shared/keyboard/when";

export interface KeyConflict {
  /** The other command claiming the same key where the two clauses meet. */
  other: string;
  key: string;
  /** True when the other rule is later in the set, so it is the one that runs. */
  shadowed: boolean;
}

function compile(bindings: Keybinding[]): CompiledRule[] {
  return bindings.map((binding) => {
    const clause = compileWhen(binding.when);
    return {
      binding,
      combo: parseCombo(binding.key),
      test: clause.test,
      valid: clause.ok,
      allowInInput: KEY_COMMAND_BY_ID[binding.command]?.allowInInput === true,
    };
  });
}

/**
 * The user's rules, compiled once per change.
 *
 * The dispatcher reads `rules` on every keystroke including the ones headed for
 * a terminal, so the parsing has to sit behind a rune rather than inside the
 * listener. Everything else here is for the settings editor and is derived
 * lazily, which is why the O(n²) conflict scan costs nothing until that tab is
 * on screen.
 */
class KeybindingStore {
  /**
   * The command whose combo the settings editor is waiting for, or null.
   *
   * It lives on the store rather than in the component because the dispatcher
   * has to see it: while it is set the global shortcuts stand down, or pressing
   * Ctrl+T to bind it would open a terminal instead.
   */
  recording = $state<string | null>(null);

  readonly all = $derived(settings.state.keybindings);
  readonly rules = $derived.by(() => compile(settings.state.keybindings));

  readonly byCommand = $derived.by(() => {
    const map: Record<string, Keybinding[]> = {};
    for (const binding of this.all) {
      (map[binding.command] ??= []).push(binding);
    }
    return map;
  });

  readonly conflicts = $derived.by(() => {
    const map: Record<string, KeyConflict[]> = {};
    const list = this.all;
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        const a = list[i];
        const b = list[j];
        if (a.command === b.command) continue;
        if (normalizeCombo(a.key) !== normalizeCombo(b.key)) continue;
        if (!whenOverlaps(a.when, b.when)) continue;
        (map[a.command] ??= []).push({ other: b.command, key: a.key, shadowed: true });
        (map[b.command] ??= []).push({ other: a.command, key: b.key, shadowed: false });
      }
    }
    return map;
  });

  /** Whether this command still sits exactly where the defaults put it. */
  isDefault(command: string): boolean {
    const mine = this.byCommand[command] ?? [];
    const shipped = defaultsForCommand(command);
    if (mine.length !== shipped.length) return false;
    return mine.every(
      (b, i) =>
        normalizeCombo(b.key) === normalizeCombo(shipped[i].key) &&
        (b.when ?? "") === (shipped[i].when ?? ""),
    );
  }

  get customized(): boolean {
    return Object.keys(KEY_COMMAND_BY_ID).some((id) => !this.isDefault(id));
  }

  setKey(command: string, key: string) {
    void settings.setKeybindings(setCommandKey(this.all, command, key));
  }

  reset(command: string) {
    void settings.setKeybindings(resetCommand(this.all, command));
  }

  resetAll() {
    void settings.setKeybindings(DEFAULT_KEYBINDINGS.map((b) => ({ ...b })));
  }
}

export const keybindings = new KeybindingStore();
