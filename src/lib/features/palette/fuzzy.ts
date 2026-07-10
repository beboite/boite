// Subsequence fuzzy scorer, no dependency. Higher is better; null means the
// query is not a subsequence of the text. Consecutive matches and word starts
// score high so "nf" ranks "New folder" above "info".
function foldText(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

export function fuzzyScore(query: string, text: string): number | null {
  const q = foldText(query);
  const t = foldText(text);
  if (q.length === 0) return 0;
  let score = 0;
  let ti = 0;
  let lastMatch = -2;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found === -1) return null;
    if (found === lastMatch + 1) score += 6;
    if (found === 0 || t[found - 1] === " " || t[found - 1] === "-" || t[found - 1] === "/") {
      score += 8;
    }
    score += 1 - Math.min(found - ti, 4);
    lastMatch = found;
    ti = found + 1;
  }
  return score + Math.max(0, 12 - Math.floor(t.length / 4));
}
