import { expect, test } from 'vitest';
import type { MessagePart } from '@boite/contracts';
import { MessageRuns } from './memory-timeline';
import { activityShown, agentSummary, commandOf, liveLabel, pairPermissions, partRuns, programOf, runKey, runSpan, runSummary, thinkingShown, ThoughtTitleScan, thoughtTitle, toolLine, unwrapCommand, type ToolPart } from './tool-groups';

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

test('a run reads as the agent\'s own summaries only when every call has one', () => {
  const read = tool('Read', { file_path: 'rules.md' }, { summary: 'Read rules.md and data.txt' });
  const again = tool('Read', { file_path: 'data.txt' }, { summary: ' Read rules.md and data.txt ' });
  const count = tool('Bash', { command: 'wc -l data.txt' }, { summary: 'Counted the rows' });
  expect(agentSummary([read, again])).toBe('Read rules.md and data.txt');
  expect(agentSummary([read, again, count])).toBe('Read rules.md and data.txt · Counted the rows');
  // The last batch's line not in yet, or an agent that writes none: the counted sentence.
  expect(agentSummary([read, tool('Bash', { command: 'ls' })])).toBeNull();
  expect(agentSummary([])).toBeNull();
});

test('a thought reads as its latest heading, else the first sentence of where it stands', () => {
  expect(thoughtTitle('**Inspecting the driver**\n\nThe session reads options.\n\n**Checking the tests**\n\nThere are three.')).toBe('Checking the tests');
  expect(thoughtTitle('Testing N=1 gives one prime, so that fails. Trying N=2 next.')).toBe('Testing N=1 gives one prime, so that fails');
  expect(thoughtTitle('First idea.\n\nThe rows live in data.txt and rules.md hold the rule? Probably')).toBe('The rows live in data.txt and rules.md hold the rule?');
  // Still streaming: the words so far, markdown taken off.
  expect(thoughtTitle('- Reading `turn.ts` for the **thinking** path')).toBe('Reading turn.ts for the thinking path');
  expect(thoughtTitle('')).toBeNull();
  expect(thoughtTitle('  \n\n ')).toBeNull();
});

/** thoughtTitle as it read the whole text on every call, the rule the scan must keep. */
function wholeTitle(text: string): string | null {
  const heading = [...text.matchAll(/^[\t ]*\*\*([^*\r\n]+)\*\*[\t ]*\r?$/gm)].at(-1)?.[1]?.trim();
  if (heading) return heading;
  const paragraph = text.split(/\n[\t ]*\n/).map((block) => block.trim()).filter(Boolean).at(-1);
  if (!paragraph) return null;
  const line = (paragraph.split('\n')[0] ?? '').replace(/\*\*|__|`/g, '').replace(/^[#>*\-\s]+/, '').trim();
  const end = line.search(/[.!?](\s|$)/);
  const sentence = (end === -1 ? line : line.slice(0, end + 1)).replace(/\.$/, '').trim();
  return sentence || null;
}

test('a thought read one character at a time has the title of its whole text at every length', () => {
  const texts = [
    '**Inspecting the driver**\n\nThe session reads options.\n\n**Checking the tests**\n\nThere are three.',
    'Testing N=1 gives one prime, so that fails. Trying N=2 next.',
    'First idea.\n\nThe rows live in data.txt and rules.md hold the rule? Probably',
    '- Reading `turn.ts` for the **thinking** path',
    '  \n\n ',
    '**A**\r\n\r\nWords.\r\n**  **\r\nAfter the blank heading',
    'One.\n\n\n\nTwo\n \n\t\nThree\n\r\nstill three\n\n',
    'x\r**Under a carriage return**\nthen\u2028**Past a line separator**\u2029tail'
  ];
  // Short random texts over the characters every rule turns on, from a fixed seed.
  let seed = 7;
  const alphabet = ['*', '*', '\n', '\n', '\r', ' ', '\t', 'a', '.', '#', '-', '`', '\u2028', '\u00a0'];
  for (let count = 0; count < 300; count += 1) {
    let text = '';
    for (let length = 0; length < 40; length += 1) {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      text += alphabet[seed % alphabet.length];
    }
    texts.push(text);
  }
  for (const text of texts) {
    const scan = new ThoughtTitleScan();
    for (let length = 0; length <= text.length; length += 1) {
      const prefix = text.slice(0, length);
      expect(scan.title(prefix), JSON.stringify(prefix)).toBe(wholeTitle(prefix));
    }
    // A text that does not extend the last one starts over.
    expect(scan.title('Another thought.')).toBe('Another thought');
  }
});

test('a call reads as its command, or as a sentence in the tense it is in', () => {
  expect(toolLine(tool('Bash', { command: `pwsh -Command 'git status'` }))).toMatchObject({ text: 'git status', mono: true });
  expect(toolLine(tool('Read', { file_path: 'packages/ui/src/app.css' }))).toMatchObject({ text: 'Read app.css', mono: false, title: 'packages/ui/src/app.css' });
  expect(toolLine(tool('Read', { file_path: 'a/b.ts' }, { status: 'running' })).text).toBe('Reading b.ts');
  expect(toolLine(tool('mcp__boite__whereami', {})).text).toBe('mcp__boite__whereami');
  expect(liveLabel(tool('Bash', { command: 'cd x && cargo build' }, { status: 'running' }))).toBe('Running cargo build');
});

test('a running command says what it is for, else the program and its subcommands', () => {
  // The agent's own words while the command runs, not the bare name of the CLI it calls.
  const described = tool('Bash', { command: 'boite threads send thr_1 "redo the titled assets"', description: 'Ask the media step to redo the titled assets\nsecond line' }, { status: 'running' });
  expect(liveLabel(described)).toBe('Ask the media step to redo the titled assets');
  expect(liveLabel(tool('Bash', { command: 'boite threads send thr_1 "redo it"' }, { status: 'running' }))).toBe('Running boite threads send');
  expect(liveLabel(tool('PowerShell', { command: 'git -C D:/x status', description: '  ' }, { status: 'running' }))).toBe('Running git');
  expect(commandOf('FOO=1 bun run check --watch')).toBe('bun run check');
  expect(commandOf(`FOO="hello world" BAR='a b' gh repo create`)).toBe('gh repo create');
  expect(commandOf('cat package.json')).toBe('cat');
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
    { kind: 'activity', indices: [0, 1, 3] },
    { kind: 'part', index: 4 },
    { kind: 'activity', indices: [5] },
    { kind: 'activity', indices: [6] },
    { kind: 'activity', indices: [7] }
  ]);
});

test('runs never read the streaming last text, and keep their objects while parts arrive', () => {
  const streaming = { type: 'text' as const, get text(): string { throw new Error('the last text was read'); } };
  const parts: MessagePart[] = [tool('Read', { file_path: 'a' }), tool('Read', { file_path: 'b' }), streaming];
  expect(partRuns(parts)).toEqual([{ kind: 'activity', indices: [0, 1] }, { kind: 'part', index: 2 }]);

  const list = new MessageRuns();
  const settled: MessagePart[] = [tool('Read', { file_path: 'a' }), { type: 'text', text: 'Found it.' }, tool('Read', { file_path: 'b' })];
  const first = list.build(settled, []);
  expect(list.build(settled, [])).toBe(first);
  settled.push(tool('Read', { file_path: 'c' }));
  const grown = list.build(settled, []);
  expect(grown).toEqual([{ kind: 'activity', indices: [0] }, { kind: 'part', index: 1 }, { kind: 'activity', indices: [2, 3] }]);
  expect(grown[0]).toBe(first[0]);
  expect(grown[1]).toBe(first[1]);
  expect(grown[2]).not.toBe(first[2]);
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
    { kind: 'activity', indices: [0] },
    { kind: 'activity', indices: [1] },
    { kind: 'activity', indices: [2, 3, 4] }
  ]);
  expect(partRuns(parts, 0, parts.length, true)).toEqual([{ kind: 'activity', indices: [0, 1, 2, 3, 4] }]);
});

test('reasoning folds into the calls around it so one stretch of work is one run', () => {
  expect(partRuns([
    { type: 'thinking', text: 'Inspecting' },
    tool('Read', { file_path: 'a.ts' }),
    { type: 'thinking', text: '', startedAt: 1000, finishedAt: 1200 },
    { type: 'text', text: ' ' },
    tool('Read', { file_path: 'b.ts' }),
    { type: 'thinking', text: '' },
    { type: 'text', text: 'Done.' },
    { type: 'thinking', text: 'After' }
  ])).toEqual([
    { kind: 'activity', indices: [0, 1, 2, 4, 5] },
    { kind: 'part', index: 6 },
    { kind: 'activity', indices: [7] }
  ]);
});

test('empty reasoning under a second is not drawn; words, a live clock or a whole second are', () => {
  const step = (text: string, startedAt?: number, finishedAt?: number | null) => ({ type: 'thinking' as const, text, startedAt, finishedAt });
  expect(thinkingShown(step('', 1000, 1900), false)).toBe(false);
  expect(thinkingShown(step(''), false)).toBe(false);
  expect(thinkingShown(step('', 1000, 2000), false)).toBe(true);
  expect(thinkingShown(step('hm', 1000, 1100), false)).toBe(true);
  expect(thinkingShown(step(''), true)).toBe(true);
  expect(activityShown([step('', 1000, 1100), step('')], false)).toBe(false);
  expect(activityShown([step('', 1000, 1100), step('')], true)).toBe(true);
  expect(runSpan([step('', 1000, 1500), tool('Read', { file_path: 'a' }, { startedAt: 1600, finishedAt: 9000 })])).toEqual({ start: 1000, end: 9000 });
});

test('command inputs using cmd keep their family and live program label', () => {
  const part = tool('exec_command', { cmd: 'pwsh -NoProfile -Command "git status --short"' });
  expect(runSummary([part])).toBe('Ran 1 command');
  expect(liveLabel(part)).toBe('Running git status');
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
    { kind: 'activity', indices: [0, 1] },
    { kind: 'part', index: 2 },
    { kind: 'activity', indices: [3] }
  ]);
});

test('a permission folds into the run of the call it gates, a call standing alone included, and pairs with the closest call of its name', () => {
  const bash = (toolId: string): ToolPart => ({ type: 'tool', toolId, name: 'Bash', input: { command: 'ls' }, output: null, status: 'done' });
  const edit: ToolPart = { type: 'tool', toolId: 'e', name: 'Edit', input: { file_path: 'a.ts', old_string: 'a', new_string: 'b' }, output: null, status: 'done' };
  const asked = (requestId: string, toolName: string) => ({ type: 'permission' as const, requestId, toolName, decision: 'allow' as const });
  expect(partRuns([edit, asked('p', 'Edit'), bash('b')])).toEqual([{ kind: 'activity', indices: [0, 1] }, { kind: 'activity', indices: [2] }]);
  expect(partRuns([bash('a'), asked('p', 'Bash'), { type: 'text', text: 'done' }])).toEqual([{ kind: 'activity', indices: [0, 1] }, { kind: 'part', index: 2 }]);
  // An earlier call that needed no answer gets no shield: the ask belongs to the call just before it.
  expect([...pairPermissions([bash('a'), bash('b'), asked('p', 'Bash')])]).toEqual([[2, 1]]);
  expect([...pairPermissions([bash('a'), asked('p', 'Bash'), bash('b'), asked('q', 'Bash')])]).toEqual([[1, 0], [3, 2]]);
  expect([...pairPermissions([asked('p', 'Bash'), bash('a')])]).toEqual([[0, 1]]);
  expect([...pairPermissions([asked('p', 'Bash'), edit, bash('a')])]).toEqual([[0, 2]]);
  // Calls that stand alone still take their permission, asked before or after them.
  expect(partRuns([asked('p', 'Edit'), edit])).toEqual([{ kind: 'activity', indices: [0, 1] }]);
  expect(partRuns([edit, bash('a'), asked('p', 'Edit')])).toEqual([{ kind: 'activity', indices: [0, 2] }, { kind: 'activity', indices: [1] }]);
  expect([...pairPermissions([bash('a'), asked('p', 'fake_tool')])]).toEqual([]);
  // Written text between them: the ask is for the call after it, not one before the paragraph.
  expect([...pairPermissions([bash('a'), { type: 'text', text: 'Now the build.' }, asked('p', 'Bash'), bash('b')])]).toEqual([[2, 3]]);
});

test('a permission asked before its call keeps the block it opened when the call arrives', () => {
  const asked = { type: 'permission' as const, requestId: 'p', toolName: 'Bash', decision: null };
  const call: ToolPart = { type: 'tool', toolId: 'b', name: 'Bash', input: { command: 'ls' }, output: null, status: 'running' };
  const [before] = partRuns([asked]);
  const [after] = partRuns([asked, call]);
  expect(after).toEqual({ kind: 'activity', indices: [0, 1] });
  expect(runKey(after!)).toBe(runKey(before!));
});
