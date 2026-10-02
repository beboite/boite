import { expect, test } from 'vitest';
import type { MessagePart } from '@boite/contracts';
import { liveLabel, partRuns, programOf, runSummary, toolLine, unwrapCommand, type ToolPart } from './tool-groups';

function tool(name: string, input: unknown, extra: Partial<ToolPart> = {}): ToolPart {
  return { type: 'tool', toolId: `${name}-${JSON.stringify(input)}`, name, input, output: 'ok', status: 'done', ...extra };
}

test('a shell wrapper reads as the command it runs', () => {
  expect(unwrapCommand(`"C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\pwsh.exe" -Command 'git status --short'`)).toBe('git status --short');
  expect(unwrapCommand(`pwsh -NoProfile -Command "bun run check"`)).toBe('bun run check');
  expect(unwrapCommand(`cmd.exe /c dir /b`)).toBe('dir /b');
  expect(unwrapCommand(`/bin/bash -lc 'ls -la'`)).toBe('ls -la');
  expect(unwrapCommand(`bash -c "pwsh -Command 'git log -1'"`)).toBe('git log -1');
  // Not a wrapper, or a quote left open: as sent.
  expect(unwrapCommand('git diff --stat')).toBe('git diff --stat');
  expect(unwrapCommand(`pwsh -Command 'unterminated`)).toBe(`pwsh -Command 'unterminated`);
});

test('the program of a command skips where it runs and what it sets', () => {
  expect(programOf('cd packages/ui && bun run test')).toBe('bun');
  expect(programOf(`pwsh -Command 'Set-Location D:/x; git status'`)).toBe('git');
  expect(programOf('FOO=1 BAR=2 node script.mjs')).toBe('node');
  expect(programOf(`& "C:\\Program Files\\Go\\bin\\go.exe" test ./...`)).toBe('go');
  expect(programOf('rg -n boite | head')).toBe('rg');
});

test('a run of calls reads as one sentence, edits counted by file', () => {
  const parts = [
    tool('Bash', { command: 'git status' }),
    tool('Read', { file_path: 'src/a.ts' }),
    tool('Bash', { command: 'bun test' }),
    tool('Edit', { file_path: 'src/a.ts', old_string: 'a', new_string: 'b' }),
    tool('Edit', { file_path: 'src/a.ts', old_string: 'b', new_string: 'c' }),
    tool('Write', { file_path: 'src/b.ts', content: 'x' })
  ];
  expect(runSummary(parts)).toBe('Ran 2 commands, read 1 file and changed 2 files');
  expect(runSummary([tool('Grep', { pattern: 'x' })])).toBe('Searched the code once');
  expect(runSummary([
    tool('Edit', { file_path: 'x', old_string: 'a', new_string: 'b' }, { status: 'error' }),
    tool('Bash', { command: 'git status' }, { status: 'denied' })
  ])).toBe('Attempted 2 calls');
});

test('a call reads as its command, or as a sentence in the tense it is in', () => {
  expect(toolLine(tool('Bash', { command: `pwsh -Command 'git status'` }))).toMatchObject({ text: 'git status', mono: true });
  expect(toolLine(tool('Read', { file_path: 'packages/ui/src/app.css' }))).toMatchObject({ text: 'Read app.css', mono: false, title: 'packages/ui/src/app.css' });
  expect(toolLine(tool('Read', { file_path: 'a/b.ts' }, { status: 'running' })).text).toBe('Reading b.ts');
  expect(toolLine(tool('mcp__boite__whereami', {})).text).toBe('mcp__boite__whereami');
  expect(liveLabel(tool('Bash', { command: 'cd x && cargo build' }, { status: 'running' }))).toBe('Running cargo');
});

test('calls fold into runs that text, a question or a produced document breaks', () => {
  const parts: MessagePart[] = [
    { type: 'thinking', text: 'hm' },
    tool('Bash', { command: 'a' }),
    { type: 'text', text: '' },
    tool('Bash', { command: 'b' }),
    { type: 'text', text: 'Found it.' },
    tool('Read', { file_path: 'x' }),
    tool('Edit', { file_path: 'x' }, { documents: [{ kind: 'diff', path: 'x', oldText: '', newText: 'y' }] }),
    tool('Read', { file_path: 'y' })
  ];
  expect(partRuns(parts)).toEqual([
    { kind: 'part', index: 0 },
    { kind: 'tools', indices: [1, 3] },
    { kind: 'part', index: 4 },
    { kind: 'tools', indices: [5] },
    { kind: 'tools', indices: [6] },
    { kind: 'tools', indices: [7] }
  ]);
});

test('successful file changes stand alone while failed attempts stay in their run', () => {
  const parts: MessagePart[] = [
    tool('Read', { file_path: 'x' }),
    tool('Edit', { file_path: 'x', old_string: 'a', new_string: 'b' }),
    tool('Read', { file_path: 'y' }),
    tool('Edit', { file_path: 'y', old_string: 'a', new_string: 'b' }, { status: 'error' }),
    tool('Read', { file_path: 'z' })
  ];
  expect(partRuns(parts)).toEqual([
    { kind: 'tools', indices: [0] },
    { kind: 'tools', indices: [1] },
    { kind: 'tools', indices: [2, 3, 4] }
  ]);
});

test('reasoning between calls breaks their group and keeps both thinking steps visible', () => {
  expect(partRuns([
    { type: 'thinking', text: 'Inspecting' },
    tool('Read', { file_path: 'a.ts' }),
    { type: 'thinking', text: 'Checking' },
    tool('Read', { file_path: 'b.ts' })
  ])).toEqual([
    { kind: 'part', index: 0 }, { kind: 'tools', indices: [1] },
    { kind: 'part', index: 2 }, { kind: 'tools', indices: [3] }
  ]);
});

test('command inputs using cmd keep their family and live program label', () => {
  const part = tool('exec_command', { cmd: 'pwsh -NoProfile -Command "git status --short"' });
  expect(runSummary([part])).toBe('Ran 1 command');
  expect(liveLabel(part)).toBe('Running git');
  expect(toolLine(part).text).toBe('git status --short');
});

test('a proposed plan is a part of its own, never folded into the calls around it', () => {
  const parts: MessagePart[] = [
    tool('Read', { file_path: 'a.ts' }),
    tool('Grep', { pattern: 'x' }),
    tool('ExitPlanMode', { plan: '# Plan\n1. Do it' }),
    tool('Read', { file_path: 'b.ts' })
  ];
  expect(partRuns(parts)).toEqual([
    { kind: 'tools', indices: [0, 1] },
    { kind: 'part', index: 2 },
    { kind: 'tools', indices: [3] }
  ]);
});
