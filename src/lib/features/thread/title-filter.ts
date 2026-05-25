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

// Shells often emit their full executable path as the initial OSC title
// (e.g. "C:\Program Files\PowerShell\7\pwsh.exe", "/usr/bin/bash") or a
// Windows-style "Administrator: C:\Windows\System32\cmd.exe". Normalize to
// the basename, strip a trailing .exe, and re-check against the brand set.
function normalizeShellPath(title: string): string | null {
  const trimmed = title.trim();
  if (!trimmed) return null;
  // Drop "Administrator: " or "User: " prefixes cmd.exe prepends.
  const colon = trimmed.indexOf(": ");
  const body = colon > 0 && colon < 32 ? trimmed.slice(colon + 2) : trimmed;
  // Take last path segment.
  const lastSlash = Math.max(body.lastIndexOf("\\"), body.lastIndexOf("/"));
  if (lastSlash < 0) return null;
  let base = body.slice(lastSlash + 1).trim();
  if (!base) return null;
  if (base.toLowerCase().endsWith(".exe")) base = base.slice(0, -4);
  return base.toLowerCase();
}

export function isGenericTitle(title: string | null | undefined): boolean {
  if (!title) return false;
  const direct = title.trim().toLowerCase();
  if (GENERIC_TITLES.has(direct)) return true;
  const base = normalizeShellPath(title);
  if (base && GENERIC_TITLES.has(base)) return true;
  return false;
}
