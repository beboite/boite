import { describe, expect, test } from 'bun:test';
import { validateBrowserRequest, browserCandidates, runBrowserLoop } from '../src/browser/loop.ts';

const request = { threadId: 't', pluginId: 'jev-browser', url: 'https://example.org/', goal: 'Enable updates and save', completion: { text: 'Saved' } };
test('browser requests require bounded tasks and an observable completion condition', () => {
  expect(validateBrowserRequest(request).maxSteps).toBe(20);
  for (const patch of [{ url: 'file:///private' }, { maxSteps: 999 }, { timeoutMs: 0 }, { completion: {} }, { goal: '' }, { values: { text: 42 } }]) {
    expect(() => validateBrowserRequest({ ...request, ...patch })).toThrow();
  }
});

test('checkbox actions set a state; text always comes from the caller', () => {
  const candidates = browserCandidates({ snapshot: '- checkbox "Email" [ref=e1] [checked]\n- textbox "Name" [ref=e2]', refs: { e1: { role: 'checkbox', name: 'Email' }, e2: { role: 'textbox', name: 'Name' } } }, { name: 'Ada' });
  expect(candidates.some(x => x.command.action === 'click' && x.command.selector === '@e1')).toBe(false);
  expect(candidates.find(x => x.command.action === 'fill')?.command.value).toBe('Ada');
  expect(candidates.some(x => x.command.action === 'uncheck')).toBe(true);
});

test('control choices preserve document order instead of the refs object order', () => {
  const page = { snapshot: '- searchbox "Search" [ref=e2]\n- link "Article" [ref=e10]', refs: { e10: { role: 'link', name: 'Article' }, e2: { role: 'searchbox', name: 'Search' } } };
  expect(browserCandidates(page, { query: 'Ada' }).map(candidate => candidate.command.selector)).toEqual(['@e2', '@e10']);
});

describe('browser loop', () => {
  test('an icon-only page can expose an actionable accessible control', async () => {
    let clicked = false;
    const driver = { async command(action: string) {
      if (action === 'evaluate') return { result: { url: request.url, text: clicked ? 'Saved' : '', complete: clicked } };
      if (action === 'snapshot') return { snapshot: '- button "Save" [ref=e1]', refs: { e1: { role: 'button', name: 'Save' } } };
      clicked = true; return {};
    } };
    const result = await runBrowserLoop(validateBrowserRequest({ ...request, maxSteps: 1 }), driver, async () => ({ choice: 'a0', confidence: 1, inputTokens: 1 }), new AbortController().signal, () => {});
    expect(result.status).toBe('succeeded'); expect(clicked).toBe(true);
  });
  test('redirected focus cannot certify an unchanged input using another selects value', async () => {
    const actions: string[] = []; let submitted = false; let decisions = 0;
    const driver = { async command(action: string, args?: Record<string, unknown>) {
      if (action === 'evaluate') return String(args?.script).includes('activeElement')
        ? { result: { tag: 'SELECT', editable: true, options: [{ label: 'Weekly', value: 'daily' }] } }
        : { result: { url: request.url, text: 'Form', complete: submitted } };
      if (action === 'snapshot') return { snapshot: '- combobox "Frequency" [ref=e1]\n- button "Submit" [ref=e2]', refs: { e1: { role: 'combobox', name: 'Frequency' }, e2: { role: 'button', name: 'Submit' } } };
      if (action === 'getattribute') return { value: null };
      if (action === 'inputvalue') return { value: 'daily' };
      if (action === 'focus') return {};
      actions.push(action); if (action === 'click') submitted = true; return {};
    } };
    const result = await runBrowserLoop(validateBrowserRequest({ ...request, values: { frequency: 'Weekly' } }), driver, async () => ({ choice: decisions++ ? 'a1' : 'a0', confidence: 1, inputTokens: 1 }), new AbortController().signal, () => {});
    expect(result.status).toBe('needs-agent'); expect(actions).toEqual([]);
  });
  test('control labels cannot exceed the decision budget', async () => {
    const name = 'x'.repeat(100_000);
    const driver = { async command(action: string) {
      if (action === 'evaluate') return { result: { url: request.url, text: 'Page', complete: false } };
      return { snapshot: `- link "${name}" [ref=e1]`, refs: { e1: { role: 'link', name } } };
    } };
    await runBrowserLoop(validateBrowserRequest(request), driver, async (state, criteria) => {
      expect(JSON.stringify({ state, criteria }).length).toBeLessThan(24_000);
      return { choice: 'blocked', confidence: 1, inputTokens: 1 };
    }, new AbortController().signal, () => {});
  });
  test('focus redirection cannot substitute another selects option value', async () => {
    let value = ''; const sent: unknown[] = [];
    const driver = { async command(action: string, args?: Record<string, unknown>) {
      if (action === 'evaluate') return String(args?.script).includes('activeElement')
        ? { result: { tag: 'SELECT', editable: true, options: [{ label: 'Weekly', value: 'daily' }] } }
        : { result: { url: request.url, text: 'Form', complete: value !== '' } };
      if (action === 'snapshot') return { snapshot: '- combobox "Frequency" [ref=e1]', refs: { e1: { role: 'combobox', name: 'Frequency' } } };
      if (action === 'select') { sent.push(args?.values); value = args?.values === 'Weekly' ? 'week' : String(args?.values); }
      if (action === 'inputvalue') return { value };
      return {};
    } };
    const result = await runBrowserLoop(validateBrowserRequest({ ...request, values: { frequency: 'Weekly' } }), driver, async () => ({ choice: 'a0', confidence: 1, inputTokens: 1 }), new AbortController().signal, () => {});
    expect(sent).toEqual([]); expect(value).toBe(''); expect(result.status).toBe('needs-agent');
  });
  test('completion beyond the text excerpt prevents a pending extra action', async () => {
    let complete = false; const actions: string[] = [];
    const driver = { async command(action: string) {
      if (action === 'evaluate') return { result: { url: request.url, text: 'unchanged excerpt', complete } };
      if (action === 'snapshot') return { snapshot: '- button "Submit" [ref=e1]', refs: { e1: { role: 'button', name: 'Submit' } } };
      actions.push(action); return {};
    } };
    const result = await runBrowserLoop(validateBrowserRequest(request), driver, async () => { complete = true; return { choice: 'a0', confidence: 1, inputTokens: 1 }; }, new AbortController().signal, () => {});
    expect(result.status).toBe('succeeded'); expect(actions).toEqual([]);
  });
  test('does not ask the model to decide on an empty navigation document', async () => {
    let reads = 0; let decisions = 0;
    const driver = { async command(action: string) { if (action === 'snapshot') return { snapshot: '', refs: {} }; return { result: { url: request.url, text: ++reads === 1 ? '' : 'Saved', complete: reads > 1 } }; } };
    const result = await runBrowserLoop(validateBrowserRequest(request), driver, async () => { decisions++; return { choice: 'blocked', confidence: 1, inputTokens: 1 }; }, new AbortController().signal, () => {});
    expect(result.status).toBe('succeeded'); expect(decisions).toBe(0);
  });
  test('rechecks completion that arrives while the model is deciding', async () => {
    let ready = false;
    const driver = { async command(action: string) {
      if (action === 'evaluate') return { result: { url: request.url, text: ready ? 'Saved' : 'Loading', complete: ready } };
      return { snapshot: '- button "Save" [ref=e1]', refs: { e1: { role: 'button', name: 'Save' } } };
    } };
    const result = await runBrowserLoop(validateBrowserRequest(request), driver, async () => { ready = true; return { choice: 'done', confidence: 1, inputTokens: 1 }; }, new AbortController().signal, () => {});
    expect(result.status).toBe('succeeded');
  });
  for (const tag of ['INPUT', 'SELECT']) test(`combobox ${tag} uses its native field operation and verifies the value`, async () => {
    let value = ''; const actions: string[] = [];
    const driver = { async command(action: string, args?: Record<string, unknown>) {
      if (action === 'evaluate') return String(args?.script).includes('activeElement')
        ? { result: { tag, editable: true, options: [{ label: 'Weekly', value: 'week' }] } }
        : { result: { url: request.url, text: 'Preferences', complete: value === (tag === 'INPUT' ? 'Weekly' : 'week') } };
      if (action === 'snapshot') return { snapshot: '- combobox "Frequency" [ref=e1]', refs: { e1: { role: 'combobox', name: 'Frequency' } } };
      if (action === 'focus') return {};
      if (action === 'getattribute') return { value: '1' };
      if (action === 'inputvalue') return { value };
      actions.push(action);
      if (action === 'fill' && tag === 'INPUT') value = String(args?.value);
      if (action === 'select' && tag === 'SELECT') value = args?.values === 'Weekly' ? 'week' : String(args?.values);
      return {};
    } };
    const result = await runBrowserLoop(validateBrowserRequest({ ...request, values: { frequency: 'Weekly' }, maxSteps: 1 }), driver, async () => ({ choice: 'a0', confidence: 1, inputTokens: 1 }), new AbortController().signal, () => {});
    expect(result.status).toBe('succeeded'); expect(actions).toEqual([tag === 'INPUT' ? 'fill' : 'select']);
  });
  test('a silent field no-op hands back before clicking submit', async () => {
    const actions: string[] = []; let decisions = 0;
    const driver = { async command(action: string, args?: Record<string, unknown>) {
      if (action === 'evaluate') return { result: { url: request.url, text: 'Form', complete: false } };
      if (action === 'snapshot') return { snapshot: '- textbox "Search" [ref=e1]\n- button "Submit" [ref=e2]', refs: { e1: { role: 'textbox', name: 'Search' }, e2: { role: 'button', name: 'Submit' } } };
      if (action === 'inputvalue') return { value: '' };
      actions.push(action); return {};
    } };
    const result = await runBrowserLoop(validateBrowserRequest({ ...request, values: { search: 'Ada' }, maxSteps: 2 }), driver, async () => ({ choice: decisions++ ? 'a1' : 'a0', confidence: 1, inputTokens: 1 }), new AbortController().signal, () => {});
    expect(result.status).toBe('needs-agent'); expect(actions).toEqual(['fill']); expect(decisions).toBe(1);
  });
  test('large pages expose every control through bounded decision windows', async () => {
    const refs = Object.fromEntries(Array.from({ length: 240 }, (_, i) => [`e${i}`, { role: 'link', name: i === 239 ? 'Requested release' : `Other link ${i}` }]));
    const snapshot = Object.entries(refs).map(([id, ref]) => `- link "${ref.name}" [ref=${id}]`).join('\n') + '\n' + 'Article prose. '.repeat(5000);
    let clicked = false; let decisions = 0;
    const driver = { async command(action: string, args?: Record<string, unknown>) {
      if (action === 'evaluate') return { result: { url: request.url, text: 'Repository', complete: clicked } };
      if (action === 'snapshot') return { snapshot, refs };
      expect(action).toBe('click'); expect(args?.selector).toBe('@e239'); clicked = true; return {};
    } };
    const result = await runBrowserLoop(validateBrowserRequest(request), driver, async (state, criteria) => {
      decisions++;
      expect(String(state.page).length).toBeLessThanOrEqual(24_000);
      expect(Object.keys(criteria).filter(key => key.startsWith('a')).length).toBeLessThanOrEqual(120);
      return { choice: Object.keys(criteria).find(key => criteria[key]!.includes('Requested release')) ?? 'blocked', confidence: 1, inputTokens: 1 };
    }, new AbortController().signal, () => {});
    expect(result.status).toBe('succeeded'); expect(clicked).toBe(true); expect(decisions).toBeGreaterThan(1);
  });
  function fixture(answers: string[], failAction = false) {
    const actions: string[] = []; let saved = false;
    const driver = { async command(action: string) {
      if (action === 'evaluate') return { result: { url: request.url, text: 'Preferences', complete: saved } };
      if (action === 'snapshot') return { snapshot: '- button "Save" [ref=e1]', refs: { e1: { role: 'button', name: 'Save' } } };
      actions.push(action); if (failAction) throw Error('uncertain delivery'); saved = true; return {};
    } };
    const decide = async () => ({ choice: answers.shift() ?? 'done', confidence: 0.99, inputTokens: 12 });
    return { driver, decide, actions };
  }
  test('does not trust a model completion verdict', async () => {
    const f = fixture(['done']);
    const result = await runBrowserLoop(validateBrowserRequest(request), f.driver, f.decide, new AbortController().signal, () => {});
    expect(result.status).toBe('needs-agent'); expect(f.actions).toEqual([]);
  });
  test('verifies completion after the action', async () => {
    const f = fixture(['a0']);
    const result = await runBrowserLoop(validateBrowserRequest(request), f.driver, f.decide, new AbortController().signal, () => {});
    expect(result.status).toBe('succeeded'); expect(f.actions).toEqual(['click']);
  });
  test('never replays an action whose outcome is unknown', async () => {
    const f = fixture(['a0', 'a0'], true);
    const result = await runBrowserLoop(validateBrowserRequest(request), f.driver, f.decide, new AbortController().signal, () => {});
    expect(result.status).toBe('needs-agent'); expect(f.actions).toEqual(['click']);
  });
  test('a changing snapshot consumes the bounded budget without clicking stale refs', async () => {
    const f = fixture(['a0']); let revision = 0;
    const driver = { async command(action: string) {
      if (action === 'snapshot') return { snapshot: `Revision ${revision++}\n- button "Save" [ref=e1]`, refs: { e1: { role: 'button', name: 'Save' } } };
      return f.driver.command(action);
    } };
    const result = await runBrowserLoop(validateBrowserRequest({ ...request, maxSteps: 1 }), driver, f.decide, new AbortController().signal, () => {});
    expect(result.status).toBe('needs-agent'); expect(f.actions).toEqual([]);
  });
  test('an invalid model choice cannot invoke a browser command', async () => {
    const f = fixture(['evaluate']);
    await expect(runBrowserLoop(validateBrowserRequest(request), f.driver, f.decide, new AbortController().signal, () => {})).rejects.toThrow('outside');
    expect(f.actions).toEqual([]);
  });
  test('cancellation while deciding prevents the action', async () => {
    const f = fixture(['a0']); const controller = new AbortController();
    const decide = async () => { controller.abort(); return { choice: 'a0', confidence: 1, inputTokens: 10 }; };
    await expect(runBrowserLoop(validateBrowserRequest(request), f.driver, decide, controller.signal, () => {})).rejects.toThrow();
    expect(f.actions).toEqual([]);
  });
  test('completion on another origin does not grant permission to continue', async () => {
    const f = fixture(['a0']);
    const driver = { async command() { return { result: { url: 'https://elsewhere.invalid/', text: 'Done', complete: true } }; } };
    const result = await runBrowserLoop(validateBrowserRequest(request), driver, f.decide, new AbortController().signal, () => {});
    expect(result.status).toBe('needs-agent'); expect(f.actions).toEqual([]);
  });
});
