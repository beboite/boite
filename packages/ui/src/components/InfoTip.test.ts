import { afterEach, expect, test } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import InfoTip from './InfoTip.svelte';

let running: Record<string, unknown> | null = null;

afterEach(() => {
  if (running) unmount(running, { outro: false });
  running = null;
  document.body.innerHTML = '';
});

function mountTip(): HTMLButtonElement {
  const target = document.createElement('label');
  const input = document.createElement('input');
  input.type = 'checkbox';
  document.body.append(target);
  running = mount(InfoTip, { target, props: { topic: 'Notifications', text: 'A toast when a thread finishes.' } });
  target.append(input);
  flushSync();
  return document.querySelector<HTMLButtonElement>('[data-testid=info-tip]')!;
}

/** jsdom has no PointerEvent constructor; the component only reads `pointerType`. */
function pointer(node: Element, type: string, pointerType: string): void {
  const event = new Event(type, { bubbles: type === 'pointerdown' });
  Object.defineProperty(event, 'pointerType', { value: pointerType });
  node.dispatchEvent(event);
  flushSync();
}

const bubble = () => document.querySelector('[data-testid=info-tip-text]');

test('names what it explains and shows nothing until asked', () => {
  const button = mountTip();
  expect(button.getAttribute('aria-label')).toBe('About Notifications');
  expect(button.getAttribute('aria-expanded')).toBe('false');
  expect(bubble()).toBeNull();
});

test('a mouse shows it on hover and hides it on leave', () => {
  const button = mountTip();
  pointer(button, 'pointerenter', 'mouse');
  expect(bubble()?.textContent).toBe('A toast when a thread finishes.');
  expect(bubble()?.getAttribute('role')).toBe('tooltip');
  expect(button.getAttribute('aria-describedby')).toBe(bubble()?.id);
  pointer(button, 'pointerleave', 'mouse');
  expect(button.getAttribute('aria-expanded')).toBe('false');
});

test('a tap pins it open without flipping the switch in its label, a press elsewhere closes it', () => {
  const button = mountTip();
  const input = document.querySelector<HTMLInputElement>('input')!;
  pointer(button, 'pointerenter', 'touch');
  expect(bubble()).toBeNull();
  button.click();
  flushSync();
  expect(button.getAttribute('aria-expanded')).toBe('true');
  expect(input.checked).toBe(false);
  // A pinned tip survives the pointer leaving.
  pointer(button, 'pointerleave', 'mouse');
  expect(button.getAttribute('aria-expanded')).toBe('true');
  pointer(document.body, 'pointerdown', 'touch');
  expect(button.getAttribute('aria-expanded')).toBe('false');
});

test('Escape closes it and gives the focus back to the button', () => {
  const button = mountTip();
  button.click();
  flushSync();
  expect(button.getAttribute('aria-expanded')).toBe('true');
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  flushSync();
  expect(button.getAttribute('aria-expanded')).toBe('false');
  expect(document.activeElement).toBe(button);
  // A second click opens it again.
  button.click();
  flushSync();
  expect(button.getAttribute('aria-expanded')).toBe('true');
});
