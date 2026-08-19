/**
 * Whether a merged file can still be read as what it is.
 *
 * The one check that stops the merge tool from being dangerous. Stacking two
 * markdown paragraphs is what the user asked for; stacking two JSON objects is a
 * syntax error, and writing that into `~/.claude/settings.json` breaks the agent
 * on every machine the repository reaches.
 *
 * Comments are stripped rather than parsed, because one file in scope is JSONC
 * and this only needs a verdict, not a document. Nothing here ever writes: what
 * goes to disk is the text the user is looking at, byte for byte.
 */

export interface Verdict {
  ok: boolean;
  /** 1-indexed, for a message that points at something. */
  line?: number;
  message?: string;
}

const OK: Verdict = { ok: true };

export function validate(text: string, syntax: string): Verdict {
  if (syntax !== "json" && syntax !== "jsonc") return OK;
  const source = syntax === "jsonc" ? stripComments(text) : text;
  try {
    JSON.parse(source);
    return OK;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, line: lineOf(source, message), message };
  }
}

/**
 * Comments out, strings intact.
 *
 * A `//` inside a string value is not a comment — an address in a config would
 * be cut in half by a naive pass, and the file would be reported broken when it
 * is fine. Replaced with spaces rather than removed, so every offset still
 * points where it did and the reported line is the real one.
 */
export function stripComments(text: string): string {
  let out = "";
  let index = 0;
  let inString = false;
  while (index < text.length) {
    const char = text[index];
    if (inString) {
      out += char;
      if (char === "\\" && index + 1 < text.length) {
        out += text[index + 1];
        index += 2;
        continue;
      }
      if (char === '"') inString = false;
      index += 1;
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      index += 1;
      continue;
    }
    if (char === "/" && text[index + 1] === "/") {
      while (index < text.length && text[index] !== "\n") {
        out += " ";
        index += 1;
      }
      continue;
    }
    if (char === "/" && text[index + 1] === "*") {
      const end = text.indexOf("*/", index + 2);
      const stop = end === -1 ? text.length : end + 2;
      // Newlines are kept so the line numbers below stay true.
      for (let at = index; at < stop; at += 1) out += text[at] === "\n" ? "\n" : " ";
      index = stop;
      continue;
    }
    out += char;
    index += 1;
  }
  return out;
}

/**
 * The line the parser is complaining about, when it says.
 *
 * Engines disagree about how much they tell you. Some messages carry
 * `(line N column C)`, some carry only `position N`, and the commonest shape —
 * `Unexpected token 'o', ...` — carries neither, only a snippet. The line is
 * taken where it is offered and left out where it is not: a made-up number
 * pointing at the wrong line is worse than no number, and the parser's own
 * sentence is shown either way.
 */
function lineOf(source: string, message: string): number | undefined {
  const stated = /\(line (\d+)/.exec(message);
  if (stated) return Number(stated[1]);
  const found = /position (\d+)/.exec(message);
  if (!found) return undefined;
  const position = Number(found[1]);
  if (!Number.isFinite(position)) return undefined;
  return source.slice(0, position).split("\n").length;
}
