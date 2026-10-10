import { flushSync } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';
import { setExperiment } from '../experiments';
import { followCompanionExperiment } from './follow.svelte';

/** The commands sent to the companion's window, each held until the test lets it finish. */
const sent: string[] = [];
const running: Array<() => void> = [];
vi.mock('./shell', () => ({
  companionWindow: (action: string) => new Promise<void>((done) => {
    sent.push(action);
    running.push(done);
  }),
}));

afterEach(() => {
  vi.unstubAllGlobals();
  setExperiment('companion', false);
});

const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((done) => setTimeout(done, 0)); };
const turn = (on: boolean) => { setExperiment('companion', on); flushSync(); };

test('the companion window follows the experiment one command at a time, and a late open never follows a close', async () => {
  vi.stubGlobal('__TAURI_INTERNALS__', {});
  setExperiment('companion', false);
  const errors: unknown[] = [];
  const stop = $effect.root(() => followCompanionExperiment((error) => errors.push(error)));
  flushSync();
  await vi.waitFor(() => expect(sent).toEqual(['close']));

  // Switched on, then off, while the close still runs: the open is replaced before its turn.
  turn(true);
  turn(false);
  await settle();
  expect(sent).toEqual(['close']);
  running.shift()!();
  await vi.waitFor(() => expect(sent).toEqual(['close', 'close']));

  // Switched on: the open waits for the close before it.
  turn(true);
  await settle();
  expect(sent).toEqual(['close', 'close']);
  running.shift()!();
  await vi.waitFor(() => expect(sent).toEqual(['close', 'close', 'open']));
  running.shift()!();
  stop();
  expect(errors).toEqual([]);
});
