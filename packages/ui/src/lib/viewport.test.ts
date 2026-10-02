import { afterEach, expect, test, vi } from 'vitest';
import { startViewport } from './viewport';

const root = document.documentElement;
let stop: (() => void) | undefined;
afterEach(() => {
  stop?.();
  stop = undefined;
  document.body.replaceChildren();
  root.style.removeProperty('--safe-area-top');
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function setup() {
  const viewport = new EventTarget() as EventTarget & { height: number; offsetTop: number; scale: number };
  viewport.height = 800;
  viewport.offsetTop = 0;
  viewport.scale = 1;
  const mobile = Object.assign(new EventTarget(), { matches: true });
  vi.stubGlobal('visualViewport', viewport);
  vi.stubGlobal('innerHeight', 800);
  vi.stubGlobal('matchMedia', () => mobile);
  return { viewport, mobile };
}

function focusEditor() {
  const editor = document.createElement('textarea');
  document.body.append(editor);
  editor.focus();
  return editor;
}

test('keyboard resize and scroll update the visible area; dismissing it restores CSS sizing', () => {
  const { viewport } = setup();
  focusEditor();
  stop = startViewport();
  viewport.height = 450;
  viewport.offsetTop = 20;
  viewport.dispatchEvent(new Event('resize'));
  expect(root.style.getPropertyValue('--app-height')).toBe('450px');
  expect(root.style.getPropertyValue('--app-top')).toBe('20px');
  expect(root.dataset.keyboard).toBe('open');
  viewport.offsetTop = 35;
  viewport.dispatchEvent(new Event('scroll'));
  expect(root.style.getPropertyValue('--app-top')).toBe('35px');
  viewport.height = 740; // iOS can still exclude a safe area after dismissal.
  viewport.dispatchEvent(new Event('resize'));
  expect(root.style.getPropertyValue('--app-height')).toBe('');
  expect(root.style.getPropertyValue('--app-top')).toBe('');
  expect(root.dataset.keyboard).toBe('closed');
});

test('a short visual viewport without a keyboard never shrinks the app', () => {
  const { viewport } = setup();
  viewport.height = 740;
  viewport.offsetTop = 60;
  stop = startViewport();
  expect(root.style.getPropertyValue('--app-height')).toBe('');
  expect(root.style.getPropertyValue('--app-top')).toBe('');
  expect(root.dataset.keyboard).toBe('closed');
  focusEditor(); // A hardware keyboard or a focus alone must not hide navigation.
  expect(root.dataset.keyboard).toBe('closed');
});

test('an installed iPhone uses the full viewport through keyboard dismissal and resume', () => {
  const { viewport } = setup();
  vi.stubGlobal('navigator', { standalone: true, userAgent: 'iPhone' });
  root.style.setProperty('--safe-area-top', '59px');
  vi.stubGlobal('innerHeight', 793);
  viewport.height = 793; // Both dvh and visualViewport omit the notch on cold start.
  stop = startViewport();
  expect(root.style.getPropertyValue('--app-height')).toBe('100vh');
  expect(root.dataset.keyboard).toBe('closed');
  focusEditor();
  viewport.height = 450;
  viewport.dispatchEvent(new Event('resize'));
  expect(root.style.getPropertyValue('--app-height')).toBe('450px');
  expect(root.dataset.keyboard).toBe('open');
  viewport.height = 793;
  viewport.dispatchEvent(new Event('resize'));
  window.dispatchEvent(new Event('pageshow'));
  expect(root.style.getPropertyValue('--app-height')).toBe('100vh');
  expect(root.dataset.keyboard).toBe('closed');
  // Landscape or OS-reserved status bars can expose no top inset.
  root.style.setProperty('--safe-area-top', '0px');
  window.dispatchEvent(new Event('resize'));
  expect(root.style.getPropertyValue('--app-height')).toBe('');
  root.style.setProperty('--safe-area-top', '59px');
  window.dispatchEvent(new Event('resize'));
  expect(root.style.getPropertyValue('--app-height')).toBe('100vh');
  stop();
  expect(root.style.getPropertyValue('--app-height')).toBe('');
});

test('Safari tabs keep dynamic sizing even when the screen has a safe area', () => {
  setup();
  vi.stubGlobal('navigator', { standalone: false });
  root.style.setProperty('--safe-area-top', '59px');
  stop = startViewport();
  expect(root.style.getPropertyValue('--app-height')).toBe('');
});

test('blur and return to portrait discard stale keyboard dimensions', async () => {
  const { viewport, mobile } = setup();
  const editor = focusEditor();
  viewport.height = 450;
  stop = startViewport();
  expect(root.dataset.keyboard).toBe('open');
  editor.blur();
  await Promise.resolve();
  expect(root.dataset.keyboard).toBe('closed');
  mobile.matches = false;
  mobile.dispatchEvent(new Event('change'));
  expect(root.dataset.keyboard).toBeUndefined();
  mobile.matches = true;
  viewport.height = 325; // WebKit can retain the landscape keyboard height.
  mobile.dispatchEvent(new Event('change'));
  window.dispatchEvent(new Event('resize'));
  window.dispatchEvent(new Event('pageshow'));
  expect(root.style.getPropertyValue('--app-height')).toBe('');
  expect(root.style.getPropertyValue('--app-top')).toBe('');
  expect(root.dataset.keyboard).toBe('closed');
});

test('pinch zoom does not masquerade as an on-screen keyboard', () => {
  const { viewport } = setup();
  focusEditor();
  viewport.height = 400;
  viewport.scale = 2;
  stop = startViewport();
  expect(root.dataset.keyboard).toBe('closed');
  expect(root.style.getPropertyValue('--app-height')).toBe('');
});

test('without the Visual Viewport API CSS remains responsible for the app height', () => {
  setup();
  vi.stubGlobal('visualViewport', undefined);
  focusEditor();
  stop = startViewport();
  expect(root.dataset.keyboard).toBe('closed');
  expect(root.style.getPropertyValue('--app-height')).toBe('');
});

test('cleanup removes listeners and prevents a queued focusout from restoring styles', async () => {
  const { viewport } = setup();
  const editor = focusEditor();
  viewport.height = 450;
  stop = startViewport();
  editor.blur();
  stop();
  await Promise.resolve();
  editor.focus();
  viewport.dispatchEvent(new Event('scroll'));
  window.dispatchEvent(new Event('pageshow'));
  expect(root.style.getPropertyValue('--app-height')).toBe('');
  expect(root.style.getPropertyValue('--app-top')).toBe('');
  expect(root.dataset.keyboard).toBeUndefined();
});

test('iOS uses the reported keyboard viewport without reserving the form-bar space twice', () => {
  const { viewport } = setup();
  vi.stubGlobal('navigator', { userAgent: 'iPhone', standalone: false });
  stop = startViewport();
  focusEditor();
  expect(root.style.getPropertyValue('--app-height')).toBe('');
  viewport.height = 450;
  viewport.dispatchEvent(new Event('resize'));
  expect(root.style.getPropertyValue('--app-height')).toBe('450px');
  viewport.height = 800;
  viewport.dispatchEvent(new Event('resize'));
  expect(root.style.getPropertyValue('--app-height')).toBe('');
});

test('late WebKit viewport metrics are picked up after a resize without a second event', () => {
  vi.useFakeTimers();
  const { viewport } = setup();
  focusEditor();
  stop = startViewport();
  viewport.height = 450;
  viewport.dispatchEvent(new Event('resize'));
  // A later layout updates the offset, then the keyboard finishes its animation.
  viewport.offsetTop = 120;
  vi.advanceTimersByTime(32);
  expect(root.style.getPropertyValue('--app-top')).toBe('120px');
  viewport.height = 410;
  viewport.offsetTop = 140;
  vi.advanceTimersByTime(300);
  expect(root.style.getPropertyValue('--app-height')).toBe('410px');
  expect(root.style.getPropertyValue('--app-top')).toBe('140px');
  viewport.dispatchEvent(new Event('resize'));
  stop();
  vi.advanceTimersByTime(500);
  expect(root.style.getPropertyValue('--app-top')).toBe('');
  expect(root.style.getPropertyValue('--app-height')).toBe('');
  expect(root.dataset.keyboard).toBeUndefined();
});
