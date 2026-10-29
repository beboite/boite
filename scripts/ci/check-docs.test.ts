import { expect, test } from 'bun:test';
import { unclosedFence, withoutFences } from '../check-docs.ts';

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
  // A file with Windows line ends closes its fences the same way.
  const crlf = withoutFences(['```md', '[inside](missing.md)', '```', '[after](kept.md)'].join('\r\n'));
  expect(crlf).not.toContain('missing.md');
  expect(crlf).toContain('[after](kept.md)');
  expect(unclosedFence(['```md', 'x', '```'].join('\r\n'))).toBeNull();
});

test('a fence in a numbered step leaves the check, a marker indented as code opens none', () => {
  expect(withoutFences(['1. Run it:', '', '   ```powershell', '   [inside](missing.md)', '   ```'].join('\n'))).not.toContain('missing.md');
  expect(withoutFences(['    ~~~', '', '[after indented code](missing.md)', '~~~'].join('\n'))).toContain('missing.md');
});

test('a fence never closed is refused at its line, whether it ends a file or a list item', () => {
  expect(unclosedFence(['[before](kept.md)', '', '```md', '[inside](missing.md)'].join('\n'))).toBe(3);
  expect(unclosedFence(['- Example:', '  ```ts', '  code', '', '[after the list](missing.md)'].join('\n'))).toBe(2);
  // Closed blocks before it keep its line number, and a span of backticks in a sentence opens none.
  expect(unclosedFence(['```', 'a', '```', 'A ```` ```view ```` span.', '~~~'].join('\n'))).toBe(5);
  expect(unclosedFence(['```md', 'a', '```', '', '    ```'].join('\n'))).toBeNull();
});
