/**
 * Reading a launcher row as a chat launch, and making the thread.
 *
 * Every way into a thread goes through a shortcut whose command names an agent
 * (`shortcut/agent-hint.ts` already peels the shell wrapper and the fastpick
 * combo off one). This turns that same command into the four columns a
 * `runtime = pilot` row carries, so the home card, the sidebar launcher, the
 * palette and the phone's sheet all decide with one function rather than four
 * ideas of which preset has a driver.
 *
 * The driver id is not the preset id by accident: `pilot.catalog` names its
 * drivers with the same words `cliPresets.ts` does (`claude`, later `codex`),
 * which is what lets the answer be a lookup instead of a table that drifts.
 */

import { parseCombo, type FastpickCombo } from "$lib/features/fastpick/combo";
import { findPresetForCommand, hasYoloFlag } from "$lib/features/settings/cliPresets";
import { parseCommand } from "$lib/features/settings/store.svelte";
import type { PilotCatalog, PilotExecMode, PilotInstance } from "./types";

/** Everything the create path needs to write a pilot row, off one command. */
export interface ChatLaunch {
  driver: string;
  instance: PilotInstance;
  model: string | null;
  mode: PilotExecMode;
}

/**
 * The pilot driver a fastpick harness runs on, where the two are not one word.
 *
 * fastpick names the harness after the program (`claude-code`), `pilot.catalog`
 * names the driver after the wire (`claude`), and the Rust side already stamps
 * `"driver": "claude"` on every fastpick instance it answers with. Without this
 * a route picked in the fastpick menu asked the catalog for a driver called
 * `claude-code`, got no, and the Chat button was greyed on every fastpick row
 * there is. Anything not listed is its own driver, which is what a harness
 * named after the wire already is.
 */
const DRIVER_OF_HARNESS: Record<string, string> = {
  "claude-code": "claude",
};

const SHELL_CMD = /(?:^|[\\/])(?:pwsh|powershell|cmd|bash|zsh|sh)(?:\.exe)?$/i;
const SKIP_FLAG = /^-nologo$/i;
const SKIP_PROFILE = /^-nop(?:rofile)?$/i;
const COMMAND_FLAG = /^-c$|^-command$/i;

/**
 * The agent inside a shell wrapper.
 *
 * Same peel as `shortcutAgentHint`, and deliberately a copy rather than an
 * import: that module is about the words a row shows, this one about the row a
 * launch writes, and folding them would make the hint depend on the catalog.
 */
function unwrapShell(cmd: string, args: string[]): { cmd: string; args: string[] } {
  if (!SHELL_CMD.test(cmd)) return { cmd, args };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (SKIP_FLAG.test(flag) || SKIP_PROFILE.test(flag) || flag === "/c" || flag === "/C") {
      continue;
    }
    if (COMMAND_FLAG.test(flag)) {
      const rest = args[i + 1];
      return rest ? parseCommand(rest) : { cmd, args };
    }
    return { cmd: flag, args: args.slice(i + 1) };
  }
  return { cmd, args };
}

/** The agent line inside an argv, with its combo already read off it. */
function read(
  cmd: string,
  args: readonly string[],
): { line: string; combo: FastpickCombo | null } | null {
  if (!cmd) return null;
  const inner = unwrapShell(cmd, [...args]);
  return {
    line: [inner.cmd, ...inner.args].join(" "),
    combo: parseCombo(inner.cmd, inner.args),
  };
}

/** The same, off a command line that has not been split yet. */
function readCommand(command: string): { line: string; combo: FastpickCombo | null } | null {
  const parsed = parseCommand(command);
  return read(parsed.cmd, parsed.args);
}

/**
 * The driver behind a fastpick harness, or the harness itself.
 *
 * One lookup rather than a branch per caller: `chatAvailable`, the launchers
 * and the spawn decision all ask the catalog with whatever this answers.
 */
export function driverOfHarness(harness: string): string | null {
  if (!harness) return null;
  return DRIVER_OF_HARNESS[harness] ?? harness;
}

/**
 * The driver a command would run on, or null when nothing here names an agent.
 *
 * A fastpick combo names its harness, which is the driver: a claude answering
 * on another endpoint is still the stream-json wire. Anything else falls back
 * to the CLI preset, which is what a plain `claude` row is.
 */
export function driverOfCommand(command: string): string | null {
  const parsed = parseCommand(command);
  return driverOfArgv(parsed.cmd, parsed.args);
}

/** The same answer, off an argv the caller already has in hand. */
export function driverOfArgv(cmd: string, args: readonly string[]): string | null {
  const inner = read(cmd, args);
  if (!inner) return null;
  if (inner.combo) return driverOfHarness(inner.combo.harness);
  return findPresetForCommand(inner.line)?.id ?? null;
}

/** The fastpick route a command carries, or null for a native launch. */
export function comboOfCommand(command: string): FastpickCombo | null {
  return readCommand(command)?.combo ?? null;
}

/**
 * Whether the catalog has a protocol for this driver.
 *
 * Asked of the catalog rather than of a list here, so the day `codex` lands in
 * `boite-pilot` the launcher offers it with no edit on this side. A catalog
 * that has not answered yet says no, which greys the button rather than
 * offering a thread that cannot open.
 */
export function chatAvailable(catalog: PilotCatalog | null, driver: string | null): boolean {
  if (!catalog || !driver) return false;
  return catalog.drivers.some((entry) => entry.id === driver);
}

/**
 * What a chat launch off this command writes onto the row.
 *
 * The mode comes from the same yolo choice the terminal launch makes: the
 * shortcut's own command either carries the preset's yolo flag or it does not,
 * and reading it here is what keeps one shortcut meaning one thing whichever
 * runtime it is launched into. Effort is left empty: nothing in the launcher
 * asks for one, and the picker is where it is chosen.
 */
export function chatLaunchFor(command: string): ChatLaunch | null {
  const parsed = parseCommand(command);
  return chatLaunchForArgv(parsed.cmd, parsed.args);
}

/**
 * The same, off an argv rather than a line.
 *
 * The argv is what a spawn and the fastpick menu hold, and joining it back into
 * a string to split it again loses any argument with a space in it.
 */
export function chatLaunchForArgv(cmd: string, args: readonly string[]): ChatLaunch | null {
  const inner = read(cmd, args);
  if (!inner) return null;
  const combo = inner.combo;
  const driver = combo
    ? driverOfHarness(combo.harness)
    : findPresetForCommand(inner.line)?.id ?? null;
  if (!driver) return null;
  const preset = findPresetForCommand(inner.line) ?? null;
  const yolo = preset ? hasYoloFlag(inner.line, preset.yoloFlag) : false;
  return {
    driver,
    instance: combo
      ? { type: "fastpick", provider: combo.provider, model: combo.model }
      : { type: "native" },
    model: combo?.model ?? null,
    mode: yolo ? "yolo" : "ask",
  };
}

/**
 * What a spawn asking for `runtime = pilot` gets, or the sentence refusing it.
 *
 * A pure function, and deliberately so: this is the one decision in the spawn
 * path an agent can get wrong from the outside, and every refusal is a sentence
 * that agent reads instead of a thread it cannot use. `handleSpawn` does the
 * work, this says which work.
 *
 * The refusals are all one shape: what was asked for, why it cannot happen, and
 * the one thing to ask for instead. An agent that reads "no" and nothing else
 * asks again the same way.
 */
export type SpawnDecision =
  | { kind: "terminal" }
  | { kind: "chat"; launch: ChatLaunch }
  | { kind: "refused"; reason: string };

export function chatSpawnDecision(input: {
  /** What the request asked for. Anything but `pilot` is the terminal path. */
  runtime: string | null | undefined;
  /** The worker's own argv, after the unattended flags were added. */
  cmd: string;
  args: readonly string[];
  /** What the agent called itself, for the refusal sentence. */
  agent: string;
  catalog: PilotCatalog | null;
  /** `settings.state.experimentPilot`: chat threads are still an experiment. */
  experiment: boolean;
}): SpawnDecision {
  if (input.runtime !== "pilot") return { kind: "terminal" };
  if (!input.experiment) {
    return {
      kind: "refused",
      reason:
        "CHAT_OFF: chat threads are off in this Boite. Ask for runtime 'terminal', or ask the \
user to turn the chat threads experiment on.",
    };
  }
  const launch = chatLaunchForArgv(input.cmd, input.args);
  if (!launch || !chatAvailable(input.catalog, launch.driver)) {
    const named = launch?.driver ?? input.agent;
    return {
      kind: "refused",
      reason: `NO_DRIVER: nothing here talks to ${named} over its own protocol, so it cannot be \
a chat thread. Ask for runtime 'terminal'.`,
    };
  }
  return { kind: "chat", launch };
}

/** The `pilotOptions` column: the JSON `boite_pilot::Options` deserialises. */
export function optionsJson(mode: PilotExecMode): string {
  return JSON.stringify({ effort: null, mode });
}
