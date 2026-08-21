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
  /**
   * Which credential of that provider, when it holds more than one. The id alone, without
   * the `<provider>.` prefix `--key` is written with: the provider is already named here,
   * and carrying it twice is a second place for the two to disagree.
   *
   * Undefined or null means the provider resolves it, which is what a single-key provider
   * does and what every combo written before schema 3 says.
   */
  key?: string | null;
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

/**
 * Whether this command is fastpick, however it happens to be spelled.
 *
 * On the binary name rather than on the whole string, because the three things
 * that decide a thread's `cmd` do not agree on how to write it: the menu writes
 * `fastpick`, a shortcut carries whatever the user typed, which on Windows is
 * routinely `fastpick.exe` or a full path, and a process promoting its own
 * thread writes whatever it printed.
 *
 * **An exact match called two of those three a different program, and that was
 * not a cosmetic failure.** `splitArgv` reads this to decide whether a thread
 * has two argument regions, so a thread launched as `fastpick.exe` got no `--`
 * written, and codex's `-c mcp_servers.boite.command=…` landed in front of it,
 * where fastpick claims `-c` for its own `--config`. The launch then died
 * trying to create a file named after a TOML assignment, which on Windows is
 * `os error 123`: the quote and the equals sign are not allowed in a filename.
 */
export function isFastpick(cmd: string): boolean {
  const last = cmd.trim().split(/[/\\]/).pop() ?? "";
  const dot = last.lastIndexOf(".");
  const stem = dot > 0 ? last.slice(0, dot) : last;
  return stem.toLowerCase() === FASTPICK_CMD;
}

/**
 * The harness ids fastpick answers to.
 *
 * It is read to tell a name that opens with a harness from one whose model holds a colon,
 * so a harness fastpick grows is a provider here until this list learns it. That way round
 * on purpose: an unknown first word reaches fastpick as a provider and is refused there,
 * where guessing would have cut the model in half and launched something else.
 */
const HARNESS_IDS = ["claude-code", "opencode", "codex", "pi"];

/**
 * The combo an agent asked for by name, or null when the name is not a fastpick one.
 *
 * `fastpick:<provider>[.<key>]:<model>`, with an optional harness in front of the provider.
 * Omitted, the harness is claude-code: that is what every three-part name written before
 * this meant, and the one every provider in the catalogue answers on.
 */
export function parseFastpickAgent(agent: string): FastpickCombo | null {
  const parts = agent.trim().toLowerCase().split(":");
  if (parts.shift() !== FASTPICK_CMD) return null;

  let harness = "claude-code";
  if (parts.length > 2 && HARNESS_IDS.includes(parts[0])) harness = parts.shift() ?? harness;

  const where = parts.shift() ?? "";
  // Rejoined rather than taken at [1]: a model id is allowed to hold colons, and cutting
  // at the first one would launch a model that does not exist.
  const model = parts.join(":");

  // `<provider>.<key>` picks one credential of a provider that holds several, written the
  // way fastpick's own `--key` takes it. Without it a site reached with two accounts
  // answers on whichever fastpick resolves first, which is not always the one the caller
  // meant and not always the one being paid for.
  const dot = where.indexOf(".");
  const provider = dot > 0 ? where.slice(0, dot) : where;
  const key = dot > 0 ? where.slice(dot + 1) : null;
  if (!provider || !model) return null;

  return { harness, provider, key, model };
}

/** Which agent a harness kind is, for the icon and everything else keyed on it. */
export function iconKeyForKind(kind: string): IconKey {
  switch (kind) {
    case "claude-code":
      return "claude";
    case "opencode":
      return "opencode";
    case "codex":
      return "codex";
    case "pi":
      return "pi";
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
  // `--key` names the provider too, so it makes `--provider` redundant rather than
  // conflicting, and both are written: the pair is what `parseCombo` reads back.
  //
  // Only ever set from a listing that declared several keys, which is a fastpick that knows
  // the flag. A fastpick that did not would forward `--key` to the agent instead of
  // refusing it, the way it forwards everything it does not recognise.
  if (combo.key) args.push("--key", `${combo.provider}.${combo.key}`);
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
  if (!isFastpick(cmd)) return null;

  let harness: string | null = null;
  let provider: string | null = null;
  let key: string | null = null;
  let model: string | null = null;
  let effort: string | null = null;
  let prompts: string[] | undefined;

  for (let i = 0; i < args.length; i++) {
    const value = args[i + 1];
    // Everything past the separator belongs to the agent fastpick launches, and
    // reading it here would let one of its flags rename the combo: a resumed
    // codex thread carries `-m <model>` of its own, and a hand-typed passthrough
    // carries whatever the user wrote. fastpick stops at the same place.
    if (args[i] === "--") break;
    switch (args[i]) {
      case "--harness":
        harness = value ?? null;
        i++;
        break;
      case "--provider":
        provider = value ?? null;
        i++;
        break;
      // `--key` is written `<provider>.<key>` and names the provider on its own, so a
      // thread typed by hand may carry it without `--provider`. Both halves are read: the
      // provider only when nothing else said it, the key always.
      case "--key": {
        if (value !== undefined) {
          const dot = value.indexOf(".");
          if (dot < 0) key = value;
          else {
            provider ??= value.slice(0, dot);
            key = value.slice(dot + 1);
          }
        }
        i++;
        break;
      }
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
  return { harness, provider, key, model, effort, prompts };
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
  const bump = (key: string) => counts.set(key, (counts.get(key) ?? 0) + 1);
  for (const model of items) {
    const label = labelKey(modelLabel(model));
    const id = labelKey(model.id);
    bump(label);
    // The id counts too, because it is what a model that loses its label falls
    // back to and therefore what it will read as. Counting labels alone made
    // this a single pass: a pair sharing "Opus 5" both dropped to their ids, and
    // a third model whose config labelled it `claude-opus-5` by hand then read
    // identically to one of them, which is the collision this exists to prevent.
    if (id !== label) bump(id);
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

/**
 * How a combo reads in a tooltip or a sidebar row: the model, then where it runs.
 *
 * The credential is part of where it runs when there is one, two keys of a site being two
 * different accounts and often two different bills. It is left out when it repeats the
 * provider, which is what a single-key provider names its only key.
 */
export function comboLabel(combo: FastpickCombo): string {
  const where =
    combo.key && combo.key !== combo.provider
      ? `${combo.provider}.${combo.key}`
      : combo.provider;
  return `${combo.model} · ${where}`;
}
