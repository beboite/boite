import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { boundaryViolations, cycles, dependencyGraph, type Sources } from './graph.ts';
import { lineCount, rebaselinedBudget, shrunkBudget, sizeSlack, sizeViolations, type SizeBudget } from './size.ts';

const BUDGET_FILE = 'scripts/architecture/size-budget.json';
const sources: Sources = new Map();
const lines = new Map<string, number>();
function read(directory: string): void {
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = `${directory}/${entry.name}`;
    if (entry.isDirectory()) read(file);
    else if (/\.(?:test|d)\.ts$/.test(file)) continue;
    else if (/\.(?:ts|js)$/.test(file)) {
      const source = readFileSync(file, 'utf8');
      sources.set(file, source);
      lines.set(file, lineCount(source));
    } else if (file.endsWith('.svelte')) lines.set(file, lineCount(readFileSync(file, 'utf8')));
  }
}
for (const root of ['packages/contracts/src', 'packages/core/src', 'packages/ui/src']) read(root);

let budget = JSON.parse(readFileSync(BUDGET_FILE, 'utf8')) as SizeBudget;
if (process.argv.includes('--rebaseline-size-budget')) {
  // Only when merging branches written before their files were pinned: every raise is printed and lands in the diff.
  const rebased = rebaselinedBudget(lines, budget);
  for (const line of rebased.raised) console.log(`size budget: ${line}`);
  budget = rebased.budget;
  writeFileSync(BUDGET_FILE, `${JSON.stringify(budget, null, 2)}\n`);
} else if (process.argv.includes('--write-size-budget')) {
  budget = shrunkBudget(lines, budget);
  writeFileSync(BUDGET_FILE, `${JSON.stringify(budget, null, 2)}\n`);
}

const graph = dependencyGraph(sources);
const errors = [
  ...boundaryViolations(graph),
  ...cycles(graph).map(cycle => `runtime cycle: ${cycle}`),
  ...sizeViolations(lines, budget),
];
if (errors.length) throw new Error(`Architecture check failed:\n${errors.join('\n')}`);
for (const note of sizeSlack(lines, budget)) console.log(`note: ${note} (bun run check:architecture --write-size-budget)`);
console.log(
  `Architecture passed: ${graph.size} modules, no runtime cycles or forbidden imports, ` +
    `no source above ${budget.ceiling} lines outside the ${Object.keys(budget.allow).length} files allowed to shrink ` +
    `and the ${Object.keys(budget.exempt ?? {}).length} exempt entries`,
);
