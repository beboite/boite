/**
 * The one line splitter every stdio driver reads its agent through: pi, Muse,
 * Codex, agy and the ACP stdout filter.
 *
 * It splits on `\n` only. `U+2028` and `U+2029` are valid inside a JSON string,
 * so nothing else may end a record. A trailing `\r` is stripped and a line that
 * is only whitespace is skipped.
 *
 * Each chunk is scanned once. The part of a line still waiting for its newline
 * is kept as a list of pieces and joined once, when the newline arrives. The
 * old `buffer += chunk; buffer.indexOf('\n')` rescanned the whole pending line
 * on every chunk, so a 16 MB record read in 64 KiB chunks cost 256 scans of a
 * growing string instead of one.
 */

/** A stdout line longer than this is a protocol line nobody should be buffering. */
export const STDOUT_LINE_MAX = 16 * 1024 * 1024;

export interface LineSplitterOptions {
  /**
   * The longest line kept, in UTF-16 code units. A longer one is dropped whole,
   * with `onOverflow` called once for it, and reading goes on at the next line.
   * Unbounded when left out.
   */
  maxLine?: number;
  onOverflow?: () => void;
}

export class LineSplitter {
  private pieces: string[] = [];
  private pending = 0;
  private discarding = false;
  private readonly maxLine: number;

  constructor(
    private readonly onLine: (line: string) => void,
    private readonly options: LineSplitterOptions = {},
  ) {
    this.maxLine = options.maxLine ?? Number.POSITIVE_INFINITY;
  }

  feed(chunk: string): void {
    let start = 0;
    for (let at = chunk.indexOf('\n'); at >= 0; at = chunk.indexOf('\n', start)) {
      const piece = chunk.slice(start, at);
      start = at + 1;
      if (this.discarding) {
        // The tail of a line already reported as too long.
        this.discarding = false;
        continue;
      }
      if (this.pending + piece.length > this.maxLine) {
        this.reset();
        this.options.onOverflow?.();
        continue;
      }
      const line = this.pieces.length === 0 ? piece : this.pieces.join('') + piece;
      this.reset();
      this.emit(line);
    }
    if (this.discarding || start >= chunk.length) return;
    const rest = start === 0 ? chunk : chunk.slice(start);
    this.pieces.push(rest);
    this.pending += rest.length;
    if (this.pending > this.maxLine) {
      this.reset();
      this.discarding = true;
      this.options.onOverflow?.();
    }
  }

  /** The end of the stream: a last line with no newline after it still counts. */
  end(): void {
    if (this.pieces.length === 0) return;
    const line = this.pieces.join('');
    this.reset();
    this.emit(line);
  }

  private reset(): void {
    this.pieces = [];
    this.pending = 0;
  }

  private emit(raw: string): void {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line.trim().length === 0) return;
    this.onLine(line);
  }
}
