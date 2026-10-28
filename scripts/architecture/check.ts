import { readFileSync, writeFileSync } from 'node:fs';
import { boundaryViolations, cycles, dependencyGraph } from './graph.ts';
import { readInventory, ROOTS } from './inventory.ts';
import { nestedTickViolations, readBunTestSources } from './nested-tick.ts';
import { rebaselinedBudget, shrunkBudget, sizeSlack, sizeViolations, type SizeBudget } from './size.ts';

const BUDGET_FILE = 'scripts/architecture/size-budget.json';
const { sources, lines, languages } = readInventory();

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
  ...nestedTickViolations(readBunTestSources()),
];
if (errors.length) throw new Error(`Architecture check failed:\n${errors.join('\n')}`);
for (const note of sizeSlack(lines, budget)) console.log(`note: ${note} (bun run check:architecture --write-size-budget)`);
const read = [...languages].map(([language, count]) => `${count} ${language}`).join(', ');
console.log(
  `Architecture passed: ${graph.size} modules, no runtime cycles or forbidden imports, ` +
    `no promise matcher under bun test, no source above ${budget.ceiling} lines outside the ${Object.keys(budget.allow).length} files allowed to shrink ` +
    `and the ${Object.keys(budget.exempt ?? {}).length} exempt entries. Read ${read} files under ${ROOTS.join(', ')}; ` +
    'the graph takes TypeScript, JavaScript and Svelte scripts, the size check every one',
);
