import { afterEach, expect, test } from 'vitest';
import { createRawSnippet, flushSync, mount, tick, unmount } from 'svelte';
import Menu from './Menu.svelte';

let running: Record<string, unknown> | null = null;
const realGetAnimations = Element.prototype.getAnimations;

afterEach(() => {
  if (running) unmount(running, { outro: false });
  running = null;
  document.body.innerHTML = '';
  if (realGetAnimations) Element.prototype.getAnimations = realGetAnimations;
  else delete (Element.prototype as { getAnimations?: unknown }).getAnimations;
});

const ITEMS = [
  { id: 'default', label: 'Ask' },
  { id: 'acceptEdits', label: 'Accept edits' },
  { id: 'plan', label: 'Plan' }
];

function query<T extends Element>(selector: string): T {
  const node = document.querySelector<T>(selector);
  if (!node) throw new Error(`no ${selector}`);
  return node;
}

function items(): HTMLButtonElement[] {
  return Array.from(document.querySelectorAll<HTMLButtonElement>('[data-value]'));
}

function press(key: string): void {
  (document.activeElement ?? document.body).dispatchEvent(
    new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
  );
}

/** The effects, then the microtask the focus and the close settle on. */
async function settle(): Promise<void> {
  flushSync();
  await tick();
  await tick();
}

function open(picked: string[] = []): void {
  running = mount(Menu, {
    target: document.body,
    props: {
      items: ITEMS,
      onpick: (id: string) => picked.push(id),
      label: 'Permission mode',
      testid: 'mode',
      children: createRawSnippet(() => ({ render: () => '<span>Ask</span>' }))
    }
  });
  flushSync();
}

test('the menu opens on ArrowDown, walks with the arrows and Home and End, and Enter picks', async () => {
  const picked: string[] = [];
  open(picked);

  const trigger = query<HTMLButtonElement>('[data-testid=mode]');
  trigger.focus();
  press('ArrowDown');
  await settle();

  // Open, and the keyboard is already on the first row rather than nowhere.
  expect(document.querySelector('[data-testid=mode-menu]')).not.toBeNull();
  expect(trigger.getAttribute('aria-expanded')).toBe('true');
  expect(document.activeElement).toBe(items()[0]);

  press('ArrowDown');
  await settle();
  expect(document.activeElement).toBe(items()[1]);

  press('End');
  await settle();
  expect(document.activeElement).toBe(items()[2]);

  // Past the end it wraps rather than sticking on the last row.
  press('ArrowDown');
  await settle();
  expect(document.activeElement).toBe(items()[0]);

  press('Home');
  await settle();
  expect(document.activeElement).toBe(items()[0]);

  press('ArrowUp');
  await settle();
  expect(document.activeElement).toBe(items()[2]);

  press('Enter');
  await settle();
  expect(picked).toEqual(['plan']);
  expect(document.querySelector('[data-testid=mode-menu]')).toBeNull();
});

test('Escape closes and gives the trigger the focus back', async () => {
  open();
  const trigger = query<HTMLButtonElement>('[data-testid=mode]');
  trigger.focus();
  press('ArrowDown');
  await settle();

  press('Escape');
  await settle();
  expect(document.querySelector('[data-testid=mode-menu]')).toBeNull();
  expect(document.activeElement).toBe(trigger);
});

test('the popover holds one animation on the way out and unmounts on animationend', async () => {
  // jsdom runs no animation, so the helper closes on the spot unless the node
  // says one is running. This is what a browser reports while it plays.
  Element.prototype.getAnimations = () => [{} as Animation];

  open();
  const trigger = query<HTMLButtonElement>('[data-testid=mode]');
  trigger.click();
  await settle();
  expect(document.querySelector('[data-testid=mode-menu]')).not.toBeNull();

  trigger.click();
  await settle();

  // Still mounted, marked closing, and taking no pointer.
  const popover = query<HTMLElement>('[data-testid=mode-menu]');
  expect(popover.classList.contains('closing')).toBe(true);

  popover.dispatchEvent(new Event('animationend'));
  await settle();
  expect(document.querySelector('[data-testid=mode-menu]')).toBeNull();
});

test('a second open during the close cancels it, and the late animationend is ignored', async () => {
  Element.prototype.getAnimations = () => [{} as Animation];

  open();
  const trigger = query<HTMLButtonElement>('[data-testid=mode]');
  trigger.click();
  await settle();
  trigger.click();
  await settle();
  expect(query<HTMLElement>('[data-testid=mode-menu]').classList.contains('closing')).toBe(true);

  trigger.click();
  await settle();
  const popover = query<HTMLElement>('[data-testid=mode-menu]');
  expect(popover.classList.contains('closing')).toBe(false);

  // The animation of the cancelled close still ends; it must not take the node.
  popover.dispatchEvent(new Event('animationend'));
  await settle();
  expect(document.querySelector('[data-testid=mode-menu]')).not.toBeNull();
  expect(query<HTMLElement>('[data-testid=mode-menu]').classList.contains('closing')).toBe(false);
});
