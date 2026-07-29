import type { IconKey } from "$lib/types";

/**
 * Whether an agent is mid-turn, read off the rows it is repainting.
 *
 * The input is deliberately the emulator's live screen region and not the byte
 * stream. Detection used to run on a rolling 4000-character tail of everything
 * the PTY had printed, which answers a question about the recent past: an
 * `esc to interrupt` footer, or a `✻` from a thinking block, stayed in that
 * window long after the turn it belonged to ended, and every subsequent byte
 * the agent printed re-matched it and re-armed "running". That is the thread
 * that never stops working until you click it: clicking refits the terminal,
 * the agent repaints, and the stale evidence finally falls out of the window.
 *
 * Read off the screen instead, the same answer is level rather than latched:
 * the footer is on the rows or it is not, so `false` is as trustworthy as
 * `true` and nothing has to expire.
 */

/**
 * How many of the bottom rows count as the live region.
 *
 * The agents repaint a footer plus, usually, a prompt box: claude's spinner
 * line sits four rows up from the last one, grok and codex put theirs on the
 * last row. Five rows covers both and is still short enough that printed
 * output cannot reach into it: anything the agent said scrolls above its own
 * box, which is three rows tall by itself.
 */
const LIVE_ROWS = 5;

const COMMON_PATTERNS: RegExp[] = [
  /esc\s+to\s+(?:interrupt|cancel|stop)/i,
  /ctrl\s*\+\s*c\s+to\s+(?:cancel|stop|interrupt)/i,
];

const WORKING_BY_KEY: Partial<Record<NonNullable<IconKey>, RegExp[]>> = {
  claude: [
    /esc\s+to\s+interrupt/i,
    /\(\d+s\s*[·•]/,
    /[↑↓]\s*[\d.]+\s*k?\s*tokens?/i,
  ],
  codex: [
    /esc\s+to\s+(?:interrupt|cancel|stop)/i,
    /\(\d+s\s*[·•]/,
  ],
  opencode: [
    /esc\s+to\s+(?:interrupt|cancel|stop)/i,
    /\bgenerating\b/i,
    /\bthinking\b/i,
    /\bworking\b/i,
    /\bprocessing\b/i,
    /\(\d+s\s*[·•]/,
  ],
  cursor: [
    /esc\s+to\s+(?:interrupt|cancel|stop)/i,
    /\bgenerating\b/i,
    /\bthinking\b/i,
  ],
  antigravity: [
    /esc\s+to\s+(?:interrupt|cancel|stop)/i,
    /\bgenerating\b/i,
    /\bthinking\b/i,
    /\bworking\b/i,
    /✨\s*generating/i,
  ],
  // Grok's status line cycles a braille spinner plus an activity word
  // (Waiting / Running: <tool> / Compacting / Retrying).
  grok: [
    /esc\s+to\s+(?:interrupt|cancel|stop)/i,
    /\brunning:/i,
    /\bcompacting\b/i,
    /\bretrying\b/i,
    /\(\d+s\s*[·•]/,
  ],
  // Hermes marks busy with a leading ⏳ (✓ idle, ⚠ waiting for approval). On
  // Windows it sets the title through SetConsoleTitle, which emits no OSC at
  // all, so the rows are the only place its state shows up.
  hermes: [
    /esc\s+to\s+(?:interrupt|cancel|stop)/i,
    /\bthinking\b/i,
    /\bworking\b/i,
    /\bgenerating\b/i,
  ],
};

// Spinner frames the AI CLIs lead their status line with, including the whole
// braille block (grok cycles frames well beyond the common ⠋ to ⠏ set) and
// hermes's ⏳ busy marker. ⚠ and ✓ are deliberately absent: they mean "action
// required" and "idle", which both read as ready.
const SPINNER_GLYPHS = /[✱✻✦✺✧✨✳❖✷✴✵◐◓◑◒⏳⠁-⣿]/;
const HAS_LETTER = /[a-zA-Z]/;

/**
 * A rotating glyph only ever leads a status line. Requiring that position is
 * what separates a spinner from the same glyph printed inside the transcript:
 * claude bullets its thinking blocks with `✻`, and matching those anywhere in
 * the window flipped a finished thread back to running.
 */
function leadsWithSpinner(line: string): boolean {
  const first = line.trim().charAt(0);
  return first !== "" && SPINNER_GLYPHS.test(first);
}

/**
 * The rows to judge: the bottom of the live region, blank rows dropped.
 *
 * Blank rows are dropped from the end rather than counted, because how many of
 * them sit under an agent's box is a layout accident.
 */
function liveRows(lines: string[]): string[] {
  const rows = [...lines];
  while (rows.length > 0 && rows[rows.length - 1].trim() === "") rows.pop();
  return rows.slice(-LIVE_ROWS);
}

/**
 * Whether these screen rows say the agent is working.
 *
 * `lines` is the terminal's rows, oldest first; only the tail is looked at.
 * Spinner glyphs count for known AI CLIs only: plain terminals print braille
 * spinners too (npm, vite), which used to flip a vanilla shell to running and
 * fire a ghost "Ready for input" notification on the way back down.
 */
export function detectWorkingOnScreen(lines: string[], iconKey: IconKey): boolean {
  const rows = liveRows(lines);
  if (rows.length === 0) return false;
  const isKnownAgent = !!iconKey && iconKey in WORKING_BY_KEY;
  if (isKnownAgent && rows.some(leadsWithSpinner)) return true;
  const text = rows.join("\n");
  if (!HAS_LETTER.test(text)) return false;
  const patterns = (iconKey && WORKING_BY_KEY[iconKey]) || COMMON_PATTERNS;
  for (const pat of patterns) {
    if (pat.test(text)) return true;
  }
  return false;
}

/** Exported for the tests; the detector slices the window itself. */
export const LIVE_ROW_COUNT = LIVE_ROWS;
