/** Literal fake handler registrations must have a shared scenario or an explicit legacy gap. */
export function fakeHandlers(sources: string[]): string[] {
  return [...new Set(sources.flatMap(source => [...source.matchAll(/['"]([a-zA-Z]+\.[a-zA-Z][a-zA-Z.]*)['"]\s*:\s*(?:async\b|function\b|\(|[\w$]+\s*(?:=>|[,}]))/g)].map(match => match[1]!)))].sort();
}
export function scenarioMethods(sources: string[]): Set<string> {
  return new Set(sources.flatMap(source => [...source.matchAll(/\.call\(\s*['"]([a-zA-Z]+\.[a-zA-Z][a-zA-Z.]*)['"]/g)].map(match => match[1]!)));
}
export function uncoveredFakeMethods(handlers: string[], scenarios: Set<string>, baseline: string[]): string[] {
  const legacy = new Set(baseline);
  return handlers.filter(method => !scenarios.has(method) && !legacy.has(method));
}
