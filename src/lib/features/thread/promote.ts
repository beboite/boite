import type { IconKey } from "$lib/types";

/**
 * A process telling boite what its thread has become.
 *
 * A launcher is not the thing it launched. `fastpick` picks an agent and then runs it, and
 * from that moment the thread is a Claude thread, or a Codex one — which is what the status
 * engine, the session monitor and the todo endpoint all key off. Nothing in the byte stream
 * says so, and guessing from the output would be guessing.
 *
 * So the process says it, over the PTY itself:
 *
 * ```
 * ESC ] 1337 ; boite ; launch = {"cmd":"fastpick","args":[…],"iconKey":"claude"} BEL
 * ```
 *
 * The stream is the channel because it is the only one that behaves the same locally and on
 * a remote boite: a sidecar file would be written on the server and read nowhere. OSC 1337
 * is iTerm2's `key=value` channel and this follows that convention with its own `boite;`
 * prefix, so a payload meant for something else is passed on untouched rather than
 * swallowed.
 *
 * What it rewrites is what a reload replays. That is the point: the menu is answered once,
 * and the thread comes back on the same answer.
 */

export const PROMOTE_OSC = 1337;
const PREFIX = "boite;launch=";

// A terminal's output is not a trusted channel — it carries whatever the process printed,
// including a file someone else wrote. So the payload is bounded, and every field is
// checked rather than spread onto the thread.
const MAX_PAYLOAD = 8 * 1024;
const MAX_ARGS = 64;

const ICON_KEYS: readonly IconKey[] = [
  "claude",
  "codex",
  "antigravity",
  "cursor",
  "copilot",
  "opencode",
  "grok",
  "hermes",
  "pi",
  "muse",
  "bun",
  "terminal",
];

export interface Promotion {
  cmd: string;
  args: string[];
  iconKey: IconKey;
  label?: string;
}

/**
 * The promotion an OSC payload carries, or null when it is not one of ours or does not
 * hold up. Anything malformed is dropped in silence: a thread that keeps working as it was
 * is a better answer than one rewritten from a payload nobody can vouch for.
 */
export function parsePromotion(payload: string): Promotion | null {
  if (!payload.startsWith(PREFIX)) return null;
  if (payload.length > MAX_PAYLOAD) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(payload.slice(PREFIX.length));
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const data = raw as Record<string, unknown>;

  const cmd = data.cmd;
  if (typeof cmd !== "string" || !cmd.trim()) return null;

  const args = Array.isArray(data.args) ? data.args : [];
  if (args.length > MAX_ARGS) return null;
  if (!args.every((a): a is string => typeof a === "string")) return null;

  // An unknown icon key would reach `resolveIconKey` and render nothing; null is the
  // documented "no brand glyph" value, so it is what an unrecognised one becomes.
  const iconKey = ICON_KEYS.includes(data.iconKey as IconKey)
    ? (data.iconKey as IconKey)
    : null;

  const label = typeof data.label === "string" && data.label.trim() ? data.label : undefined;
  return { cmd, args: [...args], iconKey, label };
}

/** Whether a thread already is what the promotion describes, so nothing has to be written. */
export function samePromotion(
  thread: { cmd: string; args: readonly string[]; iconKey: IconKey },
  promotion: Promotion,
): boolean {
  return (
    thread.cmd === promotion.cmd &&
    thread.iconKey === promotion.iconKey &&
    thread.args.length === promotion.args.length &&
    thread.args.every((v, i) => v === promotion.args[i])
  );
}
