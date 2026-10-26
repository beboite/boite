import { expect, test } from 'bun:test';
import { withoutFences } from '../check-docs.ts';

test('a fenced block leaves the link check, and a fence written inside a sentence does not open one', () => {
  const source = [
    'A ```` ```view ```` block is a page, see [view blocks](diagrams.md).',
    '',
    '```text',
    '![Orbit](.boite/views/orbit.html)',
    '```',
    '',
    '~~~',
    '[inside tildes](missing.md)',
    '~~~~',
    '',
    '```md',
    '[closed by a longer run](missing.md)',
    '````',
    '',
    'After them: [kept](kept.md).'
  ].join('\n');
  const left = withoutFences(source);
  expect(left).toContain('[view blocks](diagrams.md)');
  expect(left).toContain('[kept](kept.md)');
  expect(left).not.toContain('orbit.html');
  expect(left).not.toContain('missing.md');
});

test('a fence closes only on its own marker, never on a shorter run', () => {
  const source = ['````md', '```', '[still inside](missing.md)', '````', '[after](kept.md)'].join('\n');
  const left = withoutFences(source);
  expect(left).not.toContain('missing.md');
  expect(left).toContain('[after](kept.md)');
  expect(withoutFences(['~~~', '```', '[inside](missing.md)', '~~~'].join('\n'))).not.toContain('missing.md');
});
