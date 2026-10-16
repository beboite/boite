/**
 * Terminal escape sequences, as `node:util`'s `stripVTControlCharacters` matches
 * them: CSI (colors, cursor moves) and OSC (titles, links) ended by BEL or ST.
 * Kept here because importing that function loads `node:util`'s inspect module,
 * about 10 ms and 9 MiB at every core start, for two rare parsers.
 */
const ANSI = new RegExp(
  '[\\u001B\\u009B][[\\]()#;?]*'
  + '(?:(?:(?:(?:;[-a-zA-Z\\d\\/\\#&.:=?%@~_]+)*'
  + '|[a-zA-Z\\d]+(?:;[-a-zA-Z\\d\\/\\#&.:=?%@~_]*)*)?'
  + '(?:\\u0007|\\u001B\\u005C|\\u009C))'
  + '|(?:(?:\\d{1,4}(?:;\\d{0,4})*)?'
  + '[\\dA-PR-TZcf-ntqry=><~]))',
  'g',
);

/** `text` without its terminal escape sequences. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI, '');
}
