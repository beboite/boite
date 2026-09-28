import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Reuse the UI's XML parser; do not infer test results from console verbosity.
const { JSDOM } = createRequire(join(import.meta.dir, '../packages/ui/package.json'))('jsdom');

export function readE2eReport(path: string) {
  const dom = new JSDOM(readFileSync(path, 'utf8'), { contentType: 'application/xml' });
  try {
    const document: Document = dom.window.document;
    const root = document.documentElement;
    if (root.tagName !== 'testsuites') throw new Error(`${path}: expected Bun's testsuites report`);
    const count = (name: string): number => {
      const value = root.getAttribute(name);
      if (value === null || !/^\d+$/.test(value)) throw new Error(`${path}: expected numeric ${name}`);
      return Number(value);
    };
    const tests = count('tests');
    const failures = count('failures');
    const skipped = count('skipped');
    const nodes = [...document.querySelectorAll('testcase')];
    const cases = nodes.filter((node) => !node.querySelector('failure, error, skipped')).map((node) => {
      const file = node.getAttribute('file');
      const name = node.getAttribute('name');
      if (!file || !name) throw new Error(`${path}: testcase needs file and name`);
      const group = node.getAttribute('classname');
      return `${file.replaceAll('\\', '/')}: ${group ? `${group} > ` : ''}${name}`;
    });
    if (nodes.length !== tests || cases.length !== tests - failures - skipped) {
      throw new Error(`${path}: testcase identities disagree with the reported totals`);
    }
    return { cases, tests, failures, skipped, assertions: count('assertions') };
  } finally { dom.window.close(); }
}
