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

/** The agent line inside a command, with its combo already read off it. */
function read(
  command: string,
): { line: string; combo: FastpickCombo | null } | null {
  const parsed = parseCommand(command);
  if (!parsed.cmd) return null;
  const inner = unwrapShell(parsed.cmd, parsed.args);
  return {
    line: [inner.cmd, ...inner.args].join(" "),
    combo: parseCombo(inner.cmd, inner.args),
  };
}

/**
 * The driver a command would run on, or null when nothing here names an agent.
 *
 * A fastpick combo names its harness, which is the driver: a claude answering
 * on another endpoint is still the stream-json wire. Anything else falls back
 * to the CLI preset, which is what a plain `claude` row is.
 */
export function driverOfCommand(command: string): string | null {
  const inner = read(command);
  if (!inner) return null;
  if (inner.combo) return inner.combo.harness || null;
  return findPresetForCommand(inner.line)?.id ?? null;
}

/** The fastpick route a command carries, or null for a native launch. */
export function comboOfCommand(command: string): FastpickCombo | null {
  return read(command)?.combo ?? null;
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
  const inner = read(command);
  if (!inner) return null;
  const combo = inner.combo;
  const driver = combo ? combo.harness || null : findPresetForCommand(inner.line)?.id ?? null;
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

/** The `pilotOptions` column: the JSON `boite_pilot::Options` deserialises. */
export function optionsJson(mode: PilotExecMode): string {
  return JSON.stringify({ effort: null, mode });
}
