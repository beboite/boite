import { expect, test } from 'vitest';
import { compareThreads } from './thread-order';

const base = { pinned: false, status: 'idle' as const, lastUserMessageAt: null, createdAt: 0 };

test('a waiting thread sorts above an idle one with a newer message', () => {
  const idle = { ...base, id: 'idle', lastUserMessageAt: 2_000 };
  const waiting = { ...base, id: 'waiting', status: 'waiting' as const, lastUserMessageAt: 1_000 };
  expect([idle, waiting].sort(compareThreads).map((t) => t.id)).toEqual(['waiting', 'idle']);
});

test('pinned first, then waiting, running, queued, idle, then the last message', () => {
  const rows = [
    { ...base, id: 'old-idle', lastUserMessageAt: 1 },
    { ...base, id: 'new-idle', lastUserMessageAt: 9 },
    { ...base, id: 'running', status: 'running' as const },
    { ...base, id: 'queued', status: 'queued' as const },
    { ...base, id: 'waiting', status: 'waiting' as const },
    { ...base, id: 'pinned', pinned: true, createdAt: 5 }
  ];
  expect(rows.sort(compareThreads).map((t) => t.id)).toEqual(['pinned', 'waiting', 'running', 'queued', 'new-idle', 'old-idle']);
});
