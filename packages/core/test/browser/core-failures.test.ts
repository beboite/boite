import { expect, test } from 'bun:test';
import { CoreFailures } from './fixture.ts';

const RPC = 'browser.remoteWatch failed: the browser did not answer Emulation.setFocusEmulationEnabled within 5 seconds';
const STALLED = "A sleeping tab missed Emulation.setFocusEmulationEnabled, while the browser answered for itself in 8 ms: the page's renderer stalled";
const LATE = "A sleeping tab's page answered Emulation.setFocusEmulationEnabled 9120 ms after it was sent";
const NEVER = "A sleeping tab's page never answered Page.setWebLifecycleState: the browser did not answer Page.setWebLifecycleState within 30 seconds";

/** A window the test ends itself, so no case depends on a real 30 s timer. */
function controlledWindow() {
  const asked: number[] = [];
  let end = () => {};
  const failures = new CoreFailures(30_000, ms => { asked.push(ms); return new Promise<void>(resolve => { end = resolve; }); });
  return { failures, asked, end: () => end() };
}

/** Whether `promise` settled once every pending callback ran. */
async function settled(promise: Promise<unknown>): Promise<boolean> {
  let done = false;
  void promise.then(() => { done = true; });
  await Bun.sleep(1);
  return done;
}

test('a test with no stalled sleep step prints at once and starts no wait', async () => {
  const { failures, asked } = controlledWindow();
  failures.record('threads.get failed: no thread thr_x', 'rpc.failed');
  failures.record('a turn started', 'turn.started');
  expect(await failures.settle()).toBe(true);
  expect(asked).toEqual([]);
  expect(failures.lines).toEqual(['threads.get failed: no thread thr_x']);
});

test('a failed wake keeps the core until its probe and its late answer, both heard after the call failed', async () => {
  const { failures, asked } = controlledWindow();
  failures.record(RPC, 'rpc.failed');
  const settling = failures.settle();
  expect(await settled(settling)).toBe(false);
  failures.record(STALLED, 'browser.sleep-stalled');
  expect(await settled(settling)).toBe(false);
  failures.record(LATE, 'browser.sleep-late');
  expect(await settling).toBe(true);
  expect(asked).toEqual([30_000]);
  expect(failures.lines).toEqual([RPC, STALLED, LATE]);
});

test('answers heard before the teardown asks settle at once', async () => {
  const { failures, asked } = controlledWindow();
  failures.record(RPC, 'rpc.failed');
  failures.record(LATE, 'browser.sleep-late');
  failures.record(STALLED, 'browser.sleep-stalled');
  expect(await failures.settle()).toBe(true);
  expect(asked).toEqual([]);
});

test('every stalled step, a freeze that failed no call included, gets its own late answer', async () => {
  const { failures } = controlledWindow();
  failures.record(RPC, 'rpc.failed');
  failures.record(STALLED, 'browser.sleep-stalled');
  failures.record(STALLED.replace('Emulation.setFocusEmulationEnabled', 'Page.setWebLifecycleState'), 'browser.sleep-stalled');
  const settling = failures.settle();
  failures.record(LATE, 'browser.sleep-late');
  expect(await settled(settling)).toBe(false);
  failures.record(NEVER, 'browser.sleep-late');
  expect(await settling).toBe(true);
  expect(failures.lines.at(-1)).toBe(NEVER);
});

test('a freeze diagnosed in full earlier does not answer for a wake that fails later', async () => {
  const { failures } = controlledWindow();
  const FREEZE_STALLED = STALLED.replace('Emulation.setFocusEmulationEnabled', 'Page.setWebLifecycleState');
  failures.record(FREEZE_STALLED, 'browser.sleep-stalled');
  failures.record(NEVER, 'browser.sleep-late');
  failures.record(RPC, 'rpc.failed');
  const settling = failures.settle();
  expect(await settled(settling)).toBe(false);
  failures.record(STALLED, 'browser.sleep-stalled');
  expect(await settled(settling)).toBe(false);
  failures.record(LATE, 'browser.sleep-late');
  expect(await settling).toBe(true);
  expect(failures.lines).toEqual([FREEZE_STALLED, NEVER, RPC, STALLED, LATE]);
});

test('a window that ends before the late answer settles false with what was heard', async () => {
  const { failures, end } = controlledWindow();
  failures.record(RPC, 'rpc.failed');
  failures.record(STALLED, 'browser.sleep-stalled');
  const settling = failures.settle();
  expect(await settled(settling)).toBe(false);
  end();
  expect(await settling).toBe(false);
  expect(failures.lines).toEqual([RPC, STALLED]);
});
