import { expect, test } from 'vitest';
import { flushSync } from 'svelte';
import type { Message } from '@boite/contracts';
import { TurnProgress, turnProgressStats } from './turn-progress.svelte';

function finished(turn: number): Message[] {
  return [
    { id: `u${turn}`, threadId: 't', turnId: `turn-${turn}`, role: 'user', parts: [{ type: 'text', text: `question ${turn}` }], state: 'complete', createdAt: turn },
    { id: `a${turn}`, threadId: 't', turnId: `turn-${turn}`, role: 'assistant', parts: [{ type: 'thinking', text: `why ${turn}` }, { type: 'text', text: `answer ${turn}` }], state: 'complete', createdAt: turn }
  ] as Message[];
}

function setup() {
  const messages = $state<Message[]>(Array.from({ length: 200 }, (_, turn) => finished(turn)).flat());
  let progress!: TurnProgress;
  const track: { responded: boolean } = { responded: false };
  const stop = $effect.root(() => {
    progress = new TurnProgress(() => messages);
    $effect(() => {
      track.responded = progress.responded('turn-live');
    });
  });
  flushSync();
  return { messages, progress, track, stop };
}

test('a finished turn has answered', () => {
  const { progress, stop } = setup();
  expect(progress.responded('turn-3')).toBe(true);
  expect(progress.responded('turn-missing')).toBe(false);
  stop();
});

test('a tool call counts as a response even before a later empty reasoning block', () => {
  const { messages, progress, stop } = setup();
  messages.push({ id: 'first', threadId: 't', turnId: 'turn-x', role: 'assistant', parts: [{ type: 'tool', toolId: 'x', name: 'Read', input: {}, output: 'ok', status: 'done' }], state: 'complete', createdAt: 3 });
  messages.push({ id: 'second', threadId: 't', turnId: 'turn-x', role: 'assistant', parts: [{ type: 'thinking', text: '' }], state: 'streaming', createdAt: 4 });
  flushSync();
  expect(progress.responded('turn-x')).toBe(true);
  stop();
});

test('the second receipt turns on with the first streamed character, and a delta never rescans the finished messages', () => {
  const { messages, track, stop } = setup();
  messages.push({ id: 'u-live', threadId: 't', turnId: 'turn-live', role: 'user', parts: [{ type: 'text', text: 'go' }], state: 'complete', createdAt: 1 } as Message);
  messages.push({ id: 'a-live', threadId: 't', turnId: 'turn-live', role: 'assistant', parts: [{ type: 'thinking', text: '' }], state: 'streaming', createdAt: 2 } as Message);
  flushSync();
  expect(track.responded).toBe(false);

  const live = messages.at(-1)!;
  const thinking = live.parts[0];
  if (thinking?.type !== 'thinking') throw new Error('the live message starts on reasoning');
  const scans = turnProgressStats.finishedScans;
  thinking.text += 'hmm';
  flushSync();
  expect(track.responded).toBe(true);

  live.parts.push({ type: 'text', text: '' });
  const text = live.parts[1];
  if (text?.type !== 'text') throw new Error('the answer follows the reasoning');
  for (let delta = 0; delta < 300; delta += 1) {
    text.text += ' token';
    flushSync();
  }
  for (let delta = 0; delta < 50; delta += 1) {
    thinking.text += ' more';
    flushSync();
  }
  // Pushing the text part is a structural change; the deltas after it are not.
  expect(turnProgressStats.finishedScans - scans).toBe(0);

  live.state = 'complete';
  flushSync();
  expect(turnProgressStats.finishedScans - scans).toBe(1);
  expect(track.responded).toBe(true);
  stop();
});
