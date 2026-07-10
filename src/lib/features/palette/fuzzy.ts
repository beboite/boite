// Subsequence fuzzy scorer, no dependency. Higher is better; null means the
// query is not a subsequence of the text. Consecutive matches and word starts
// score high so "nf" ranks "New folder" above "info".
// NFD normalization is O(n) and fuzzyScore folds the same command texts on
// every keystroke; memoized so each string pays it once.
const foldCache = new Map<string, string>();

function foldText(s: string): string {
  const hit = foldCache.get(s);
  if (hit !== undefined) return hit;
  const folded = s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
  if (foldCache.size >= 2000) foldCache.clear();
  foldCache.set(s, folded);
  return folded;
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
