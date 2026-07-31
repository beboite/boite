import type { FastpickModel } from "$lib/backend/types";
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

/**
 * What each model in a list reads as in the menu, keyed by its id.
 *
 * A label is fastpick's when it has one, but labels come from a hand-written config and
 * nothing there enforces that two of them differ: `claude-opus-5` and `claude-opus-5[1m]`
 * are two different context windows, and both were once labelled "Opus 5". Two rows that
 * launch different things and read identically are worse than a raw id, so a label shared
 * by more than one model loses to the id, for every model wearing it.
 *
 * Sharing is judged on how a row reads, not on how the string is spelled: the menu draws
 * labels as HTML, which collapses runs of whitespace, and nobody tells "Opus 5" from
 * "opus 5" at a glance either. Only the comparison is flattened, the label is drawn as
 * the config wrote it.
 */
export function modelLabels(items: readonly FastpickModel[]): Map<string, string> {
  const counts = new Map<string, number>();
  const idCounts = new Map<string, number>();
  for (const model of items) {
    const key = labelKey(modelLabel(model));
    counts.set(key, (counts.get(key) ?? 0) + 1);
    idCounts.set(model.id, (idCounts.get(model.id) ?? 0) + 1);
  }

  const labels = new Map<string, string>();
  for (const model of items) {
    const label = modelLabel(model);
    // Two entries under one id are a broken config, and this map has no room to tell them
    // apart: the second write would hand its label to both rows, which is the identical
    // pair this function exists to prevent, arrived at silently. They launch the same
    // `--model` anyway, so the id is the only thing said about them that is true of both.
    if ((idCounts.get(model.id) ?? 0) > 1) labels.set(model.id, model.id);
    else labels.set(model.id, counts.get(labelKey(label)) === 1 ? label : model.id);
  }
  return labels;
}

/** A label that is absent, or whitespace pretending not to be, is no label at all. */
function modelLabel(model: FastpickModel): string {
  return model.label?.trim() || model.id;
}

/** What the eye compares once the browser and the reader are done with the string. */
function labelKey(label: string): string {
  return label.replace(/\s+/g, " ").toLowerCase();
}

/** How a combo reads in a tooltip or a sidebar row: the model, then where it runs. */
export function comboLabel(combo: FastpickCombo): string {
  return `${combo.model} · ${combo.provider}`;
}
