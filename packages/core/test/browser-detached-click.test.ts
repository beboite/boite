import { expect, test } from 'bun:test';
import { Cdp } from '../src/browser/cdp.ts';
import { automate, type AgentPage } from '../src/browser/automation.ts';
import { rejection } from './settle.ts';

test('detaching a session rejects its unanswered command while the browser and other sessions stay live', async () => {
  const sent: Array<{ id: number; method: string; sessionId?: string }> = [];
  const relay = Cdp.relay(text => sent.push(JSON.parse(text)), () => {});
  const events: unknown[] = [];
  relay.cdp.on('Target.detachedFromTarget', params => events.push(params));
  try {
    const release = rejection(relay.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased' }, 'popup', 100));
    const reading = rejection(relay.cdp.send('Runtime.evaluate', {}, 'popup', 100));
    const other = relay.cdp.send('Runtime.evaluate', {}, 'opener', 100).then(value => ({ value }), reason => ({ reason }));
    const browser = relay.cdp.send('Browser.getVersion', {}, undefined, 100).then(value => ({ value }), reason => ({ reason }));
    relay.receive(JSON.stringify({ method: 'Target.detachedFromTarget', params: { sessionId: 'popup' } }));
    const { reason } = await release;
    expect(reason).toMatchObject({ name: 'CdpSessionDetachedError', method: 'Input.dispatchMouseEvent', sessionId: 'popup' });
    expect((await reading).reason).toMatchObject({ name: 'CdpSessionDetachedError', method: 'Runtime.evaluate', sessionId: 'popup' });
    expect(events).toEqual([{ sessionId: 'popup' }]);
    expect(relay.cdp.open).toBe(true);
    for (const command of sent.slice(2)) relay.receive(JSON.stringify({ id: command.id, result: { alive: command.sessionId ?? 'browser' } }));
    expect(await other).toEqual({ value: { alive: 'opener' } });
    expect(await browser).toEqual({ value: { alive: 'browser' } });
    // A late answer for the removed session cannot settle someone else's command.
    relay.receive(JSON.stringify({ id: sent[0]!.id, result: {} }));
  } finally { relay.cdp.close(); }
});

type Failure = 'own' | 'other' | 'protocol' | 'connection';
function clicking(stage: string, failure: Failure) {
  const input: string[] = [];
  let detached = false, readsAfterDetach = 0, released = 0;
  const relay = Cdp.relay(text => {
    const command = JSON.parse(text);
    if (command.method === 'Input.dispatchMouseEvent') {
      input.push(command.params.type);
      if (command.params.type === stage) {
        if (failure === 'connection') { relay.end(); return; }
        if (failure === 'protocol') {
          relay.receive(JSON.stringify({ id: command.id, error: { message: 'input refused' } })); return;
        }
        detached = true;
        relay.receive(JSON.stringify({ method: 'Target.detachedFromTarget', params: { sessionId: command.sessionId } }));
        return;
      }
    }
    if (command.method === 'Runtime.evaluate') {
      // A failed pointer move still runs the existing best-effort observer cleanup.
      if (detached && !command.params.expression.includes('K.stopPointer()')) readsAfterDetach++;
      const value = command.params.expression.includes('return K.pointerMoved(') ? true : command.params.expression.includes('return K.checked(') ? false : command.params.expression.includes('return K.point(')
        ? { x: 10, y: 20 }
        : { url: 'https://fixture.invalid', title: 'Popup', ready: 'complete', token: 'document', leaving: false };
      relay.receive(JSON.stringify({ id: command.id, result: { result: { value } } }));
    } else relay.receive(JSON.stringify({ id: command.id, result: {} }));
  }, () => {});
  const page: AgentPage = {
    session: 'popup', dialogs: [], dialogPolicy: { accept: true, text: null },
    send: (method, params, timeout) => relay.cdp.send(method, params, failure === 'other' ? 'other' : 'popup', Math.min(timeout ?? 100, 100)),
    frames: { reach: async () => null, release: () => { released++; } },
  };
  return { relay, page, input, readsAfterDetach: () => readsAfterDetach, released: () => released };
}

test('a native click whose own page detaches on release stops before another click or navigation settlement', async () => {
  const fixture = clicking('mouseReleased', 'own');
  try {
    expect(await automate(fixture.page, 'popup-tab', { kind: 'click', selector: '#shut', count: 2 }))
      .toMatchObject({ tabId: 'popup-tab', value: { ok: true } });
    expect(fixture.input).toEqual(['mouseMoved', 'mousePressed', 'mouseReleased']);
    expect(fixture.readsAfterDetach()).toBe(0);
    expect(fixture.released()).toBe(1);
  } finally { fixture.relay.cdp.close(); }
});

test('a check still rejects when the page disappears before its checked state can be verified', async () => {
  const fixture = clicking('mouseReleased', 'own');
  try {
    const { reason } = await rejection(automate(fixture.page, 'popup-tab', { kind: 'check', selector: '#gift' }));
    expect(reason).toMatchObject({ name: 'CdpSessionDetachedError', sessionId: 'popup' });
    expect(fixture.readsAfterDetach()).toBe(0);
    expect(fixture.released()).toBe(1);
  } finally { fixture.relay.cdp.close(); }
});

for (const [stage, failure] of [
  ['mouseMoved', 'own'], ['mousePressed', 'own'], ['mouseReleased', 'other'],
  ['mouseReleased', 'protocol'], ['mouseReleased', 'connection'],
] as const) {
  test(`a click still rejects ${failure} failure at ${stage}`, async () => {
    const fixture = clicking(stage, failure);
    try {
      const { reason } = await rejection(automate(fixture.page, 'popup-tab', { kind: 'click', selector: '#shut' }));
      expect(reason).toBeInstanceOf(Error);
      expect((reason as Error).message).toContain(failure === 'protocol' ? 'input refused' : failure === 'connection' ? 'closed' : 'session');
      expect(fixture.input.at(-1)).toBe(stage);
      expect(fixture.readsAfterDetach()).toBe(0);
      expect(fixture.released()).toBe(1);
    } finally { fixture.relay.cdp.close(); }
  });
}
