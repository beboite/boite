/**
 * A line ceiling for production source files. The files already above it are
 * listed in `size-budget.json` at the size they had when the ceiling came in:
 * they may shrink, not grow, and an entry goes once its file is back under the
 * ceiling. A split that takes a file under the ceiling deletes its entry.
 *
 * Tables that grow with the product by design (the contract, which every new
 * RPC method changes first, the in-memory client that mirrors it, and the UI
 * strings of every language) are exempt, each with the reason beside it.
 */
export interface SizeBudget {
  ceiling: number;
  /** repository path to the most lines that file may have */
  allow: Record<string, number>;
  /** repository path, `*` matching within one path segment, to why it has no ceiling */
  exempt?: Record<string, string>;
}

export function lineCount(source: string): number {
  if (source.length === 0) return 0;
  return source.split('\n').length - (source.endsWith('\n') ? 1 : 0);
}

function pattern(glob: string): RegExp {
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '[^/]*');
  return new RegExp(`^${escaped}$`);
}

/** The exempt pattern `file` matches, or undefined. */
export function exemptBy(file: string, budget: SizeBudget): string | undefined {
  return Object.keys(budget.exempt ?? {}).find((glob) => pattern(glob).test(file));
}

export function sizeViolations(lines: Map<string, number>, budget: SizeBudget): string[] {
  const errors: string[] = [];
  for (const [file, count] of lines) {
    if (exemptBy(file, budget) !== undefined) continue;
    const allowed = budget.allow[file];
    if (allowed === undefined) {
      if (count > budget.ceiling) errors.push(`${file}: ${count} lines, above the ${budget.ceiling}-line ceiling; split it`);
    } else if (count > allowed) {
      errors.push(`${file}: ${count} lines, grown past the ${allowed} it is allowed in size-budget.json; split it instead`);
    }
  }
  for (const [file, allowed] of Object.entries(budget.allow)) {
    const count = lines.get(file);
    const exempt = exemptBy(file, budget);
    if (exempt !== undefined) errors.push(`${file}: both allowed and exempt (${exempt}) in size-budget.json; keep one`);
    else if (count === undefined) errors.push(`${file}: listed in size-budget.json (${allowed} lines) but not a production source any more; remove the entry`);
    else if (count <= budget.ceiling) errors.push(`${file}: ${count} lines, under the ${budget.ceiling}-line ceiling now; remove its entry from size-budget.json`);
  }
  for (const glob of Object.keys(budget.exempt ?? {})) {
    if (![...lines.keys()].some((file) => pattern(glob).test(file))) {
      errors.push(`${glob}: exempt in size-budget.json but matches no production source; remove the entry`);
    }
  }
  return errors;
}

/** Entries shrunk below their allowance: a smaller number keeps the gain from being spent again. */
export function sizeSlack(lines: Map<string, number>, budget: SizeBudget): string[] {
  return Object.entries(budget.allow)
    .filter(([file, allowed]) => (lines.get(file) ?? allowed) < allowed)
    .map(([file, allowed]) => `${file}: ${lines.get(file)} lines, allowed ${allowed}; lower its entry in size-budget.json`);
}

/** Every entry lowered to its file's size today, and the files back under the ceiling dropped. It never raises one. */
export function shrunkBudget(lines: Map<string, number>, budget: SizeBudget): SizeBudget {
  const allow = Object.fromEntries(
    Object.entries(budget.allow)
      .filter(([file]) => (lines.get(file) ?? 0) > budget.ceiling)
      .map(([file, allowed]) => [file, Math.min(allowed, lines.get(file)!)]),
  );
  return { ...budget, allow };
}

/**
 * Every production source above the ceiling, exempt ones aside, allowed at its
 * size today, raised or new ones included, with one line per raise. It is for
 * one moment only: re-pinning the budget on the tree that merges branches written
 * before an entry was pinned, where the raises show up in the diff for review.
 */
export function rebaselinedBudget(lines: Map<string, number>, budget: SizeBudget): { budget: SizeBudget; raised: string[] } {
  const raised: string[] = [];
  const allow: Record<string, number> = {};
  for (const [file, count] of [...lines].sort(([left], [right]) => left.localeCompare(right))) {
    if (count <= budget.ceiling || exemptBy(file, budget) !== undefined) continue;
    allow[file] = count;
    const before = budget.allow[file];
    if (before === undefined) raised.push(`${file}: added at ${count} lines`);
    else if (count > before) raised.push(`${file}: raised from ${before} to ${count} lines`);
  }
  return { budget: { ...budget, allow }, raised };
}
