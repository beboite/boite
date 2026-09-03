import { parseCombo, comboLabel } from "$lib/features/fastpick/combo";
import { findPresetForCommand } from "$lib/features/settings/cliPresets";
import { parseCommand } from "$lib/features/settings/store.svelte";

const SHELL_CMD = /(?:^|[\\/])(?:pwsh|powershell|cmd|bash|zsh|sh)(?:\.exe)?$/i;
const SKIP_FLAG = /^-nologo$/i;
const SKIP_PROFILE = /^-nop(?:rofile)?$/i;
const COMMAND_FLAG = /^-c$|^-command$/i;

function stem(cmd: string): string {
  const last = cmd.trim().split(/[/\\]/).pop() ?? cmd;
  const dot = last.lastIndexOf(".");
  return (dot > 0 ? last.slice(0, dot) : last);
}

/**
 * Peel a shell wrapper so the agent inside is what the row names.
 *
 * A shortcut's stored command is often `pwsh -NoLogo -NoProfile -Command …`,
 * and showing those flags next to every "Launch X" row is what the palette
 * used to do. The inner argv is the one `parseCombo` and the CLI presets
 * already know.
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

/**
 * What a "Launch X" row should show as its hint: the agent, not the wrapper.
 *
 * `parseCombo` here is fastpick's, not a new parser. The palette and the
 * General tab's shortcut list both print this rather than the wrapper.
 */
export function shortcutAgentHint(command: string): string {
  const parsed = parseCommand(command);
  if (!parsed.cmd) return command;
  const inner = unwrapShell(parsed.cmd, parsed.args);
  const combo = parseCombo(inner.cmd, inner.args);
  if (combo) return comboLabel(combo);
  const joined = [inner.cmd, ...inner.args].join(" ");
  const preset = findPresetForCommand(joined);
  if (preset) return preset.label;
  return stem(inner.cmd) || command;
}
