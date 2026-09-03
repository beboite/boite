/**
 * Turn a dispatcher `when` clause into a sentence.
 *
 * The Keyboard tab used to print the raw expression under every row. Tokens
 * become words, `||` / `&&` / `!` become ", or " / " and " / "not ", and
 * parentheses stay. The phrases come from the caller so both locales live in
 * the dictionary rather than in this file.
 */

export type WhenPhrases = {
  or: string;
  and: string;
  not: string;
  tokens: Record<string, string>;
};

export function whenSentence(clause: string, phrases: WhenPhrases): string {
  // Tokens first, so the words `or` / `and` that the operators insert are
  // not rewritten as unknown keys.
  return clause
    .replace(/[A-Za-z_][A-Za-z0-9_]*/g, (piece) => phrases.tokens[piece] ?? piece)
    .replace(/\s*\|\|\s*/g, phrases.or)
    .replace(/\s*&&\s*/g, phrases.and)
    .replace(/!/g, phrases.not);
}
