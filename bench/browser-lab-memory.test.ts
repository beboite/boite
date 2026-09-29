import { expect, test } from 'bun:test';
import { compactObservation, parseBrowserDecision } from './browser-lab-memory.ts';

test('compact observations preserve actionable refs and unique facts while removing duplicates', () => {
  const input = { snapshot: '- link "History" [ref=e2]\n  - /url: https://example.com/history',
    pageText: 'History\nRevision date: 24 September 2026\nRevision date: 24 September 2026',
    links: [{ text: 'History', url: 'https://example.com/history' }, { text: 'Source', url: 'https://example.com/source' }], tabs: { tabs: [{ id: 't1' }] }, results: [{ success: false, error: 'not visible' }] };
  const result = compactObservation(input);
  expect(result.snapshot).toBe(input.snapshot);
  expect(result.additionalPageText).toBe('Revision date: 24 September 2026');
  expect(result.links).toEqual([input.links[1]]);
  expect(result.results).toEqual(input.results);
  expect(input.pageText).toContain('History');
});
test('bounded decision memory rejects malformed output instead of executing a guessed plan', () => {
  expect(parseBrowserDecision('{"commands":[{"action":"observe"}],"memory":"waiting"}')).toEqual({ commands: [{ action: 'observe' }], memory: 'waiting' });
  expect(() => parseBrowserDecision('{"commands":[],"memory":""}')).toThrow('one to four');
  expect(() => parseBrowserDecision(JSON.stringify({ commands: [{ action: 'observe' }], memory: 'x'.repeat(6001) }))).toThrow('6000');
  expect(() => parseBrowserDecision('I clicked it')).toThrow();
});
