import { expect, test } from 'bun:test';
import { LIGHT_TOOLS, resolveContext } from '@boite/contracts';
import { checkContext } from '../src/context-mode.ts';

test('a context request resolves to a preset, a custom mode or the whole setup, and is refused by field', () => {
  expect(resolveContext(undefined)).toBeNull();
  expect(resolveContext('full')).toBeNull();
  expect(resolveContext({ preset: 'light', keep: ['hooks'] })).toEqual({ label: 'light', instructions: false, guides: false, mcp: false, hooks: true, tools: [...LIGHT_TOOLS], rules: null });
  // Any change to a preset, rules on the whole setup included, reads as custom.
  expect(resolveContext({ preset: 'light', tools: ['Read'] })?.label).toBe('custom');
  expect(resolveContext({ rules: '  Be brief.  ' })).toMatchObject({ label: 'custom', instructions: true, rules: 'Be brief.' });
  expect(() => resolveContext({ keep: ['mcp'], drop: ['mcp'] })).toThrow('context.keep: mcp is both kept and dropped');
  expect(() => resolveContext({ tools: [] })).toThrow('context.tools: expected a non-empty list');
  expect(() => resolveContext({ rules: 'x'.repeat(4001) })).toThrow('context.rules: 4001 characters; at most 4000');
  expect(() => resolveContext({ memory: false })).toThrow('context.memory: unknown field');
});

test('a provider that cannot start without the user setup takes only guides and rules', () => {
  const codex = { protocol: 'codex-appserver', name: 'Codex' } as const;
  expect(checkContext(codex, { drop: ['guides'], rules: 'Be neutral.' })).toMatchObject({ guides: false, rules: 'Be neutral.' });
  expect(() => checkContext(codex, 'neutral')).toThrow('context.instructions: Codex starts with its own instructions, mcp, hooks; on it, a context mode can only drop guides and add rules');
  expect(() => checkContext(codex, { tools: ['Read'] })).toThrow('context.tools');
  expect(checkContext({ protocol: 'claude-sdk', name: 'Claude' }, 'neutral')?.label).toBe('neutral');
});
