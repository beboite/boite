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
  const track: { responded: boolean; thought: string | undefined; live: boolean | undefined } = { responded: false, thought: undefined, live: undefined };
  const stop = $effect.root(() => {
    progress = new TurnProgress(() => messages);
    $effect(() => {
      track.responded = progress.responded('turn-live');
      const thought = progress.thought('turn-live');
      track.thought = thought?.text;
      track.live = thought?.live;
    });
  });
  flushSync();
  return { messages, progress, track, stop };
}

test('a finished turn has answered and keeps its reasoning', () => {
  const { progress, stop } = setup();
  expect(progress.responded('turn-3')).toBe(true);
  expect(progress.thought('turn-3')).toEqual({ host: 'a3', text: 'why 3', live: false });
  expect(progress.responded('turn-missing')).toBe(false);
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
  expect(track.thought).toBe('hmm');
  expect(track.live).toBe(true);

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
  expect(track.live).toBe(false);

  live.state = 'complete';
  flushSync();
  expect(turnProgressStats.finishedScans - scans).toBe(1);
  expect(track.responded).toBe(true);
  expect(track.thought).toBe('hmm'.concat(' more'.repeat(50)));
  stop();
});

test('later reasoning of a turn replaces the text and keeps the first host', () => {
  const { messages, progress, stop } = setup();
  messages.push({ id: 'first', threadId: 't', turnId: 'turn-x', role: 'assistant', parts: [{ type: 'thinking', text: 'one' }, { type: 'tool', id: 'x', name: 'Read', input: {}, status: 'done' }], state: 'complete', createdAt: 3 } as Message);
  messages.push({ id: 'second', threadId: 't', turnId: 'turn-x', role: 'assistant', parts: [{ type: 'thinking', text: '' }], state: 'streaming', createdAt: 4 } as Message);
  flushSync();
  // An empty live part keeps the earlier text until its first character.
  expect(progress.thought('turn-x')).toEqual({ host: 'first', text: 'one', live: true });
  const part = messages.at(-1)!.parts[0];
  if (part?.type !== 'thinking') throw new Error('reasoning');
  part.text = 'two';
  flushSync();
  expect(progress.thought('turn-x')).toEqual({ host: 'first', text: 'two', live: true });
  // A tool call counts as an answer even with no text.
  expect(progress.responded('turn-x')).toBe(true);
  stop();
});
