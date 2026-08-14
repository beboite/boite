import type { IconKey } from "$lib/types";
import { isKnownAgent, liveRows } from "./working-detect";

/**
 * Whether an agent has stopped on a question, read off the rows it is repainting.
 *
 * Claude answers this itself, in its session registry, and for claude that answer
 * is the one to trust. Nobody else declares anything of the kind: codex, opencode
 * and the rest sit on a permission dialog while their registry entry says the
 * turn is idle, and the screen detector next door only ever answers running or
 * ready. Between the two, an agent blocked on a question read as finished. Its
 * dot went green, no notification went out, and auto-sleep counted it down and
 * killed the PTY with the question still on it.
 *
 * So the dialog is read where it is drawn. Same rows as `working-detect`, same
 * reason: a dialog is on the screen or it is not, so `null` is as trustworthy as
 * a hit and nothing has to expire.
 *
 * The bar to clear is deliberately high. A false "waiting" is the expensive
 * mistake here: it holds a PTY out of auto-sleep for the life of the window and
 * it raises a notification for nothing. So a question mark alone never counts,
 * and neither does an option row alone. What counts is a question AND the
 * selector drawn against its answers, which is the shape every one of these CLIs
 * uses and which nothing leaves on screen once the dialog is answered.
 */

// The edges of whatever the dialog is drawn in, so the text inside can be read
// on its own. Claude boxes its prompt in `│ … │` and codex rules its own with a
// leading `▌`, which is enough to keep a question mark from ever being last on
// its row.
const BOX_EDGE = /^[\s│┃┆┇┊┋┆|▌▏╎╏]+|[\s│┃┆┇┊┋|▐▕╎╏]+$/g;

// The glyph a TUI draws against the option the arrow keys are on. Stripped
// before an option row is judged, never evidence on its own: `❯` is also every
// one of these agents' empty input prompt.
//
// `*`, `+` and `-` are not in here: they are markdown bullets, which agents
// print in prose all day, and an answer word behind one ("- Never mind that")
// is a sentence rather than an option row.
const CHOICE_CURSOR = /^[❯➜▶►▸›>●◉○]\s*/;

const NUMBERED_OPTION = /^\d+\s*[.)]\s*\S/;

// The words an answer is spelled with, across the six CLIs that ask. `always`
// and `don't ask again` are the third option claude and codex both offer, and
// they are what tells their dialog apart from a sentence that merely opens with
// "no".
// The trailing `(?!\()` is what keeps claude's own tool lines out: it draws
// `● Edit(src/main.rs)` with the same bullet a selector uses, and `edit` is an
// answer word. An option is never a call.
const ANSWER_WORD =
  /^(?:yes|yeah|no|nope|allow|approve|accept|deny|reject|cancel|always|never|don['’]t ask(?: again)?|skip|edit)\b(?!\()/i;

// A y/n footer, which is the other shape: no menu, one keypress. Strong enough
// on its own, since nothing prints it except a program that has stopped for an
// answer — as long as it is where a prompt puts it. Anchored to the end of the
// row, because a program waiting on the keypress has nothing left to say after
// it, while `if (confirm("delete? [y/N]")) {` in a printed diff does.
const YES_NO_FOOTER = /[[(]\s*y(?:es)?\s*\/\s*n(?:o)?\s*[\])][\s:>❯]*$/i;

// Asked without a question mark. Kept to the phrasings that only ever introduce
// a prompt: "waiting for" and "press enter" are said by progress output too, so
// they are not in here.
const ASK_PHRASE =
  /\b(?:do you want to|would you like to|allow .{0,40}\bto\b|approve this|apply (?:this|these)|proceed\?|confirm(?:ation)? required|permission to)/i;

/** The row's own text, with the box it is drawn in taken off both ends. */
function core(line: string): string {
  return line.replace(BOX_EDGE, "");
}

/** Whether this row is one of a dialog's answers. */
function isOptionRow(line: string): boolean {
  const text = core(line);
  if (!CHOICE_CURSOR.test(text) && !NUMBERED_OPTION.test(text)) return false;
  const rest = text.replace(CHOICE_CURSOR, "");
  return NUMBERED_OPTION.test(rest) || ANSWER_WORD.test(rest);
}

/** Whether this row is what the dialog is asking. */
function isQuestionRow(line: string): boolean {
  const text = core(line);
  return text.endsWith("?") || ASK_PHRASE.test(text);
}

/** What the tooltip says, from the row that asked. */
function label(line: string): string {
  const text = core(line).replace(CHOICE_CURSOR, "").trim();
  return text.length > 120 ? `${text.slice(0, 119)}…` : text;
}

/**
 * What this agent is blocked on, in its own words, or null when it is not.
 *
 * Known agents only, the way the working detector works and for the same reason:
 * a plain shell runs programs that ask `[y/N]` all day (git, npm, apt), and a
 * terminal thread has no turn for the question to belong to.
 */
export function detectWaitingOnScreen(lines: string[], iconKey: IconKey): string | null {
  if (!isKnownAgent(iconKey)) return null;
  const rows = liveRows(lines);
  if (rows.length === 0) return null;

  const footer = rows.find((row) => YES_NO_FOOTER.test(row));
  if (footer) return label(footer);

  // Hermes marks its own state in a leading glyph and this is the one that means
  // action required, which its own docs spell out (⏳ busy, ✓ idle, ⚠ waiting for
  // approval). Read for hermes alone: elsewhere ⚠ is an ordinary warning banner,
  // and claude keeps one pinned under its input box for the whole session.
  if (iconKey === "hermes") {
    const marked = rows.find((row) => core(row).startsWith("⚠"));
    if (marked) return label(marked);
  }

  const question = rows.find(isQuestionRow);
  if (!question) return null;
  if (!rows.some(isOptionRow)) return null;
  return label(question);
}
