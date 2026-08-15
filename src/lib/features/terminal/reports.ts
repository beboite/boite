/**
 * Bytes the terminal writes back on its own, told apart from what the user
 * typed.
 *
 * Both leave through the same door. xterm's `onData` is "the terminal has
 * something to send upstream", not "a key was pressed": the focus reports of
 * DECSET 1004 go through it, so do mouse reports in every encoding but the
 * default one, and so does every answer to a query the agent itself made
 * (device attributes, cursor position, mode reports, the colour and termcap
 * ones). Treating all of it as input made a click on a thread look like typing
 * into it, which is what the sidebar's order was reading.
 *
 * A report still has to reach the PTY: the agent asked for it. This only says
 * whether it counts as the user doing something.
 */

const ESC = "\u001b";
const CSI = `${ESC}[`;
const ST = `${ESC}\\`;
const BEL = "\u0007";

/**
 * What a report may carry between the CSI and its final byte: digits and
 * separators, the `?`, `<` and `>` that open a private one, the `$` a mode
 * report closes with. No key produces a sequence shaped like this.
 */
const PARAM_CHARS = "0123456789;?<>$";

function isReportParams(s: string): boolean {
  for (const ch of s) {
    if (!PARAM_CHARS.includes(ch)) return false;
  }
  return true;
}

export function isTerminalReport(data: string): boolean {
  if (data.length < 2 || !data.startsWith(ESC)) return false;

  // DCS and OSC answers: XTGETTCAP, DECRQSS, the colour queries. The terminator
  // is what makes one an answer rather than the first half of a paste.
  if (data[1] === "P" || data[1] === "]") {
    return data.endsWith(ST) || data.endsWith(BEL);
  }

  if (!data.startsWith(CSI)) return false;
  const body = data.slice(CSI.length);
  if (body.length === 0) return false;
  const final = body[body.length - 1];
  const params = body.slice(0, -1);
  if (!isReportParams(params)) return false;

  // Focus in and out. Bare, so back-tab and any parameterised final are left
  // alone.
  if (final === "I" || final === "O") return params === "";

  // Mouse, in the SGR (1006), SGR-pixel (1016) and urxvt (1015) encodings. The
  // default encoding leaves as a binary event and never reaches `onData` at
  // all.
  if (final === "M" || final === "m") return params.includes(";");

  // Cursor position (DSR 6 and DECXCPR), device status (DSR 5), device
  // attributes, and the mode report DECRQM is answered with. All parameterised,
  // which is what separates the answer from the request.
  const answers = final === "R" || final === "n" || final === "c" || final === "y";
  return answers && params !== "";
}
