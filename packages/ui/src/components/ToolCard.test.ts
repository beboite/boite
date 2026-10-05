import { afterEach, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import ToolCard from './ToolCard.svelte';

let running: Record<string, unknown> | null = null;

afterEach(() => {
  if (running) unmount(running, { outro: false });
  running = null;
  document.body.innerHTML = '';
});

function query<T extends Element>(selector: string): T {
  const node = document.querySelector<T>(selector);
  if (!node) throw new Error(`no ${selector}`);
  return node;
}

/** Eight keys, so the pretty printed json is ten lines: past the six-line cut. */
const LONG_INPUT = {
  file_path: 'packages/core/src/main.ts',
  offset: 1,
  limit: 200,
  encoding: 'utf8',
  follow: false,
  retries: 2,
  timeoutMs: 5000,
  reason: 'read the entry point'
};

function openCard(input: unknown): void {
  running = mount(ToolCard, {
    target: document.body,
    props: { name: 'Read', input, output: 'ok', status: 'done' as const }
  });
  flushSync();
  query<HTMLButtonElement>('[data-testid=tool-toggle]').click();
  flushSync();
}

test('a folded output fetches on disclosure, reports failure and retries on reopening', async () => {
  const loadOutput = vi.fn().mockRejectedValueOnce(new Error('output unavailable')).mockResolvedValueOnce(undefined);
  running = mount(ToolCard, { target: document.body, props: { name: 'Bash', input: { command: 'report' }, output: 'preview', outputDeferred: true, loadOutput, status: 'done' } });
  flushSync();
  expect(loadOutput).not.toHaveBeenCalled();
  query<HTMLButtonElement>('[data-testid=tool-toggle]').click(); flushSync();
  expect(loadOutput).toHaveBeenCalledTimes(1);
  expect(document.querySelector('[data-testid=tool-output]')).toBeNull();
  await vi.waitFor(() => expect(document.querySelector('[role=alert]')?.textContent).toBe('output unavailable'));
  query<HTMLButtonElement>('[data-testid=tool-toggle]').click(); flushSync();
  query<HTMLButtonElement>('[data-testid=tool-toggle]').click(); flushSync();
  expect(loadOutput).toHaveBeenCalledTimes(2);
  await vi.waitFor(() => expect(document.querySelector('[data-testid=tool-output-loading]')).toBeNull());
  expect(document.querySelector('[role=alert]')).toBeNull();
});

test('a write whose input and diff stayed on the core waits folded, names its file and fetches only once opened', () => {
  const loadOutput = vi.fn().mockReturnValue(new Promise(() => {}));
  running = mount(ToolCard, { target: document.body, props: {
    name: 'Write', input: { file_path: '/repo/out.txt', content: 'cut' }, inputDeferred: true, output: 'written', status: 'done',
    documents: [{ kind: 'diff', path: '/repo/out.txt', oldText: '', newText: '' }], documentsDeferred: true, loadOutput,
  } });
  flushSync();
  const toggle = query<HTMLButtonElement>('[data-testid=tool-toggle]');
  // A whole diff would open the card and fetch megabytes for every write on screen.
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  expect(loadOutput).not.toHaveBeenCalled();
  expect(toggle.textContent).toContain('out.txt');
  expect(query('[data-testid=tool-document-chip]').textContent).toBe('1 diff');
  expect(document.querySelector('[data-testid=tool-diff-counts]')).toBeNull();
  toggle.click(); flushSync();
  expect(loadOutput).toHaveBeenCalledTimes(1);
  expect(document.querySelector('[data-testid=tool-output-loading]')).not.toBeNull();
  // Neither the cut input nor the empty stub is drawn as if it were the call.
  expect(document.querySelector('[data-testid=tool-input]')).toBeNull();
  expect(document.querySelector('[data-testid=tool-document]')).toBeNull();
});

test('a command stays a folded, stable line while its arguments stream', () => {
  const props = { name: 'Bash', input: {}, inputText: '{"command":"gi', output: null, status: 'running' as const };
  running = mount(ToolCard, { target: document.body, props });
  flushSync();
  const toggle = query<HTMLButtonElement>('[data-testid=tool-toggle]');
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  expect(document.querySelector('[data-testid=tool-input]')).toBeNull();
  expect(toggle.querySelector('.line')!.textContent).toBe('Running a command');
});

test('an expanded input past six lines opens cut, and Show all opens the rest', () => {
  openCard(LONG_INPUT);

  const pre = query<HTMLPreElement>('[data-testid=tool-input]');
  expect(pre.textContent?.split('\n').length).toBeGreaterThan(6);
  expect(pre.classList.contains('clamped')).toBe(true);

  // The text is whole under the cut: only the box is shorter, so a copy is complete.
  expect(pre.textContent).toContain('read the entry point');

  query<HTMLButtonElement>('[data-testid=tool-input-show-all]').click();
  flushSync();

  expect(query('[data-testid=tool-input]').classList.contains('clamped')).toBe(false);
  expect(document.querySelector('[data-testid=tool-input-show-all]')).toBeNull();
});

test('a short input has no cut and no Show all', () => {
  openCard({ file_path: 'packages/ui/src/app.css' });

  expect(query('[data-testid=tool-input]').classList.contains('clamped')).toBe(false);
  expect(document.querySelector('[data-testid=tool-input-show-all]')).toBeNull();
});

test('a failed edit claims no change: no counts, no diff drawn from what it meant to do', () => {
  running = mount(ToolCard, {
    target: document.body,
    props: { name: 'Edit', input: { file_path: 'src/a.ts', old_string: 'a', new_string: 'b' }, output: 'old_string not found', status: 'error' as const }
  });
  flushSync();
  expect(document.querySelector('[data-testid=tool-diff-counts]')).toBeNull();
  expect(document.querySelector('[data-testid=tool-error-preview]')).toBeNull();
  query<HTMLButtonElement>('[data-testid=tool-toggle]').click();
  flushSync();
  expect(document.querySelector('[data-testid=diff-view]')).toBeNull();
  expect(query('[data-testid=tool-output]').textContent).toContain('old_string not found');
});

test('a standalone command has a compact summary and preserves its full input on expansion', () => {
  const command = 'git status --short\ngit branch -vv\ngit remote -v';
  running = mount(ToolCard, {
    target: document.body,
    props: { name: 'Bash', input: { command }, output: 'clean', status: 'done' as const }
  });
  flushSync();
  expect(query('[data-testid=tool-toggle] .line').textContent).toBe('Ran 1 command');
  query<HTMLButtonElement>('[data-testid=tool-toggle]').click();
  flushSync();
  expect(query('[data-testid=tool-input]').textContent).toContain('git branch -vv');
  expect(query('[data-testid=tool-output]').textContent).toBe('clean');
});

test.each([
  ['bun test', 'bun test v1.4.2\n(pass) first case\n(fail) reload keeps messages\n 1 pass\n 1 fail', '(fail) reload keeps messages'],
  ['git rebase', 'Rebasing (1/1)\rAuto-merging docs/example.md\nCONFLICT (content): Merge conflict in docs/example.md\nerror: could not apply abc123', 'CONFLICT (content): Merge conflict in docs/example.md'],
  ['git status', 'Ordinary command output\n\u001b[31mfatal: not a git repository\u001b[0m', 'fatal: not a git repository'],
])('a failed %s keeps its diagnostic behind the disclosure', (command, output, diagnostic) => {
  running = mount(ToolCard, {
    target: document.body,
    props: { name: 'Bash', input: { command }, output, status: 'error' as const }
  });
  flushSync();
  expect(query('[data-testid=tool-toggle] .line').textContent).toBe('Ran 1 command');
  expect(document.querySelector('[data-testid=tool-error-preview]')).toBeNull();
  query<HTMLButtonElement>('[data-testid=tool-toggle]').click();
  flushSync();
  expect(query('[data-testid=tool-error-preview]').textContent).toBe(diagnostic);
  expect(query('[data-testid=tool-output]').textContent).toBe(output);
});

test('a failed command retains its exit code and puts the explanation behind the disclosure', () => {
  running = mount(ToolCard, {
    target: document.body,
    props: { name: 'Bash', input: { command: 'git status 2>/dev/null' }, output: 'Earlier successful output', status: 'error' as const, exitCode: 128 }
  });
  flushSync();
  expect(query('[data-testid=tool-exit-code]').textContent).toBe('Exit code 128');
  expect(document.querySelector('[data-testid=tool-error-preview]')).toBeNull();
  query<HTMLButtonElement>('[data-testid=tool-toggle]').click();
  flushSync();
  expect(query('[data-testid=tool-error-preview]').textContent).toBe('No diagnostic was reported. See the full output below.');
});

test('successful stderr output stays folded as a successful command', () => {
  running = mount(ToolCard, {
    target: document.body,
    props: { name: 'Bash', input: { command: 'git fetch' }, output: 'warning: progress on stderr\nerror: quoted from documentation', status: 'done' as const, exitCode: 0 }
  });
  flushSync();
  expect(query('[data-testid=tool-card]').getAttribute('data-status')).toBe('done');
  expect(query('[data-testid=tool-toggle] .line').textContent).toBe('Ran 1 command');
  expect(document.querySelector('[data-testid=tool-error-preview]')).toBeNull();
  expect(document.querySelector('[data-testid=tool-exit-code]')).toBeNull();
});

test('a command\'s one diff keeps its heading, since the command does not name the file', () => {
  const diff = { kind: 'diff' as const, path: 'src/a.ts', oldText: 'a\n', newText: 'b\n' };
  running = mount(ToolCard, {
    target: document.body,
    props: { name: 'Bash', input: { command: 'git apply fix.patch' }, output: '', status: 'done' as const, documents: [diff] }
  });
  flushSync();
  expect(query('[data-testid=diff-view] .path').textContent).toBe('src/a.ts');
  unmount(running, { outro: false });
  running = mount(ToolCard, {
    target: document.body,
    props: { name: 'Edit', input: { file_path: 'src/a.ts' }, output: '', status: 'done' as const, documents: [diff] }
  });
  flushSync();
  expect(document.querySelector('[data-testid=diff-view] .path')).toBeNull();
});
