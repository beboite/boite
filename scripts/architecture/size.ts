/**
 * A line ceiling for production source files. The files already above it are
 * listed in `size-budget.json` at the size they had when the ceiling came in:
 * they may shrink, not grow, and an entry goes once its file is back under the
 * ceiling. A split that takes a file under the ceiling deletes its entry.
 */
export interface SizeBudget {
  ceiling: number;
  /** repository path to the most lines that file may have */
  allow: Record<string, number>;
}

export function lineCount(source: string): number {
  if (source.length === 0) return 0;
  return source.split('\n').length - (source.endsWith('\n') ? 1 : 0);
}

export function sizeViolations(lines: Map<string, number>, budget: SizeBudget): string[] {
  const errors: string[] = [];
  for (const [file, count] of lines) {
    const allowed = budget.allow[file];
    if (allowed === undefined) {
      if (count > budget.ceiling) errors.push(`${file}: ${count} lines, above the ${budget.ceiling}-line ceiling; split it`);
    } else if (count > allowed) {
      errors.push(`${file}: ${count} lines, grown past the ${allowed} it is allowed in size-budget.json; split it instead`);
    }
  }
  for (const [file, allowed] of Object.entries(budget.allow)) {
    const count = lines.get(file);
    if (count === undefined) errors.push(`${file}: listed in size-budget.json (${allowed} lines) but not a production source any more; remove the entry`);
    else if (count <= budget.ceiling) errors.push(`${file}: ${count} lines, under the ${budget.ceiling}-line ceiling now; remove its entry from size-budget.json`);
  }
  return errors;
}

/** Entries shrunk below their allowance: a smaller number keeps the gain from being spent again. */
export function sizeSlack(lines: Map<string, number>, budget: SizeBudget): string[] {
  return Object.entries(budget.allow)
    .filter(([file, allowed]) => (lines.get(file) ?? allowed) < allowed)
    .map(([file, allowed]) => `${file}: ${lines.get(file)} lines, allowed ${allowed}; lower its entry in size-budget.json`);
}
