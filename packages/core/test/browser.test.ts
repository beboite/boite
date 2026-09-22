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

describe('browser loop', () => {
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
