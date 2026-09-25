import type { Readable } from 'node:stream';

/** Far above any real stderr line. A longer one is cut here and the rest of it dropped. */
const LINE_MAX = 64 * 1024;

/**
 * A child's stderr as whole lines, trimmed, empty ones dropped. A pipe read
 * ends wherever it ends, so a line that spans two reads is held until its
 * newline instead of being reported as two pieces; the decoder keeps a
 * character cut between two reads whole too. A line past `max` is reported cut
 * at `max` and the rest of it is dropped, so one runaway line cannot grow the
 * buffer. What is left when the stream ends is the last line.
 */
export function stderrLines(stream: Readable, onLine: (line: string) => void, max = LINE_MAX): void {
  let buffer = '';
  let discarding = false;
  const emit = (raw: string): void => {
    const line = raw.replace(/\r$/, '').trim();
    if (line.length > 0) onLine(line.slice(0, max));
  };
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => {
    let text = chunk;
    if (discarding) {
      const end = text.indexOf('\n');
      if (end < 0) return;
      text = text.slice(end + 1);
      discarding = false;
    }
    buffer += text;
    let at = buffer.indexOf('\n');
    while (at >= 0) {
      emit(buffer.slice(0, at));
      buffer = buffer.slice(at + 1);
      at = buffer.indexOf('\n');
    }
    if (buffer.length > max) {
      emit(buffer);
      buffer = '';
      discarding = true;
    }
  });
  stream.on('end', () => {
    if (!discarding) emit(buffer);
    buffer = '';
  });
}
