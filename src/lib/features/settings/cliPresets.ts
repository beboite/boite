import type { IconKey } from "$lib/types";

export interface CliPreset {
  id: string;
  label: string;
  command: string;
  iconKey: IconKey;
  executable: string;
  docUrl: string;
  yoloFlag?: string;
}

export const CLI_PRESETS: CliPreset[] = [
  {
    id: "claude",
    label: "Claude",
    command: "claude",
    iconKey: "claude",
    executable: "claude",
    docUrl: "https://code.claude.com/docs/en/overview",
    yoloFlag: "--dangerously-skip-permissions",
  },
  {
    id: "codex",
    label: "Codex",
    command: "codex --no-alt-screen",
    iconKey: "codex",
    executable: "codex",
    docUrl: "https://github.com/openai/codex",
    yoloFlag: "--yolo",
  },
  {
    id: "opencode",
    label: "Opencode",
    command: "opencode",
    iconKey: "opencode",
    executable: "opencode",
    docUrl: "https://opencode.ai/docs",
    yoloFlag: "--auto",
  },
  {
    id: "cursor",
    label: "Cursor Agent",
    command: "cursor-agent",
    iconKey: "cursor",
    executable: "cursor-agent",
    docUrl: "https://cursor.com/fr/cli",
    yoloFlag: "--force",
  },
  {
    id: "antigravity",
    label: "Antigravity",
    command: "agy",
    iconKey: "antigravity",
    executable: "agy",
    docUrl: "https://antigravity.google/docs/cli",
    yoloFlag: "--dangerously-skip-permissions",
  },
  {
    id: "copilot",
    label: "Copilot",
    // The standalone Copilot CLI, which is the one `session/editors.rs` reads a
    // session store for and the one `copilot mcp add` belongs to. The `gh copilot`
    // extension is a different product that happens to share the name.
    command: "copilot",
    iconKey: "copilot",
    executable: "copilot",
    docUrl: "https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli",
    yoloFlag: "-- --yolo",
  },
  {
    id: "grok",
    label: "Grok",
    command: "grok",
    iconKey: "grok",
    executable: "grok",
    docUrl: "https://x.ai/cli",
    yoloFlag: "--yolo",
  },
  {
    id: "hermes",
    label: "Hermes",
    command: "hermes",
    iconKey: "hermes",
    executable: "hermes",
    docUrl: "https://github.com/NousResearch/hermes-agent#installation",
    yoloFlag: "--yolo",
  },
  {
    id: "pi",
    label: "Pi",
    command: "pi",
    iconKey: "pi",
    executable: "pi",
    docUrl: "https://pi.dev/",
  },
  {
    id: "muse",
    label: "Muse",
    command: "muse",
    iconKey: "muse",
    executable: "muse",
    docUrl: "https://dev.meta.ai/docs/muse-code",
    yoloFlag: "--yolo",
  },
];

/** Finds a preset matching a given command line or executable name. */
export function findPresetForCommand(command: string): CliPreset | null {
  const trimmed = command.trim();
  if (!trimmed) return null;
  const parts = trimmed.split(/\s+/);
  const first = parts[0];
  return (
    CLI_PRESETS.find((p) => {
      const presetParts = p.command.trim().split(/\s+/);
      if (presetParts[0] === "gh" && parts[0] === "gh") {
        return parts[1] === "copilot";
      }
      return p.executable === first || presetParts[0] === first;
    }) ?? null
  );
}

/** Checks whether a command string already contains the preset's YOLO flag. */
export function hasYoloFlag(command: string, flag?: string): boolean {
  if (!flag) return false;
  if (flag.startsWith("-- ")) {
    return command.includes(flag);
  }
  const tokens = command.trim().split(/\s+/);
  return tokens.includes(flag);
}

/** Injects the YOLO flag into a command line. */
export function withYoloFlag(command: string, flag?: string): string {
  if (!flag || hasYoloFlag(command, flag)) return command;
  const trimmed = command.trim();
  if (!trimmed) return flag;
  return `${trimmed} ${flag}`;
}

/** Removes the YOLO flag from a command line. */
export function withoutYoloFlag(command: string, flag?: string): string {
  if (!flag || !hasYoloFlag(command, flag)) return command;
  if (flag.startsWith("-- ")) {
    return command.replace(/\s*--\s+--yolo\b/, "").trim();
  }
  const tokens = command.trim().split(/\s+/);
  return tokens.filter((t) => t !== flag).join(" ").trim();
}
