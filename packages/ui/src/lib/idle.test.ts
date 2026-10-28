import { expect, test, vi } from 'vitest';
import { whenIdle } from './idle';

test('an idle task can be cancelled before it runs', () => {
  vi.useFakeTimers();
  try {
    const task = vi.fn();
    whenIdle(task)();
    vi.advanceTimersByTime(2000);
    expect(task).not.toHaveBeenCalled();
    whenIdle(task);
    vi.advanceTimersByTime(2000);
    expect(task).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
  }
});
