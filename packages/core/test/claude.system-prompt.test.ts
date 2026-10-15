import { expect, test } from 'bun:test';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { answerEach, calls, claudeThread, harness, runTurn, scripted, useClaudeHarness } from './fixtures/claude-query.ts';

useClaudeHarness();

function appended(options: Options): string {
  const prompt = options.systemPrompt;
  return typeof prompt === 'object' && prompt !== null && !Array.isArray(prompt) && 'append' in prompt ? prompt.append ?? '' : '';
}

test("Claude runs on Claude Code's prompt with Boite's guide in it, so no message has to carry the guide", async () => {
  harness.core.journal.setSetting('brain', { path: null, enabled: false, boiteGuide: true });
  const client = await harness.connect();
  const threadId = await claudeThread(client);
  scripted(() => {}, answerEach('sess-prompt'));
  expect(await runTurn(client, threadId, 'hello')).toBe('done');
  expect(await runTurn(client, threadId, 'again')).toBe('done');

  // Each query the turns opened, the resumed one included: the prompt is a start option.
  expect(calls.length).toBeGreaterThan(0);
  for (const { options } of calls) {
    // Without a preset the SDK sends an empty system prompt: the model would get one identity line.
    expect(options.systemPrompt).toMatchObject({ type: 'preset', preset: 'claude_code', excludeDynamicSections: true });
    expect(appended(options)).toContain('boite where');
    expect(appended(options)).toContain('`path:line`');
    expect(options.settings).toMatchObject({ autoMemoryEnabled: false });
  }
  const prompts = calls.flatMap(call => call.prompts);
  expect(prompts[0]).toContain('hello');
  expect(prompts.some(prompt => prompt.includes('again'))).toBe(true);
  for (const prompt of prompts) expect(prompt).not.toContain('boite where');
});

test('with the guide switched off, Claude keeps its preset prompt and gets nothing appended', async () => {
  const client = await harness.connect();
  const threadId = await claudeThread(client);
  scripted(() => {}, answerEach('sess-plain'));
  expect(await runTurn(client, threadId, 'hello')).toBe('done');
  expect(calls[0]!.options.systemPrompt).toEqual({ type: 'preset', preset: 'claude_code', excludeDynamicSections: true });
  expect(calls[0]!.prompts[0]).not.toContain('boite where');
});
