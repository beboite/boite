import { expect, test } from 'bun:test';
import type { BrowserDaemon } from '../packages/core/src/browser/daemon.ts';
import { LunaPage } from './browser-luna-page.ts';
import type { WideTask } from './browser-wide-tasks.ts';

const task: WideTask = {
  id: 'test', site: 'example', category: 'test', goal: 'Fill search',
  url: 'https://example.com/start', values: { search: 'hello' },
  completion: { text: 'done' }, grader: { all: [{ kind: 'text', contains: 'done' }] },
};

function page() {
  let url = task.url;
  const calls: { action: string; args: Record<string, unknown> }[] = [];
  const daemon = {
    async command(action: string, args: Record<string, unknown>) {
      calls.push({ action, args });
      if (action === 'evaluate') {
        if (String(args.script).includes('querySelectorAll')) return { result: [] };
        return { result: { url, title: 'Example', text: 'Search' } };
      }
      if (action === 'snapshot') return { snapshot: '- textbox "Search" [ref=e1]\n', refs: { e1: { role: 'textbox', name: 'Search' } } };
      return {};
    },
  } as unknown as BrowserDaemon;
  return { adapter: new LunaPage(daemon, task), calls, setUrl(value: string) { url = value; } };
}

test('rejects unknown actions, arbitrary scripts, and unobserved selectors', async () => {
  const { adapter, calls } = page();
  await expect(adapter.execute({ action: 'navigate', url: 'https://example.com/goal' })).rejects.toThrow('unavailable');
  await expect(adapter.execute({ action: 'evaluate', script: 'document.cookie' })).rejects.toThrow('unavailable');
  await expect(adapter.execute({ action: 'click', selector: '#hidden' })).rejects.toThrow('not observed');
  expect(calls.every(call => call.action !== 'click')).toBe(true);
  expect(adapter.attempts.map(attempt => attempt.success)).toEqual([false, false, false]);
});

test('observed ref permits one action and then requires a fresh snapshot', async () => {
  const { adapter, calls } = page();
  await adapter.observe();
  await adapter.execute({ action: 'fill', selector: '@e1', value: 'hello' });
  expect(adapter.actionCount).toBe(1);
  expect(calls.some(call => call.action === 'fill' && call.args.selector === '@e1')).toBe(true);
  // The successful mutation returns a fresh observation and ref.
  await adapter.execute({ action: 'fill', selector: '@e1', value: 'hello' });
  expect(adapter.actionCount).toBe(2);
});

test('rejects a changed origin before any action', async () => {
  const { adapter, calls, setUrl } = page();
  await adapter.observe();
  setUrl('https://other.example/path');
  await expect(adapter.execute({ action: 'click', selector: '@e1' })).rejects.toThrow('starting origin');
  expect(calls.every(call => call.action !== 'click')).toBe(true);
  expect(adapter.urls.at(-1)).toBe('https://other.example/path');
});

test('counts attempted actions against the shared thirty action limit', async () => {
  const { adapter, calls } = page();
  adapter.actionCount = 30;
  await adapter.observe();
  await expect(adapter.execute({ action: 'fill', selector: '@e1', value: 'hello' })).rejects.toThrow('limit of 30');
  expect(calls.every(call => call.action !== 'fill')).toBe(true);
});

test('default observation exposes page-derived options for the next select', async () => {
  const calls: { action: string; args: Record<string, unknown> }[] = [];
  const daemon = {
    async command(action: string, args: Record<string, unknown>) {
      calls.push({ action, args });
      if (action === 'evaluate' && String(args.script).includes('querySelectorAll')) return { result: [{ selector: '#language', tag: 'select', label: 'Language', options: [{ label: 'Français', value: 'fr' }] }] };
      if (action === 'evaluate') return { result: { url: task.url, title: 'Example', text: 'Language' } };
      if (action === 'snapshot') return { snapshot: '- combobox "Language" [ref=e1]\n', refs: { e1: { role: 'combobox', name: 'Language' } } };
      return {};
    },
  } as unknown as BrowserDaemon;
  const adapter = new LunaPage(daemon, task);
  const observed = await adapter.observe();
  expect(observed.fields[0]?.selector).toBe('#language');
  await expect(adapter.execute({ action: 'select', selector: '#language', value: 'German' })).rejects.toThrow('not observed');
  await adapter.execute({ action: 'select', selector: '#language', value: 'Français' });
  expect(calls.find(call => call.action === 'select')?.args).toEqual({ selector: '#language', values: 'fr', timeout: 5000 });
});

test('starts with the earlier browser leg for visited-url grading', async () => {
  const { calls } = page();
  const daemon = {
    async command(action: string, args: Record<string, unknown>) {
      calls.push({ action, args });
      if (action === 'evaluate') return { result: { url: task.url, title: 'Example', text: 'done', controls: {} } };
      return {};
    },
  } as unknown as BrowserDaemon;
  const gradedTask: WideTask = { ...task, grader: { all: [{ kind: 'visited-url', pathname: '/before' }] } };
  const adapter = new LunaPage(daemon, gradedTask, 2, ['https://example.com/before']);
  const evidence = await adapter.finalEvidence();
  expect(evidence.grading.passed).toBe(true);
  expect(adapter.urls).toEqual(['https://example.com/before', task.url]);
});

test('observation retries once when the URL changes mid-capture', async () => {
  let stateReads = 0;
  const daemon = {
    async command(action: string, args: Record<string, unknown>) {
      if (action === 'evaluate' && String(args.script).includes('querySelectorAll')) return { result: [] };
      if (action === 'evaluate') {
        stateReads++;
        const changed = stateReads >= 2;
        return { result: { url: changed ? 'https://example.com/next' : task.url, title: changed ? 'Next' : 'Start', text: changed ? 'new page' : 'old page' } };
      }
      if (action === 'snapshot') return { snapshot: '- button "Continue" [ref=e1]\n', refs: { e1: { role: 'button', name: 'Continue' } } };
      return {};
    },
  } as unknown as BrowserDaemon;
  const adapter = new LunaPage(daemon, task);
  const observed = await adapter.observe();
  expect(observed.url).toBe('https://example.com/next');
  expect(observed.text).toBe('new page');
  expect(stateReads).toBe(4);
});

test('unstable inspection clears stale selectors before any action', async () => {
  let stateReads = 0;
  const calls: string[] = [];
  const daemon = {
    async command(action: string, args: Record<string, unknown>) {
      calls.push(action);
      if (action === 'evaluate' && String(args.script).includes('querySelectorAll')) return { result: [{ selector: '#old', tag: 'button', label: 'Old' }] };
      if (action === 'evaluate') {
        stateReads++;
        return { result: { url: `https://example.com/page${stateReads}`, title: 'Moving', text: '' } };
      }
      return {};
    },
  } as unknown as BrowserDaemon;
  const adapter = new LunaPage(daemon, task);
  await expect(adapter.execute({ action: 'inspect' })).rejects.toThrow('two consecutive inspections');
  await expect(adapter.execute({ action: 'click', selector: '#old' })).rejects.toThrow('not observed');
  expect(calls.includes('click')).toBe(false);
});

test('batch validates every command before sending the first action', async () => {
  const { adapter, calls } = page();
  await adapter.observe();
  await expect(adapter.executeBatch({ commands: [
    { action: 'fill', selector: '@e1', value: 'hello' },
    { action: 'navigate', url: 'https://example.com/goal' },
  ] })).rejects.toThrow('unavailable');
  await expect(adapter.executeBatch({ commands: [
    { action: 'fill', selector: '@e1', value: 'hello' },
    { action: 'click', selector: '#unseen' },
  ] })).rejects.toThrow('not observed');
  expect(calls.every(call => call.action !== 'fill')).toBe(true);
  expect(adapter.actionCount).toBe(0);
});

test('batch stops on the first action error and returns a fresh observation', async () => {
  const calls: string[] = [];
  const daemon = {
    async command(action: string, args: Record<string, unknown>) {
      calls.push(action);
      if (action === 'evaluate' && String(args.script).includes('querySelectorAll')) return { result: [] };
      if (action === 'evaluate') return { result: { url: task.url, title: 'Example', text: 'Search' } };
      if (action === 'snapshot') return { snapshot: '- textbox "Search" [ref=e1]\n- button "Fail" [ref=e2]\n- button "Later" [ref=e3]\n', refs: { e1: { role: 'textbox', name: 'Search' }, e2: { role: 'button', name: 'Fail' }, e3: { role: 'button', name: 'Later' } } };
      if (action === 'click' && args.selector === '@e2') throw new Error('button failed');
      return {};
    },
  } as unknown as BrowserDaemon;
  const adapter = new LunaPage(daemon, task);
  await adapter.observe();
  const batch = await adapter.executeBatch({ commands: [
    { action: 'fill', selector: '@e1', value: 'hello' },
    { action: 'click', selector: '@e2' },
    { action: 'click', selector: '@e3' },
  ] });
  expect(batch.results.map(result => result.success)).toEqual([true, false]);
  expect((batch.observation as { url: string }).url).toBe(task.url);
  expect(calls.filter(action => action === 'click')).toHaveLength(1);
  expect(adapter.actionCount).toBe(2);
});

test('snapshot query reaches a ref beyond the default snapshot limit', async () => {
  const calls: string[] = [];
  const fullSnapshot = `${Array.from({ length: 400 }, (_, index) => `- paragraph "ordinary line ${index} with enough content to exceed the default limit"`).join('\n')}\n- button "Special target" [ref=e99]\n`;
  const daemon = {
    async command(action: string, args: Record<string, unknown>) {
      calls.push(action);
      if (action === 'evaluate' && String(args.script).includes('querySelectorAll')) return { result: [] };
      if (action === 'evaluate') return { result: { url: task.url, title: 'Example', text: 'Special target' } };
      if (action === 'snapshot') return { snapshot: fullSnapshot, refs: { e99: { role: 'button', name: 'Special target' } } };
      return {};
    },
  } as unknown as BrowserDaemon;
  const adapter = new LunaPage(daemon, task);
  const first = await adapter.observe();
  expect(first.truncated).toBe(true);
  expect(first.snapshot).not.toContain('Special target');
  await expect(adapter.execute({ action: 'click', selector: '@e99' })).rejects.toThrow('not observed');
  const found = await adapter.execute({ action: 'snapshot', query: 'SPECIAL TARGET' }) as Awaited<ReturnType<LunaPage['observe']>>;
  expect(found.snapshot).toContain('ref=e99');
  expect(found.matchingLines).toBe(1);
  expect(found.totalLines).toBe(401);
  expect(found.returnedLines).toBe(1);
  await adapter.execute({ action: 'click', selector: '@e99' });
  expect(calls.filter(action => action === 'click')).toHaveLength(1);
});

test('read-only batch can refresh after the page navigates', async () => {
  const { adapter, setUrl } = page();
  await adapter.observe();
  setUrl('https://example.com/next');
  const batch = await adapter.executeBatch({ commands: [{ action: 'snapshot' }] });
  expect(batch.results).toEqual([{ command: { action: 'snapshot' }, success: true }]);
  expect((batch.observation as { url: string }).url).toBe('https://example.com/next');
});
