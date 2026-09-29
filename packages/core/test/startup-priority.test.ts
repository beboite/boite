import { expect, test } from 'bun:test';
import { StartupPriority } from '../src/platform/windows/startup-priority.ts';

test('a refused downgrade is retried until native priority returns to background', async () => {
  let normal = false;
  let refusals = 2;
  const priority = new StartupPriority((active) => {
    if (!active && refusals-- > 0) return false;
    normal = active;
    return true;
  }, 10);
  try {
    priority.set(true);
    expect(normal).toBe(true);
    priority.set(false);
    expect(normal).toBe(true);
    const started = Date.now();
    while (normal && Date.now() - started < 1000) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(normal).toBe(false);
  } finally {
    priority.close();
  }
});

test('a refused boost does not retry normal priority and closing cancels recovery', async () => {
  const writes: boolean[] = [];
  const priority = new StartupPriority((active) => { writes.push(active); return false; }, 10);
  priority.set(true);
  expect(writes).toEqual([true, false]);
  priority.close();
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(writes).toEqual([true, false]);
});
