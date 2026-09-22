import { readdirSync, readFileSync } from 'node:fs';
import { boundaryViolations, cycles, dependencyGraph, type Sources } from './graph.ts';

const sources: Sources = new Map();
function read(directory: string): void {
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = `${directory}/${entry.name}`;
    if (entry.isDirectory()) read(file);
    else if (/\.(?:ts|js)$/.test(file) && !/\.(?:test|d)\.ts$/.test(file)) sources.set(file, readFileSync(file, 'utf8'));
  }
}
for (const root of ['packages/contracts/src', 'packages/core/src', 'packages/ui/src']) read(root);
const graph = dependencyGraph(sources);
const errors = [...boundaryViolations(graph), ...cycles(graph).map(cycle => `runtime cycle: ${cycle}`)];
if (errors.length) throw new Error(`Architecture check failed:\n${errors.join('\n')}`);
console.log(`Architecture passed: ${graph.size} modules, no runtime cycles or forbidden imports`);
