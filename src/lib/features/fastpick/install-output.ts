/**
 * A compiler's terminal output, turned into lines a panel can show.
 *
 * The install runs on a PTY, which is what makes cargo print the way it does at
 * a prompt: colour, and a status line it rewrites in place with a carriage
 * return several times a second. Neither survives being dropped into a `<div>`
 * as-is. The alternative was asking cargo to be quiet, and a quiet install that
 * fails is an install nobody can diagnose, which is the reason this used to
 * open a whole terminal.
 *
 * Deliberately not xterm: what the panel shows is a build log, and pulling the
 * emulator in would put ~900 KB on a path that has no terminal on it. See
 * `.claude/rules/performance.md`.
 */

/**
 * CSI sequences, the OSC strings a build tool uses for progress and for the
 * window title, and the two-byte escapes. Nothing else an escape can introduce
 * is something cargo prints.
 *
 * Built from source text rather than written as a regex literal so the control
 * bytes are spelled out. A literal holding real `0x1b` bytes renders as nothing
 * in a diff and as nothing in a review, which is how one goes missing.
 *
 * The OSC terminator is required rather than optional: one split across two
 * chunks then stays on screen as its own garbage instead of swallowing every
 * line that follows it, and a visible oddity beats a log that silently stops.
 */
const ESCAPES = new RegExp(
  [
    // CSI: colour, cursor moves, line erases.
    "\\u001b\\[[0-9;?]*[ -/]*[@-~]",
    // OSC: the title and the progress reports, closed by BEL or by ST.
    "\\u001b\\][^\\u0007\\u001b]*(?:\\u0007|\\u001b\\\\)",
    // The two-byte forms, where a lone charset switch lands.
    "\\u001b[@-Z\\\\-_]",
  ].join("|"),
  "g",
);

export function stripEscapes(text: string): string {
  return text.replace(ESCAPES, "");
}

/**
 * The questions a console program asks its terminal, and the shortest true
 * answer to each.
 *
 * **A PTY is a conversation, and a panel that only listens hangs the process.**
 * ConPTY opens by sending a cursor position report request, and the child stays
 * suspended until something answers: a `cargo install` watched here sat at zero
 * CPU forever, having printed nothing but the question. In a terminal pane this
 * never came up because xterm.js answers on its own, which is exactly why it
 * only showed up once this ran in the app.
 *
 * Four queries rather than an emulator. These are what a program asks before it
 * decides how to print, and anything else it asks it can live without: an
 * unanswered query that is not one of these leaves a program using its
 * defaults, while an unanswered `[6n` leaves it stopped.
 */
const REPLIES: [RegExp, string][] = [
  // DSR, cursor position. The panel has no cursor, and the honest answer to
  // "where is it" for something with one line of state is the origin.
  [/^\[6n$/, "[1;1R"],
  // DSR, terminal status: 0 means fine.
  [/^\[5n$/, "[0n"],
  // Primary DA, "what are you": a VT100 with the advanced video option, which
  // is the least this claims to be and enough for colour.
  [/^\[0?c$/, "[?1;2c"],
  // Secondary DA, "which version": zeroes, meaning nothing worth branching on.
  [/^\[>0?c$/, "[>0;0;0c"],
];

const QUERY = /\[(?:[56]n|>?[0-9]*c)/g;

/** Longer than any query above, so a split one is always held whole. */
const QUERY_MAX = 8;

/**
 * The answers owed to a stream of PTY output.
 *
 * Stateful because a four-byte query can be split across two chunks, and one
 * that arrives in halves is one nobody answers.
 */
export class TerminalQueries {
  #carry = "";

  /** What to write back for this chunk, or `""` when it asked nothing. */
  answer(chunk: string): string {
    const text = this.#carry + chunk;
    let reply = "";
    let consumed = 0;
    QUERY.lastIndex = 0;
    for (let match = QUERY.exec(text); match; match = QUERY.exec(text)) {
      const found = REPLIES.find(([pattern]) => pattern.test(match[0]));
      if (found) reply += found[1];
      consumed = match.index + match[0].length;
    }
    // Everything past the last match holds no complete query, so keeping its
    // tail can only ever complete one and never answer the same twice.
    this.#carry = text.slice(Math.max(consumed, text.length - (QUERY_MAX - 1)));
    return reply;
  }

  clear(): void {
    this.#carry = "";
  }
}

/**
 * What a line looks like once the rewrites are done with it.
 *
 * A carriage return sends the cursor back to the start of the line, so
 * everything in front of the last one was painted over by what follows and
 * never existed as far as a reader is concerned. Keeping the tail is how a
 * progress bar collapses to its final state instead of leaving one line per
 * repaint.
 */
export function lastRewrite(line: string): string {
  const parts = line.split("\r");
  return parts[parts.length - 1] ?? "";
}

/**
 * The tail of a build log, assembled from PTY chunks.
 *
 * Bounded on purpose. A `cargo install` over a real dependency tree runs to a
 * few thousand lines and only the end of it answers "did this work", which is
 * the same reason the logs tab renders a tail rather than a file.
 */
export class InstallOutput {
  #lines: string[] = [];
  #pending = "";
  #limit: number;

  constructor(limit = 400) {
    this.#limit = limit;
  }

  /** Whatever arrived, already decoded to text. */
  push(text: string): void {
    const parts = (this.#pending + stripEscapes(text)).split("\n");
    // The last piece has no newline behind it: it is the line being written
    // right now, and it stays out of the list until one arrives.
    this.#pending = parts.pop() ?? "";
    for (const part of parts) {
      this.#lines.push(lastRewrite(part).trimEnd());
    }
    if (this.#lines.length > this.#limit) {
      this.#lines = this.#lines.slice(this.#lines.length - this.#limit);
    }
  }

  /**
   * Commits the half-written line. For the exit, where a process that failed on
   * its last line of output never printed the newline behind it.
   */
  end(): void {
    const last = lastRewrite(this.#pending).trimEnd();
    this.#pending = "";
    if (last) this.#lines.push(last);
  }

  clear(): void {
    this.#lines = [];
    this.#pending = "";
  }

  /**
   * The finished lines plus the one being written, which during a build is the
   * only one moving and so the only sign that anything is still happening.
   */
  snapshot(): string[] {
    const live = lastRewrite(this.#pending).trimEnd();
    return live ? [...this.#lines, live] : [...this.#lines];
  }

  /** What a failure report copies. */
  text(): string {
    return this.snapshot().join("\n");
  }
}
