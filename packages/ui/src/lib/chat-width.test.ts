import { afterEach, expect, test } from 'vitest';
import { CHAT_WIDTH_STORAGE_KEY, applyChatWidth, readChatWidth, setChatWidth } from './chat-width';

afterEach(() => {
  window.localStorage.clear();
  document.documentElement.removeAttribute('data-chat-width');
});

test('a device with nothing stored reads the reading column and stamps nothing', () => {
  expect(readChatWidth()).toBe('comfortable');
  applyChatWidth(readChatWidth());
  expect(document.documentElement.hasAttribute('data-chat-width')).toBe(false);
});

test('a picked width is stored, stamped, and read back; the default clears both', () => {
  setChatWidth('full');
  expect(window.localStorage.getItem(CHAT_WIDTH_STORAGE_KEY)).toBe('full');
  expect(document.documentElement.dataset['chatWidth']).toBe('full');
  expect(readChatWidth()).toBe('full');

  setChatWidth('comfortable');
  expect(window.localStorage.getItem(CHAT_WIDTH_STORAGE_KEY)).toBeNull();
  expect(document.documentElement.hasAttribute('data-chat-width')).toBe(false);
});

test('an unknown stored id falls back to the reading column', () => {
  window.localStorage.setItem(CHAT_WIDTH_STORAGE_KEY, 'huge');
  expect(readChatWidth()).toBe('comfortable');
});
