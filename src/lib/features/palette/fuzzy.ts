// Word-prefix and fuzzy scorer, no dependency.
// Rules, in order of score:
// 1. exact word match (every query token exactly matches a distinct word in text)
// 2. word-prefix match (each query token is a prefix of a distinct word in text, all tokens match, tokens in any order)
// 3. subsequence match (only when opts.fuzzy is true and the subsequence spans at most query.length + 6 characters)
// Anything else returns null.
// Case- and accent-insensitive (NFD normalization stripping combining marks).
// Returns score and matched ranges [start, end][] on the text the caller passed.

export interface FuzzyOpts {
  fuzzy?: boolean;
}

export interface FuzzyResult {
  score: number;
  ranges: [number, number][];
}

export interface TextSegment {
  text: string;
  matched: boolean;
}

interface FoldedText {
  folded: string;
  map: number[];
}

const foldMapCache = new Map<string, FoldedText>();

export function foldWithMap(s: string): FoldedText {
  const hit = foldMapCache.get(s);
  if (hit !== undefined) return hit;

  let folded = "";
  const map: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (/^[\u0300-\u036f]$/.test(ch)) continue;
    const norm = ch
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "");
    for (let k = 0; k < norm.length; k++) {
      map.push(i);
      folded += norm[k];
    }
  }

  const res: FoldedText = { folded, map };
  if (foldMapCache.size >= 2000) foldMapCache.clear();
  foldMapCache.set(s, res);
  return res;
}

export function foldText(s: string): string {
  return foldWithMap(s).folded;
}

function mergeRanges(ranges: [number, number][]): [number, number][] {
  if (ranges.length <= 1) return ranges;
  const sorted = [...ranges].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: [number, number][] = [];
  for (const [start, end] of sorted) {
    if (start === end) continue;
    if (merged.length === 0) {
      merged.push([start, end]);
    } else {
      const prev = merged[merged.length - 1];
      if (start <= prev[1]) {
        prev[1] = Math.max(prev[1], end);
      } else {
        merged.push([start, end]);
      }
    }
  }
  return merged;
}

function toOriginalRanges(
  foldedRanges: [number, number][],
  map: number[],
  origText: string,
): [number, number][] {
  const ranges: [number, number][] = [];
  for (const [fStart, fEnd] of foldedRanges) {
    if (fStart >= fEnd || fStart >= map.length) continue;
    const start = map[fStart];
    const lastIdx = Math.min(fEnd - 1, map.length - 1);
    let end = map[lastIdx] + 1;
    while (end < origText.length && /^[\u0300-\u036f]$/.test(origText[end].normalize("NFD"))) {
      end++;
    }
    ranges.push([start, end]);
  }
  return mergeRanges(ranges);
}

export function highlightSegments(
  text: string,
  ranges?: [number, number][],
): TextSegment[] {
  if (!ranges || ranges.length === 0) {
    return [{ text, matched: false }];
  }

  const validRanges: [number, number][] = [];
  for (const [s, e] of ranges) {
    const cs = Math.max(0, Math.min(s, text.length));
    const ce = Math.max(0, Math.min(e, text.length));
    if (cs < ce) validRanges.push([cs, ce]);
  }

  const merged = mergeRanges(validRanges);
  if (merged.length === 0) {
    return [{ text, matched: false }];
  }

  const segments: TextSegment[] = [];
  let cursor = 0;
  for (const [start, end] of merged) {
    if (start > cursor) {
      segments.push({ text: text.slice(cursor, start), matched: false });
    }
    segments.push({ text: text.slice(start, end), matched: true });
    cursor = end;
  }
  if (cursor < text.length) {
    segments.push({ text: text.slice(cursor), matched: false });
  }

  return segments;
}

interface Word {
  text: string;
  start: number;
  end: number;
}

function findExactWordMatch(qTokens: string[], words: Word[]): Word[] | null {
  const used = new Set<number>();
  const match: Word[] = [];

  function backtrack(tokenIdx: number): boolean {
    if (tokenIdx === qTokens.length) return true;
    const token = qTokens[tokenIdx];
    for (let i = 0; i < words.length; i++) {
      if (!used.has(i) && words[i].text === token) {
        used.add(i);
        match.push(words[i]);
        if (backtrack(tokenIdx + 1)) return true;
        match.pop();
        used.delete(i);
      }
    }
    return false;
  }

  return backtrack(0) ? match : null;
}

function findWordPrefixMatch(qTokens: string[], words: Word[]): Word[] | null {
  const used = new Set<number>();
  let bestMatch: Word[] | null = null;
  let bestScore = -1;
  const currentMatch: Word[] = [];

  function backtrack(tokenIdx: number, currentScore: number) {
    if (tokenIdx === qTokens.length) {
      if (currentScore > bestScore) {
        bestScore = currentScore;
        bestMatch = [...currentMatch];
      }
      return;
    }
    const token = qTokens[tokenIdx];
    const candidates: { idx: number; score: number }[] = [];
    for (let i = 0; i < words.length; i++) {
      if (used.has(i)) continue;
      const w = words[i];
      if (w.text.startsWith(token)) {
        const s = (w.text === token ? 100 : 50) + Math.max(0, 20 - i);
        candidates.push({ idx: i, score: s });
      }
    }
    candidates.sort((a, b) => b.score - a.score);

    for (const cand of candidates) {
      used.add(cand.idx);
      currentMatch.push(words[cand.idx]);
      backtrack(tokenIdx + 1, currentScore + cand.score);
      currentMatch.pop();
      used.delete(cand.idx);
    }
  }

  backtrack(0, 0);
  return bestMatch;
}

function findSubsequence(q: string, t: string, maxSpan: number): number[] | null {
  if (q.length === 0) return [];
  if (q.length > t.length) return null;

  let bestIndices: number[] | null = null;
  let minSpan = Infinity;

  for (let s = 0; s < t.length; s++) {
    if (t[s] !== q[0]) continue;

    const indices: number[] = [s];
    let ti = s + 1;
    let matched = true;
    for (let qi = 1; qi < q.length; qi++) {
      const found = t.indexOf(q[qi], ti);
      if (found === -1) {
        matched = false;
        break;
      }
      indices.push(found);
      ti = found + 1;
    }

    if (!matched) break;

    const last = indices[indices.length - 1];
    const tightIndices: number[] = Array.from<number>({ length: q.length });
    tightIndices[q.length - 1] = last;
    let backTi = last - 1;
    let backMatched = true;
    for (let qi = q.length - 2; qi >= 0; qi--) {
      const found = t.lastIndexOf(q[qi], backTi);
      if (found === -1 || found < s) {
        backMatched = false;
        break;
      }
      tightIndices[qi] = found;
      backTi = found - 1;
    }

    const current = backMatched ? tightIndices : indices;
    const span = current[current.length - 1] - current[0] + 1;
    if (span <= maxSpan && span < minSpan) {
      minSpan = span;
      bestIndices = current;
      if (span === q.length) break;
    }
  }

  return bestIndices;
}

function isWordBoundaryChar(ch: string): boolean {
  return /[\s\-_/.,:;()[\]{}|\\+#'"`~!?@$%^&*<>=]/.test(ch);
}

export function fuzzyScore(
  query: string,
  text: string,
  opts?: FuzzyOpts,
): FuzzyResult | null {
  const qTrimmed = query.trim();
  if (qTrimmed.length === 0) {
    return { score: 0, ranges: [] };
  }
  if (text.length === 0) {
    return null;
  }

  const { folded: tFolded, map } = foldWithMap(text);
  const qFolded = foldWithMap(qTrimmed).folded;

  // Extract query tokens
  const qTokens = qFolded.match(/[\p{L}\p{N}]+/gu);
  if (!qTokens || qTokens.length === 0) {
    return null;
  }

  // Extract words in text
  const words: Word[] = [];
  const wordRe = /[\p{L}\p{N}]+/gu;
  let wm: RegExpExecArray | null;
  while ((wm = wordRe.exec(tFolded)) !== null) {
    words.push({
      text: wm[0],
      start: wm.index,
      end: wm.index + wm[0].length,
    });
  }

  // 1. Exact word match
  if (words.length >= qTokens.length) {
    const exactMatch = findExactWordMatch(qTokens, words);
    if (exactMatch !== null) {
      let score = 2000;
      if (words.length === qTokens.length) score += 500;
      let inOrder = true;
      for (let i = 1; i < exactMatch.length; i++) {
        if (exactMatch[i].start < exactMatch[i - 1].start) {
          inOrder = false;
          break;
        }
      }
      if (inOrder) score += 100;
      if (exactMatch[0].start === 0) score += 50;
      score += Math.max(0, 50 - text.length);

      const foldedRanges: [number, number][] = exactMatch.map((w) => [w.start, w.end]);
      return {
        score,
        ranges: toOriginalRanges(foldedRanges, map, text),
      };
    }
  }

  // 2. Word-prefix match
  if (words.length >= qTokens.length) {
    const prefixMatch = findWordPrefixMatch(qTokens, words);
    if (prefixMatch !== null) {
      let score = 1000;
      let inOrder = true;
      for (let i = 0; i < qTokens.length; i++) {
        const token = qTokens[i];
        const word = prefixMatch[i];
        if (word.text === token) {
          score += 100;
        } else {
          score += Math.floor(50 * (token.length / word.text.length));
        }
        if (i > 0 && prefixMatch[i].start < prefixMatch[i - 1].start) {
          inOrder = false;
        }
      }
      if (inOrder) score += 50;
      if (prefixMatch[0].start === 0) score += 30;
      score += Math.max(0, 50 - text.length);

      const foldedRanges: [number, number][] = [];
      for (let i = 0; i < qTokens.length; i++) {
        const token = qTokens[i];
        const word = prefixMatch[i];
        foldedRanges.push([word.start, word.start + token.length]);
      }
      return {
        score,
        ranges: toOriginalRanges(foldedRanges, map, text),
      };
    }
  }

  // 3. Subsequence match (only when opts.fuzzy is true and span <= query.length + 6)
  if (opts?.fuzzy) {
    const subQuery = qFolded.replace(/\s+/g, "");
    if (subQuery.length > 0 && subQuery.length <= tFolded.length) {
      const maxSpan = subQuery.length + 6;
      const subIndices = findSubsequence(subQuery, tFolded, maxSpan);
      if (subIndices !== null) {
        const first = subIndices[0];
        const last = subIndices[subIndices.length - 1];
        const span = last - first + 1;

        let score = 100;
        let lastMatch = -2;
        for (const idx of subIndices) {
          if (idx === lastMatch + 1) score += 6;
          if (idx === 0 || isWordBoundaryChar(tFolded[idx - 1])) {
            score += 8;
          }
          lastMatch = idx;
        }
        score += Math.max(0, 12 - span);
        score += Math.max(0, 10 - Math.floor(text.length / 4));

        const foldedRanges: [number, number][] = [];
        let rStart = subIndices[0];
        let rEnd = subIndices[0] + 1;
        for (let i = 1; i < subIndices.length; i++) {
          const idx = subIndices[i];
          if (idx === rEnd) {
            rEnd = idx + 1;
          } else {
            foldedRanges.push([rStart, rEnd]);
            rStart = idx;
            rEnd = idx + 1;
          }
        }
        foldedRanges.push([rStart, rEnd]);

        return {
          score,
          ranges: toOriginalRanges(foldedRanges, map, text),
        };
      }
    }
  }

  return null;
}
