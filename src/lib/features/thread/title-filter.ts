// OSC title strings the AI CLIs emit by default. They overwrite the
// user-visible thread label ("Claude #1", "Backend codex", etc.) with a
// generic brand name, which makes the sidebar useless. Skip these so the
// label survives.
const GENERIC_TITLES = new Set([
  "claude",
  "claude code",
  "claude-code",
  "anthropic",
  "codex",
  "openai codex",
  "chatgpt",
  "opencode",
  "cursor",
  "cursor-agent",
  "cursor agent",
  "gemini",
  "google gemini",
  "antigravity",
  "agy",
  "google antigravity",
  "copilot",
  "github copilot",
  "gh copilot",
  "powershell",
  "powershell 7",
  "pwsh",
  "windows powershell",
  "bash",
  "zsh",
  "sh",
  "fish",
  "nu",
  "nushell",
  "cmd",
  "cmd.exe",
  "command prompt",
  "terminal",
]);

export function isGenericTitle(title: string | null | undefined): boolean {
  if (!title) return false;
  return GENERIC_TITLES.has(title.trim().toLowerCase());
}
