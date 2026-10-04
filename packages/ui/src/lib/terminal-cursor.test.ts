import { afterEach, expect, test, vi } from 'vitest';
import { readTerminalCursor, setTerminalCursor } from './terminal-cursor';

afterEach(() => vi.restoreAllMocks());

test('a cursor picked while storage refuses it is the one an open screen reads', () => {
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Full', 'QuotaExceededError'); });
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new DOMException('Denied', 'SecurityError'); });
  setTerminalCursor('block');
  expect(readTerminalCursor()).toBe('block');
  expect(document.documentElement.dataset['terminalCursor']).toBe('block');
});
