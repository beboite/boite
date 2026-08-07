// A model is known by two names and the user remembers whichever they last saw:
// the label a provider gives it ("Opus 5") and the id the launch actually takes
// ("some-provider-opus-5"). Both are searched, and separators are dropped from
// both sides, so "gpt56" finds "GPT-5.6" without anyone guessing where the dashes
// and the dots fall.
function squash(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export function matchesQuery(name: string, id: string, query: string): boolean {
  const tokens = query.split(/\s+/).map(squash).filter(Boolean);
  if (tokens.length === 0) return true;
  const hay = squash(`${name} ${id}`);
  // Every token, in any order: "5 opus" and "opus 5" are the same question.
  return tokens.every((token) => hay.includes(token));
}

export function filterModels<T extends { id: string }>(
  items: T[],
  query: string,
  nameOf: (item: T) => string,
): T[] {
  if (!query.trim()) return items;
  return items.filter((item) => matchesQuery(nameOf(item), item.id, query));
}
