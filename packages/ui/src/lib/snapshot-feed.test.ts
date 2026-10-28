import { expect, test } from 'vitest';
import { SnapshotFeed } from './snapshot-feed';

function gate<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

test('events held during reads land after the newest answer, and an older answer arriving last is dropped', async () => {
  let state: string[] = [];
  const feed = new SnapshotFeed<string>(event => { state = [...state, event]; });
  feed.push('live');
  expect(state).toEqual(['live']);

  const first = gate<string[]>(), second = gate<string[]>();
  const one = feed.read(() => first.promise, value => { state = value; });
  feed.push('before second read');
  const two = feed.read(() => second.promise, value => { state = value; });
  feed.push('after second read');
  expect(state).toEqual(['live']);

  second.resolve(['second snapshot']);
  await two;
  // The first read is still out: events keep waiting for it.
  expect(state).toEqual(['second snapshot']);
  first.resolve(['first snapshot']);
  await one;
  // The second answer already holds what came before it was sent; only the later event is applied.
  expect(state).toEqual(['second snapshot', 'after second read']);

  feed.dispose();
  feed.push('gone');
  expect(state).toEqual(['second snapshot', 'after second read']);
});
