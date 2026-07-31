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
 * The live region is the bottom block of rows with no gap in it, and this is
 * only the cap on how far up that block may reach.
 *
 * A fixed count was wrong. It was calibrated on a bare claude, whose spinner
 * sits four rows above the last one, and every row of chrome a user adds pushes
 * it further: a statusline, the auto-mode hint and a warning banner between them
 * put it eight rows up, outside a five-row window, and a visibly working agent
 * read as finished. Counting higher instead would walk into the transcript,
 * where a thinking block's `✻` bullet leads its line exactly the way a spinner
 * does.
 *
 * The gap is what separates the two, and every agent leaves one: chrome is drawn
 * as a block at the bottom of the screen with a blank row above it, and printed
 * output is on the far side of that row. So the block decides its own size and
 * this only stops a screen with no blank row left in it from being scanned whole.
 */
const LIVE_ROWS = 16;

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

// Frames that are pure animation: nothing leaves one of these on screen once a
// turn is over, so leading a row with one is the whole signal. Whole ranges
// rather than the frames seen once, because grok cycles well beyond the common
// ⠋ to ⠏ subset. U+2800 is left out of the braille range on purpose: it is the
// empty pattern, a glyph that draws nothing and that `trim` does not treat as
// blank either. ⏳ is hermes's busy marker; its ⚠ and ✓ are deliberately absent,
// they mean "action required" and "idle" and both read as ready.
const ANIMATION_GLYPHS = /[◐-◓⏳⠁-⣿]/;

// Claude's frames are not animation, and no list of them works. Sampled off a
// working agent ten times a second, one status row cycled through `*`, `·`, `✢`,
// `✶`, `✻` and `∗`: an ASCII asterisk and a middle dot among the dingbats, so any
// hand-listed set matches some frames and misses others and the dot flickers
// on and off twice a second while the agent is plainly working. Worse, claude
// leads the line it prints when a turn ENDS with a glyph from the same set
// (`✻ Crunched for 2s`) and leaves it there until the next turn, so the glyph
// says nothing about whether anything is in flight.
//
// The row does. Every frame of a live status row carries the gerund's ellipsis
// and an elapsed count, and the finished line carries the count without the
// ellipsis. Requiring both is stable across the whole frame cycle and across
// whatever claude renames its verbs to next.
const ELLIPSIS = /…|\.\.\./;
const ELAPSED = /\b\d+\s*s\b/;
const INTERRUPT_HINT =
  /esc\s+to\s+(?:interrupt|cancel|stop)|ctrl\s*\+\s*c\s+to\s+(?:cancel|stop|interrupt)/i;

const HAS_LETTER = /[a-zA-Z]/;

/**
 * Whether this row is an agent's live status line.
 *
 * Judged per row rather than over the block: an ellipsis on a truncated
 * transcript line and an elapsed count on the row under it are not a turn in
 * flight, and reading the two together as one would make them into one.
 */
function isLiveStatusRow(line: string): boolean {
  if (INTERRUPT_HINT.test(line)) return true;
  if (ELLIPSIS.test(line) && ELAPSED.test(line)) return true;
  // A rotating braille or circle frame stands on its own, in leading position:
  // nothing leaves one of those on screen once a turn is over, which is what
  // separates them from claude's glyphs. `trim` first, since a status line is
  // usually indented.
  const first = line.trim().charAt(0);
  return first !== "" && ANIMATION_GLYPHS.test(first);
}

/**
 * The rows to judge: the bottom block of rows with no gap in it.
 *
 * Trailing blanks are dropped first, then the walk up stops at the first blank
 * row. That row is the boundary between what the agent is repainting and what it
 * printed earlier, and stopping there is what keeps a finished turn's own
 * transcript from being read as evidence that it is still going.
 */
function liveRows(lines: string[]): string[] {
  const rows = [...lines];
  while (rows.length > 0 && rows[rows.length - 1].trim() === "") rows.pop();
  let start = rows.length;
  while (start > 0 && rows[start - 1].trim() !== "" && rows.length - start < LIVE_ROWS) {
    start--;
  }
  return rows.slice(start);
}

/**
 * Whether these screen rows say the agent is working.
 *
 * `lines` is the terminal's rows, oldest first; only the tail is looked at.
 * Status rows count for known AI CLIs only: plain terminals print braille
 * spinners and elapsed counters too (npm, vite), which used to flip a vanilla
 * shell to running and fire a ghost "Ready for input" notification on the way
 * back down. An interrupt hint is unambiguous whoever printed it, so it stays in
 * the pattern list below, which every thread is judged against.
 */
export function detectWorkingOnScreen(lines: string[], iconKey: IconKey): boolean {
  const rows = liveRows(lines);
  if (rows.length === 0) return false;
  const isKnownAgent = !!iconKey && iconKey in WORKING_BY_KEY;
  if (isKnownAgent && rows.some(isLiveStatusRow)) return true;
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
