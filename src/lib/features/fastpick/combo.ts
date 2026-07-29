import type { IconKey } from "$lib/types";

/**
 * One answer to fastpick's three questions, plus what it asks afterwards.
 *
 * This is the whole state a fastpick thread carries. It is never stored on its own row:
 * the thread's `cmd` and `args` already say it, and reading it back from them is what lets
 * a thread promoted by the process itself look exactly like one launched from the menu.
 */
export interface FastpickCombo {
  harness: string;
  provider: string;
  model: string;
  effort?: string | null;
  /**
   * System prompt files, as `--md` names. Undefined means "let fastpick choose", which is
   * what the picker does by default and what pressing Enter in fastpick's own menu does.
   * An empty array is the opposite and explicit: launch with none.
   */
  prompts?: string[];
}

export const FASTPICK_CMD = "fastpick";

/** Which agent a harness kind is, for the icon and everything else keyed on it. */
export function iconKeyForKind(kind: string): IconKey {
  switch (kind) {
    case "claude-code":
      return "claude";
    case "opencode":
      return "opencode";
    case "codex":
      return "codex";
    default:
      return null;
  }
}

/**
 * The command line that launches this combo with no menu.
 *
 * Naming all three answers is what makes fastpick resolve headlessly, so this is also what
 * a reload replays: the thread comes back on the same endpoint and the same model instead
 * of reopening a picker nobody asked for.
 */
export function comboArgs(combo: FastpickCombo): string[] {
  const args = [
    "--harness",
    combo.harness,
    "--provider",
    combo.provider,
    "--model",
    combo.model,
  ];
  if (combo.effort) args.push("--effort", combo.effort);
  if (combo.prompts) {
    // Passing nothing lets fastpick check the file matching the model. Saying "none" has
    // to be said, and `--md` with no value would be a parse error rather than a refusal.
    if (combo.prompts.length === 0) args.push("--no-md");
    else for (const name of combo.prompts) args.push("--md", name);
  }
  return args;
}

/**
 * The combo a thread is running, or null when it is not a fastpick thread.
 *
 * Read back from the command rather than stored beside it: a thread the user typed
 * `fastpick --harness ...` into by hand, and one a process promoted through the OSC
 * sequence, are then described exactly like one the picker launched.
 */
export function parseCombo(cmd: string, args: readonly string[]): FastpickCombo | null {
  if (cmd !== FASTPICK_CMD) return null;

  let harness: string | null = null;
  let provider: string | null = null;
  let model: string | null = null;
  let effort: string | null = null;
  let prompts: string[] | undefined;

  for (let i = 0; i < args.length; i++) {
    const value = args[i + 1];
    switch (args[i]) {
      case "--harness":
        harness = value ?? null;
        i++;
        break;
      case "--provider":
        provider = value ?? null;
        i++;
        break;
      case "--model":
        model = value ?? null;
        i++;
        break;
      case "--effort":
        effort = value ?? null;
        i++;
        break;
      case "--md":
        if (value !== undefined) (prompts ??= []).push(value);
        i++;
        break;
      case "--no-md":
        prompts = [];
        break;
    }
  }

  // Anything short of all three still opens a menu, so it is not a resolved combo and
  // describing it as one would put a model name in the UI that nothing confirmed.
  if (!harness || !provider || !model) return null;
  return { harness, provider, model, effort, prompts };
}

/** How a combo reads in a tooltip or a sidebar row: the model, then where it runs. */
export function comboLabel(combo: FastpickCombo): string {
  return `${combo.model} · ${combo.provider}`;
}
