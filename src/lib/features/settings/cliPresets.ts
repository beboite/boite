import type { IconKey } from "$lib/types";

export interface CliPreset {
  id: string;
  label: string;
  command: string;
  iconKey: IconKey;
  executable: string;
  docUrl: string;
}

export const CLI_PRESETS: CliPreset[] = [
  {
    id: "claude",
    label: "Claude",
    command: "claude",
    iconKey: "claude",
    executable: "claude",
    docUrl: "https://code.claude.com/docs/en/overview",
  },
  {
    id: "codex",
    label: "Codex",
    command: "codex --no-alt-screen",
    iconKey: "codex",
    executable: "codex",
    docUrl: "https://github.com/openai/codex",
  },
  {
    id: "opencode",
    label: "Opencode",
    command: "opencode",
    iconKey: "opencode",
    executable: "opencode",
    docUrl: "https://opencode.ai/docs",
  },
  {
    id: "cursor",
    label: "Cursor Agent",
    command: "cursor-agent",
    iconKey: "cursor",
    executable: "cursor-agent",
    docUrl: "https://cursor.com/fr/cli",
  },
  {
    id: "antigravity",
    label: "Antigravity",
    // agy asks before every tool call otherwise, and a thread spawned by an agent
    // has nobody at the keyboard to answer: it would sit on the first confirmation
    // exactly like it used to sit on the opening prompt. Auto-approves everything
    // this CLI does, shell commands included.
    command: "agy --dangerously-skip-permissions",
    iconKey: "antigravity",
    executable: "agy",
    docUrl: "https://antigravity.google/docs/cli",
  },
  {
    id: "copilot",
    label: "Copilot",
    command: "gh copilot",
    iconKey: "copilot",
    executable: "gh",
    docUrl: "https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli",
  },
  {
    id: "grok",
    label: "Grok",
    command: "grok",
    iconKey: "grok",
    executable: "grok",
    docUrl: "https://x.ai/blog/grok-2",
  },
  {
    id: "hermes",
    label: "Hermes",
    command: "hermes",
    iconKey: "hermes",
    executable: "hermes",
    docUrl: "https://github.com/NousResearch/hermes-agent#installation",
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
  },
];
