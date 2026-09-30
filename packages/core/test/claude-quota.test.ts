import { afterEach, beforeEach, expect, test } from 'bun:test';
import type { Options, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { readClaudeQuota } from '../src/drivers/claude.ts';
import type { QueryFn } from '../src/drivers/claude/query.ts';
import type { ProbeContext } from '../src/drivers/types.ts';
import { claudeQuotaWindows } from '../src/quotas.ts';
import { scriptedClaude, startTestCore } from './harness.ts';
import type { TestCore } from './harness.ts';

let harness: TestCore;
beforeEach(async () => { harness = await startTestCore(); scriptedClaude(harness); });
afterEach(async () => { await harness.stop(); });

function context(killed: { count: number }): ProbeContext {
  return {
    provider: harness.core.providers.require('claude'), accountId: 'acc_quota' as ProbeContext['accountId'],
    accountEnv: {}, cwd: harness.dataDir,
    spawnChild: () => { throw new Error('the fake query spawns nothing'); },
    killTree: () => { killed.count += 1; }, log: () => undefined,
  };
}

test('the plan windows come from the CLI itself, with no prompt sent and the probe stopped', async () => {
  // macOS: the login is in the Keychain, where only the CLI reads it.
  const prompts: SDKUserMessage[] = [];
  let options: Options | undefined;
  let asked: unknown;
  let closes = 0;
  const queryFn = ((input: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => {
    options = input.options;
    void (async () => { for await (const prompt of input.prompt) prompts.push(prompt); })();
    return {
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: (opts: unknown) => {
        asked = opts;
        return Promise.resolve({ rate_limits_available: true, subscription_type: 'max', rate_limits: {
          five_hour: { utilization: 42, resets_at: '2026-09-30T15:00:00Z' },
          seven_day: { utilization: 7, resets_at: '2026-10-04T00:00:00Z' },
        } });
      },
      close: () => { closes += 1; },
    };
  }) as unknown as QueryFn;
  const killed = { count: 0 };
  const usage = await readClaudeQuota(context(killed), { loadQuery: () => Promise.resolve(queryFn) });
  expect(claudeQuotaWindows(usage).map(w => [w.id, w.usedPercent])).toEqual([['five_hour', 42], ['seven_day', 7]]);
  expect(asked).toEqual({ skipBehaviors: true });
  expect(options?.pathToClaudeCodeExecutable).toBe(process.execPath);
  expect(options?.tools).toEqual([]);
  expect(prompts).toEqual([]);
  expect(closes).toBe(1);
  expect(killed.count).toBe(1);
});

test('an account the plan limits do not apply to says so instead of an empty quota', async () => {
  const queryFn = (() => ({
    usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: () => Promise.resolve({ rate_limits_available: false, rate_limits: null }),
    close: () => undefined,
  })) as unknown as QueryFn;
  const killed = { count: 0 };
  await expect(readClaudeQuota(context(killed), { loadQuery: () => Promise.resolve(queryFn) })).rejects.toThrow('no subscription login');
  expect(killed.count).toBe(1);
});
