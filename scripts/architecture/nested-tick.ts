import { readdirSync, readFileSync } from 'node:fs';

// Every directory `bun test` runs files from. packages/ui runs under Vitest, whose `expect` awaits for real.
export const BUN_TEST_ROOTS = ['packages/core', 'packages/contracts', 'tests', 'scripts', 'bench', 'apps/shell/scripts', 'telemetry'];

const MATCHER = /\.\s*(?:rejects|resolves)\b(?!\s*\()/;
const COMMENT = /^\s*(?:\/\/|\/?\*)/;

/** `file:line` of each promise matcher, which runs a nested event loop tick under `bun test`. */
export function nestedTickSites(sources: Map<string, string>): string[] {
  const sites: string[] = [];
  for (const [file, source] of sources) {
    source.split('\n').forEach((line, index) => {
      if (!COMMENT.test(line) && MATCHER.test(line)) sites.push(`${file}:${index + 1}`);
    });
  }
  return sites;
}

export function nestedTickViolations(sources: Map<string, string>): string[] {
  return nestedTickSites(sources).map(site =>
    `${site}: a rejects or resolves matcher runs a nested event loop tick under bun test, which drops socket events on macOS; ` +
    'await the promise, then match with thrown() or rejection() from packages/core/test/settle.ts ' +
    '(docs/development.md#promise-matchers-under-bun-test)');
}

export function readBunTestSources(roots = BUN_TEST_ROOTS): Map<string, string> {
  const sources = new Map<string, string>();
  const read = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'target') continue;
      const file = `${directory}/${entry.name}`;
      if (entry.isDirectory()) read(file);
      else if (/\.ts$/.test(entry.name)) sources.set(file, readFileSync(file, 'utf8'));
    }
  };
  for (const root of roots) read(root);
  return sources;
}
