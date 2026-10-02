import { on } from 'svelte/events';

/**
 * What the conversation needs from the DOM to stay at its bottom without
 * fighting its reader: who holds the list, what scrolls before it, and the
 * glide that takes it back down. `MessageList.svelte` owns the state these act on.
 */

/**
 * A Svelte action that watches the wheel without being able to cancel it. The
 * list only reads the wheel to leave the bottom; a cancellable listener made
 * the first notch of each gesture wait for the main thread before it scrolled,
 * and a streaming answer keeps that thread busy.
 */
export function watchWheel(node: HTMLElement, handler: (event: WheelEvent) => void): { destroy(): void } {
  return { destroy: on(node, 'wheel', handler, { passive: true }) };
}

/** Whether this wheel turns the list itself up: it can scroll, and nothing under the pointer takes the wheel first. */
export function wheelsUp(event: WheelEvent, box: HTMLElement): boolean {
  return event.deltaY < 0 && box.scrollTop > 0 && box.scrollHeight > box.clientHeight + 1 && !scrollsFirst(event.target, box);
}

/** An upward keyboard step leaves following before its small scroll can fall inside the bottom tolerance. */
export function keysUp(event: KeyboardEvent, box: HTMLElement | undefined): boolean {
  const upward = ['ArrowUp', 'PageUp', 'Home'].includes(event.key) || (event.key === ' ' && event.shiftKey);
  return upward && !!box && box.scrollTop > 0 && box.scrollHeight > box.clientHeight + 1 && !scrollsFirst(event.target, box);
}

/** Whether something between the pointer and the list scrolls up before the list does: a tool output, a code well. */
function scrollsFirst(target: EventTarget | null, box: HTMLElement): boolean {
  for (let node = target instanceof Element ? target : null; node && node !== box; node = node.parentElement) {
    if (node.scrollTop <= 0 || node.scrollHeight <= node.clientHeight) continue;
    const overflow = getComputedStyle(node).overflowY;
    if (overflow === 'auto' || overflow === 'scroll') return true;
  }
  return false;
}

/** Plain typing in a field, which never leaves the thread: no chord, not Enter, not Escape. */
export function typingKey(event: KeyboardEvent): boolean {
  const target = event.target;
  const field = target instanceof HTMLElement && (target.isContentEditable || target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement);
  return field && !event.ctrlKey && !event.metaKey && !event.altKey && event.key !== 'Enter' && event.key !== 'Escape';
}

/**
 * A finger, a text selection or the scrollbar thumb under the pointer holds
 * the list where it is: the answer grows below until they let go.
 */
export class PointerHold {
  held = false;
  #release: (() => void) | undefined;

  press(event: PointerEvent | TouchEvent): void {
    // A finger is followed by its touch events: the browser cancels its pointer as soon as it pans.
    const finger = !('pointerType' in event);
    if (!finger && event.pointerType === 'touch') return;
    this.release();
    this.held = true;
    const ends = finger ? ['touchend', 'touchcancel'] : ['pointerup', 'pointercancel'];
    // A button let go outside the window never reports its release. The window
    // losing focus, or the pointer moving with no button down, lets go too:
    // a hold left behind would stop the list from following its answer.
    const idle = (move: PointerEvent) => { if (move.buttons === 0) release(); };
    const release = () => {
      this.held = false;
      this.#release = undefined;
      for (const name of ends) window.removeEventListener(name, release, true);
      window.removeEventListener('pointermove', idle, true);
      window.removeEventListener('blur', release);
    };
    this.#release = release;
    for (const name of ends) window.addEventListener(name, release, true);
    if (!finger) window.addEventListener('pointermove', idle, true);
    // Not captured: a field's blur does not bubble, so only the window's own reaches here.
    window.addEventListener('blur', release);
  }

  release(): void {
    this.#release?.();
  }
}

const GLIDE_MS = 380;

/** The glide "Jump to latest" starts, on the app's ease-out-quint. */
export class BottomGlide {
  active = false;
  #frame = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;

  /** `arrived` runs when the glide reaches the bottom, or runs out of time on a page that draws no frames. */
  start(box: HTMLElement, arrived: () => void): void {
    this.stop();
    // A long way down cuts to the last screen and a half first: gliding the
    // whole way would mount, lay out and paint every message it crossed.
    const bottom = box.scrollHeight - box.clientHeight;
    const lead = Math.round(box.clientHeight * 1.5);
    if (bottom - box.scrollTop > lead) box.scrollTop = bottom - lead;
    // Each frame stands a shrinking distance above the bottom as it is now.
    // A native smooth scroll aims at the bottom measured when it starts, and
    // the messages it mounts on the way are measured and move that bottom.
    const away = box.scrollHeight - box.clientHeight - box.scrollTop;
    const start = performance.now();
    this.active = true;
    const step = (now: number) => {
      if (!this.active) return;
      const progress = Math.min(1, (now - start) / GLIDE_MS);
      box.scrollTop = box.scrollHeight - box.clientHeight - away * Math.pow(1 - progress, 5);
      if (progress < 1) this.#frame = requestAnimationFrame(step);
      else arrived();
    };
    this.#frame = requestAnimationFrame(step);
    this.#timer = setTimeout(arrived, GLIDE_MS + 500);
  }

  stop(): void {
    this.active = false;
    cancelAnimationFrame(this.#frame);
    clearTimeout(this.#timer);
  }
}
