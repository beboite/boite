import type { FastpickProvider } from "$lib/backend/types";
import type { FastpickCombo } from "./combo";
import { keyById } from "./keys";

/**
 * What is actually answering, when the icon says Claude.
 *
 * A fastpick thread keeps the agent's icon, because that is what it is: Claude Code, its
 * sessions, its keybindings. What the icon cannot say is which model is on the other end,
 * and that is the one thing worth seeing at a glance in a sidebar of eight threads. So the
 * glyph is tinted from the terminal palette rather than labelled.
 *
 * `native` is the absence of a tint on purpose. A binding with no `baseUrl` is fastpick
 * saying the harness keeps its own endpoint, which is the stock agent and needs no warning.
 */
export type ModelAccent = "native" | "local" | "claude" | "gpt" | "other";

/**
 * Terminal palette rather than fixed hex: these sit next to terminal output all day, and a
 * user who themed their terminal green already decided what green means here.
 */
export const ACCENT_COLOR: Record<ModelAccent, string | null> = {
  native: null,
  local: "var(--color-term-green)",
  claude: "var(--color-term-yellow)",
  gpt: "var(--color-term-white)",
  other: "var(--color-term-magenta)",
};

const CLAUDE = /\b(claude|sonnet|opus|haiku)\b/i;
const GPT = /\b(gpt|chatgpt|codex|o[1-9])\b/i;

/** Hostnames that mean "this machine", the ones a local runner actually binds to. */
function isLocalHost(host: string): boolean {
  const h = host.toLowerCase();
  return (
    h === "localhost" ||
    h === "0.0.0.0" ||
    h === "[::1]" ||
    h === "::1" ||
    h === "host.docker.internal" ||
    h.endsWith(".localhost") ||
    h.endsWith(".local") ||
    h.startsWith("127.")
  );
}

/** Whether that URL points at the machine the agent runs on. Unparseable means no. */
export function isLocalUrl(url: string): boolean {
  try {
    return isLocalHost(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** Which family a model id belongs to, from the id alone. */
export function modelFamily(model: string): "claude" | "gpt" | "other" {
  if (CLAUDE.test(model)) return "claude";
  if (GPT.test(model)) return "gpt";
  return "other";
}

/**
 * The tint this combo deserves.
 *
 * `provider` is what fastpick listed for it, when that has been asked for. Without it the
 * answer falls back to the model id, which is enough to tell a GPT from a Claude but cannot
 * know whether the endpoint is the harness's own. So a thread restored before the menu was
 * ever opened is tinted by family, and settles once the listing lands.
 *
 * A provider fastpick has to start a proxy for is never local: the proxy listens here, the
 * model does not.
 *
 * The endpoint belongs to the credential rather than to the provider: one site reached with
 * two keys can answer on two base URLs, and one of them being the harness's own is exactly
 * the difference this tint draws. The combo names which key, and a combo that names none
 * falls back to the provider's only one.
 */
export function modelAccent(
  combo: FastpickCombo,
  provider?: FastpickProvider | null,
): ModelAccent {
  const key = keyById(provider, combo.key);
  const binding = key?.harnesses?.[combo.harness];
  const proxied = (key?.proxyPort ?? null) !== null;
  if (binding && !proxied) {
    if (!binding.baseUrl) return "native";
    if (isLocalUrl(binding.baseUrl)) return "local";
  }
  return modelFamily(combo.model);
}
