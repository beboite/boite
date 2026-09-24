import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { reportMarkdown, runReport, sanitizeControls, sanitizeUrl, summarize, tokenUsage, toolAudit } from './browser-luna-report.ts';

const task = {
  id: 'public-form', site: 'Example', category: 'form', url: 'https://example.org/start?search=public',
  grader: { all: [{ kind: 'url', pathname: '/done', query: { search: 'public' } }, { kind: 'control', selector: '#age', value: '35' }] },
};

test('public URLs and fields exclude incidental credentials and controls', () => {
  expect(sanitizeUrl('https://example.org/done?search=public&token=private#access_token=private', task)).toEqual({
    value: 'https://example.org/done?search=public', redacted: true,
  });
  expect(sanitizeUrl('https://example.org/done?search=private', task)).toEqual({ value: 'https://example.org/done', redacted: true });
  expect(sanitizeUrl('https://user:password@example.org/done?search=public', task)).toEqual({ value: 'https://example.org/done?search=public', redacted: true });
  expect(sanitizeUrl('https://elsewhere.test/private?token=private', task)).toEqual({ value: null, redacted: true });
  expect(sanitizeControls({ '#age': [{ value: '35', checked: false }], '#secret': [{ value: 'private' }] }, task)).toEqual({ '#age': [{ value: '35', checked: false }] });
  expect(sanitizeControls({ '#age': [{ value: 'Bearer private' }] }, task)['#age']?.[0]?.value).toBe('[redacted]');
});

test('final cumulative usage drives uncached totals and unexpected tool types are counted', () => {
  const events = [
    { method: 'thread/tokenUsage/updated', params: { tokenUsage: { last: { inputTokens: 100, cachedInputTokens: 20 }, total: { inputTokens: 100, cachedInputTokens: 20 } } } },
    { method: 'thread/tokenUsage/updated', params: { tokenUsage: { last: { inputTokens: 100, cachedInputTokens: 80 }, total: { inputTokens: 300, cachedInputTokens: 200 } } } },
    { method: 'item/started', params: { item: { type: 'dynamicToolCall', tool: 'browser', arguments: { commands: [{ action: 'snapshot' }, { action: 'click' }] } } } },
    { method: 'item/started', params: { item: { type: 'commandExecution', command: 'private command' } } },
    { method: 'item/started', params: { item: { type: 'mcpToolCall', server: 'private' } } },
    { method: 'item/started', params: { item: { type: 'webSearch', query: 'private' } } },
    { method: 'item/started', params: { item: { type: 'agentMessage', text: 'private' } } },
  ];
  expect(tokenUsage(events).uncachedInputTokens).toBe(100);
  expect(tokenUsage(events).lastSumMatchesTotal).toBe(false);
  expect(toolAudit(events)).toEqual({ calls: 4, batchCommandsRequested: 2, unexpectedTypes: ['commandExecution', 'mcpToolCall', 'webSearch'] });
});

test('strict paired summary includes only completed attempts and emits no raw events', () => {
  const protocol = { date: '2026-09-24', tasks: [task], modes: ['luna', 'hybrid'], repetitions: 1, maxActions: 30, timeoutMs: 120000, viewport: { width: 1280, height: 800 }, files: {} };
  const direct = { verified: true, fallback: false, startupMs: 100, executionMs: 900, totalMs: 1000, actionCount: 2,
    final: { url: 'https://example.org/done?search=public&token=private', title: 'Example', controls: { '#age': [{ value: '35' }], '#private': [{ value: 'secret' }] } },
    grading: { checks: [true, true], passed: true }, processesAfter: 0,
    model: { config: { model: 'gpt-6-luna', effort: 'max', serviceTier: 'priority', provider: 'openai' }, turn: { status: 'completed' },
      events: [{ method: 'thread/tokenUsage/updated', params: { threadId: 'private-id', tokenUsage: { last: { inputTokens: 30, cachedInputTokens: 10 }, total: { inputTokens: 30, cachedInputTokens: 10 } } } }] },
    error: 'C:/private/path should not escape',
  };
  const hybrid = { verified: true, fallback: false, jevOutcome: { status: 'succeeded' }, startupMs: 100, executionMs: 400, totalMs: 500, actionCount: 1,
    final: { url: 'https://example.org/done?search=public', title: 'Example', controls: { '#age': [{ value: '35' }] } },
    grading: { checks: [true, true], passed: true }, processesAfter: 0 };
  const result = summarize(protocol, [{ task, mode: 'luna', run: 1, raw: direct }, { task, mode: 'hybrid', run: 1, raw: hybrid }], {}, 0);
  expect(result.paired.bothSuccessful).toBe(1);
  expect(result.paired.bothSuccessfulTimingMs.direct.medianMs).toBe(1000);
  expect(result.paired.bothSuccessfulTimingMs.hybrid.medianMs).toBe(500);
  expect(result.modelAudit.uncachedInputTokens).toBe(20);
  expect(result.cleanup).toEqual({ browserZero: 2, browserNonzeroOrMissing: 0, codexProcessesAfter: 0 });
  const publicJson = JSON.stringify(result);
  expect(publicJson).not.toContain('private-id');
  expect(publicJson).not.toContain('C:/private');
  expect(publicJson).not.toContain('#private');
  expect(publicJson).not.toContain('token=private');
  expect(reportMarkdown(result, [task])).toContain('[public result data](public-results.json)');
  const escaped = reportMarkdown(result, [{ ...task, site: 'Example\\|extra\r\nrow' }]);
  expect(escaped).toContain('| Example' + '\\'.repeat(3) + '|extra  row | public-form |');
});

test('all-attempt p90 retains a long failure outside successful timing', () => {
  const protocol = { date: '2026-09-24', tasks: [task], modes: ['luna', 'hybrid'], repetitions: 2, maxActions: 30, timeoutMs: 120000 };
  const samples = [
    { task, mode: 'luna', run: 1, raw: { verified: true, startupMs: 100, executionMs: 900, totalMs: 1000 } },
    { task, mode: 'luna', run: 2, raw: { verified: false, startupMs: 100, executionMs: 119900, totalMs: 120000 } },
  ];
  const result = summarize(protocol, samples);
  expect(result.modes.luna!.successfulTimingMs).toEqual({ medianMs: 1000, minMs: 1000, maxMs: 1000 });
  expect(result.modes.luna!.allTimingMs).toEqual({ n: 2, medianMs: 60500, p90Ms: 120000, minMs: 1000, maxMs: 120000 });
  expect(result.modes.luna!.failedTimingMs).toEqual({ n: 1, medianMs: 120000, p90Ms: 120000, minMs: 120000, maxMs: 120000 });
  expect(result.modes.hybrid!.allTimingMs).toEqual({ n: 0, medianMs: null, p90Ms: null, minMs: null, maxMs: null });
  const markdown = reportMarkdown(result, [task]);
  expect(markdown).toContain('All measured attempts median 60.50 s, p90 120.00 s');
  expect(markdown).toContain('nearest-rank');
});

test('a fallback without a recorded model or total duration remains missing', () => {
  const protocol = { date: '2026-09-24', tasks: [task], modes: ['luna', 'hybrid'], repetitions: 1, maxActions: 30, timeoutMs: 120000 };
  const result = summarize(protocol, [{ task, mode: 'hybrid', run: 1, raw: { verified: false, fallback: true, startupMs: 100, error: 'Browser connection is closed.' } }]);
  expect(result.modelAudit.expectedOnCompletedTrials).toBe(1);
  expect(result.modelAudit.recordedLegs).toBe(0);
  expect(result.modelAudit.missingRecords).toBe(1);
  expect(result.modelAudit.acknowledged).toBe(0);
  expect(result.modes.hybrid!.allTimingMs.n).toBe(0);
  expect(result.modes.hybrid!.failedTimingMs.n).toBe(0);
  expect(result.attempts[0]?.timingMs.total).toBeNull();
  const markdown = reportMarkdown(result, [task]);
  expect(markdown).toContain('0/0 recorded Luna legs; 1 expected trial, 1 missing record');
  expect(markdown).toContain('missing timing 1');
});

test('publication refuses pending trials unless partial is explicit', () => {
  const root = mkdtempSync(join(tmpdir(), 'boite-luna-report-'));
  const input = join(root, 'input'), output = join(root, 'output');
  try {
    mkdirSync(input);
    const files = Object.fromEntries(['browser-luna.ts', 'browser-luna-codex.ts', 'browser-luna-page.ts', 'browser-wide-tasks.ts', 'browser-wide-grade.ts', '../packages/core/src/browser/loop.ts'].map(file => [file, createHash('sha256').update(readFileSync(join(import.meta.dir, file))).digest('hex')]));
    writeFileSync(join(input, 'protocol.json'), JSON.stringify({ date: '2026-09-24', tasks: [task], modes: ['luna', 'hybrid'], repetitions: 1, maxActions: 30, timeoutMs: 120000, files }));
    expect(() => runReport(input, output)).toThrow('pending attempts');
    expect(runReport(input, output, true).totals.pending).toBe(2);
    expect(readFileSync(join(output, 'report.md'), 'utf8')).toContain('partial');
    writeFileSync(join(input, 'luna-public-form-1.json'), JSON.stringify({ verified: false, processesAfter: 0 }));
    writeFileSync(join(input, 'hybrid-public-form-1.json'), JSON.stringify({ verified: false, processesAfter: 0 }));
    expect(() => runReport(input, output)).toThrow('app-server cleanup');
    writeFileSync(join(input, 'cleanup.json'), JSON.stringify({ codexProcessesAfter: 0 }));
    expect(runReport(input, output).complete).toBe(true);
    files['browser-luna.ts'] = '0'.repeat(64);
    writeFileSync(join(input, 'protocol.json'), JSON.stringify({ date: '2026-09-24', tasks: [task], modes: ['luna', 'hybrid'], repetitions: 1, files }));
    expect(() => runReport(input, output, true)).toThrow('Source hash differs');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('historical reports require every frozen hash from the explicitly selected source tree', () => {
  const root = mkdtempSync(join(tmpdir(), 'boite-luna-historical-'));
  const input = join(root, 'input'), output = join(root, 'output'), source = join(root, 'historical', 'bench');
  const names = ['browser-luna.ts', 'browser-luna-codex.ts', 'browser-luna-page.ts', 'browser-wide-tasks.ts', 'browser-wide-grade.ts', '../packages/core/src/browser/loop.ts'];
  const files: Record<string, string> = {};
  try {
    mkdirSync(input, { recursive: true });
    for (const name of names) {
      const path = join(source, name);
      mkdirSync(dirname(path), { recursive: true });
      const content = `// Historical source fixture: ${name}\n`;
      writeFileSync(path, content);
      files[name] = createHash('sha256').update(content).digest('hex');
    }
    const protocol = { date: '2026-09-24', tasks: [task], modes: ['luna', 'hybrid'], repetitions: 1, maxActions: 30, timeoutMs: 120000, files };
    const save = () => writeFileSync(join(input, 'protocol.json'), JSON.stringify(protocol));
    save();
    expect(() => runReport(input, output, true)).toThrow('Source hash differs');
    expect(runReport(input, output, true, source).totals.pending).toBe(2);
    const helper = '// Frozen heartbeat helper\n';
    writeFileSync(join(source, 'browser-luna-commands.ts'), helper);
    files['browser-luna-commands.ts'] = createHash('sha256').update(helper).digest('hex'); save();
    expect(runReport(input, output, true, source).protocol.hashes.commandGate).toBe(files['browser-luna-commands.ts']);
    files['browser-luna-commands.ts'] = '0'.repeat(64); save();
    expect(() => runReport(input, output, true, source)).toThrow('Source hash differs');
    delete files['browser-luna-commands.ts']; save();
    const original = files['browser-luna.ts'];
    files['browser-luna.ts'] = '0'.repeat(64); save();
    expect(() => runReport(input, output, true, source)).toThrow('Source hash differs');
    delete files['browser-luna.ts']; save();
    expect(() => runReport(input, output, true, source)).toThrow('Missing source hash');
    files['browser-luna.ts'] = original!; save();
    writeFileSync(join(source, 'browser-luna.ts'), '// Changed historical source\n');
    expect(() => runReport(input, output, true, source)).toThrow('Source hash differs');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
