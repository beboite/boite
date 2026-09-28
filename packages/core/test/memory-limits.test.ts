import { describe, expect, test } from 'bun:test';
import { checkSettingsPatch } from '@boite/contracts';
import { resolveMemoryLimits } from '../src/memory-limits.ts';
import { processPlatform } from '../src/platform/index.ts';

const MB = 1024 * 1024;
const AUTO = { agentMemoryBudgetMb: 0, threadMemoryCapMb: 0, memoryReserveMb: 0 };

describe('memory limits', () => {
  test('auto uses physical RAM and rounds the budget and thread cap down to 256 MB', () => {
    expect(resolveMemoryLimits(AUTO, 32 * 1024 * MB)).toEqual({
      agentMemoryBudgetMb: 19456, threadMemoryCapMb: 9728, memoryReserveMb: 3276.8,
    });
    expect(resolveMemoryLimits(AUTO, 8 * 1024 * MB)).toEqual({
      agentMemoryBudgetMb: 4864, threadMemoryCapMb: 2304, memoryReserveMb: 3072,
    });
  });

  test('an explicit budget sets the auto thread cap, with the same rounding', () => {
    expect(resolveMemoryLimits({ ...AUTO, agentMemoryBudgetMb: 1792 }, 16 * 1024 * MB)).toEqual({
      agentMemoryBudgetMb: 1792, threadMemoryCapMb: 768, memoryReserveMb: 3072,
    });
  });

  test('explicit limits are kept, but a thread cannot exceed the budget', () => {
    expect(resolveMemoryLimits({ agentMemoryBudgetMb: 512, threadMemoryCapMb: 768, memoryReserveMb: 1024 }, 8 * 1024 * MB)).toEqual({
      agentMemoryBudgetMb: 512, threadMemoryCapMb: 512, memoryReserveMb: 1024,
    });
    expect(resolveMemoryLimits({ ...AUTO, threadMemoryCapMb: 300 }, 8 * 1024 * MB).threadMemoryCapMb).toBe(300);
  });

  test('the smallest supported budget still gives the thread an auto cap', () => {
    expect(resolveMemoryLimits({ ...AUTO, agentMemoryBudgetMb: 512 }, 1024 * MB).threadMemoryCapMb).toBe(256);
  });

  test('new settings accept auto and bounded integer megabytes', () => {
    for (const key of ['agentMemoryBudgetMb', 'memoryReserveMb'] as const) {
      for (const value of [0, 512, 1048576]) expect(checkSettingsPatch({ [key]: value }).ok).toBe(true);
      for (const value of [-1, 1, 512.5, 1048577, NaN, Infinity, '512']) {
        const checked = checkSettingsPatch({ [key]: value });
        expect(checked).toMatchObject({ ok: false, field: key });
        if (!checked.ok) expect(checked.message).toContain(key);
      }
    }
  });
});

test('machine memory reports plausible physical total and available bytes', () => {
  const memory = processPlatform.machineMemory();
  expect(memory).not.toBeNull();
  expect(memory!.totalBytes).toBeGreaterThan(512 * MB);
  expect(memory!.availableBytes).toBeGreaterThan(0);
  expect(memory!.availableBytes).toBeLessThanOrEqual(memory!.totalBytes);
});
