import { describe, expect, test } from 'bun:test';
import { checkSettingsPatch } from '@boite/contracts';
import { resolveMemoryLimits } from '../src/memory-limits.ts';
import { processPlatform } from '../src/platform/index.ts';

const MB = 1024 * 1024;
const AUTO = { agentMemoryBudgetPercent: 60, threadMemoryCapMb: 0, memoryReserveMb: 0 };

describe('memory limits', () => {
  test('auto uses physical RAM and rounds the budget and thread cap down to 256 MB', () => {
    expect(resolveMemoryLimits(AUTO, 32 * 1024 * MB)).toEqual({
      budgetMb: 19456, threadMemoryCapMb: 9728, memoryReserveMb: 3276.8,
    });
    expect(resolveMemoryLimits(AUTO, 8 * 1024 * MB)).toEqual({
      budgetMb: 4864, threadMemoryCapMb: 2304, memoryReserveMb: 3072,
    });
  });

  test('a percentage resolves against this machine and clamps an explicit quota', () => {
    expect(resolveMemoryLimits({ ...AUTO, agentMemoryBudgetPercent: 25 }, 16 * 1024 * MB)).toEqual({
      budgetMb: 4096, threadMemoryCapMb: 2048, memoryReserveMb: 3072,
    });
    expect(resolveMemoryLimits({ ...AUTO, agentMemoryBudgetPercent: 10, threadMemoryCapMb: 2048 }, 8 * 1024 * MB).threadMemoryCapMb).toBe(768);
    expect(resolveMemoryLimits({ ...AUTO, threadMemoryCapMb: 300 }, 8 * 1024 * MB).threadMemoryCapMb).toBe(300);
  });
  test('the percentage accepts only integers from 10 to 90', () => {
    for (const value of [10, 60, 90]) expect(checkSettingsPatch({ agentMemoryBudgetPercent: value }).ok).toBe(true);
    for (const value of [0, 9, 91, 60.5, NaN, Infinity, '60']) {
      expect(checkSettingsPatch({ agentMemoryBudgetPercent: value as number })).toMatchObject({ ok: false, field: 'agentMemoryBudgetPercent' });
    }
  });
  test('reserve accepts auto or bounded integer megabytes', () => {
    for (const value of [0, 256, 1048576]) expect(checkSettingsPatch({ memoryReserveMb: value }).ok).toBe(true);
    for (const value of [-1, 1, 512.5, 1048577, NaN, Infinity, '512']) {
      expect(checkSettingsPatch({ memoryReserveMb: value as number })).toMatchObject({ ok: false, field: 'memoryReserveMb' });
    }
  });
});

test('machine memory reports plausible physical total and available bytes', () => {
  const memory = processPlatform.machineMemory();
  expect(memory).not.toBeNull();
  expect(memory!.totalBytes).toBeGreaterThan(512 * MB);
  // macOS gives no honest available reading, so the reserve check sits out there.
  if (process.platform === 'darwin') return expect(memory!.availableBytes).toBeNull();
  expect(memory!.availableBytes).toBeGreaterThan(0);
  expect(memory!.availableBytes).toBeLessThanOrEqual(memory!.totalBytes);
});
