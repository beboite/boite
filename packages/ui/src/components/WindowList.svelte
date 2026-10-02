<script lang="ts" generics="T">
  import { tick, untrack, type Snippet } from 'svelte';
  import { atOrBefore, reaches } from '../lib/message-window';
  let { items, keyOf, row, scrollRoot, estimate = 40, active = true, measurements = new Map<string, number>() }: {
    items: T[];
    keyOf: (item: T) => string;
    row: Snippet<[T]>;
    scrollRoot?: HTMLElement;
    estimate?: number;
    active?: boolean;
    measurements?: Map<string, number>;
  } = $props();
  const threshold = 80, overscan = 6;
  let container = $state<HTMLDivElement>();
  let top = $state(0), height = $state(600);
  let located = $state(false);
  let focusedKey = $state<string | null>(null);
  let focusedNode = $state<HTMLElement>();
  let revision = $state(0);
  const heights = untrack(() => measurements);
  type Entry = { key: string; item: T; gap: number };
  const cached = { keys: [] as string[], entries: [] as Entry[] };
  const keys = $derived.by(() => {
    const next = items.map(keyOf);
    if (next.length === cached.keys.length && next.every((key, index) => key === cached.keys[index])) return cached.keys;
    return cached.keys = next;
  });
  const sums = $derived.by(() => {
    revision;
    const result = [0];
    for (let i = 0; i < keys.length; i++) result.push(result[i]! + (heights.get(keys[i]!) ?? estimate));
    return result;
  });
  const windowed = $derived(items.length >= threshold);
  const range = $derived.by(() => {
    if (!active) return { start: 0, end: 0 };
    if (scrollRoot && !located) return { start: 0, end: 0 };
    if (top + height < 0 || top > sums[items.length]!) return { start: 0, end: 0 };
    if (!windowed) return { start: 0, end: items.length };
    const first = atOrBefore(sums, items.length, Math.max(0, top));
    return { start: Math.max(0, first - overscan), end: Math.min(items.length, reaches(sums, items.length, first, top + height) + overscan) };
  });
  const rendered = $derived.by(() => {
    const indices = Array.from({ length: range.end - range.start }, (_, index) => range.start + index);
    // A scrolled-away focused button must remain a real focus target. One retained row costs no unbounded range.
    const focused = focusedKey === null ? -1 : keys.indexOf(focusedKey);
    if (active && focused >= 0 && !indices.includes(focused)) indices.push(focused);
    indices.sort((a, b) => a - b);
    const previous = new Map(cached.entries.map(entry => [entry.key, entry]));
    const next = indices.map((index, position) => {
      const key = keys[index]!, item = items[index]!;
      const gap = sums[index]! - sums[position === 0 ? 0 : indices[position - 1]! + 1]!;
      const held = previous.get(key);
      return held && held.item === item && held.gap === gap ? held : { key, item, gap };
    });
    if (next.length === cached.entries.length && next.every((entry, index) => entry === cached.entries[index])) return cached.entries;
    return cached.entries = next;
  });
  const bottom = $derived(active ? sums[items.length]! - sums[keys.indexOf(rendered.at(-1)?.key ?? '') + 1]! : 0);
  $effect(() => {
    rendered;
    const node = focusedNode;
    if (node) void tick().then(() => {
      if (focusedNode === node && node.isConnected && document.activeElement === document.body) node.focus({ preventScroll: true });
    });
  });
  function outsidePointer(event: PointerEvent): void {
    if (!container?.contains(event.target as Node)) focusedNode = undefined;
  }
  function offset(): number {
    if (!scrollRoot || !container) return 0;
    return container.getBoundingClientRect().top - scrollRoot.getBoundingClientRect().top + scrollRoot.scrollTop;
  }
  function refresh(): void {
    if (!scrollRoot || !container) return;
    top = scrollRoot.scrollTop - offset();
    height = scrollRoot.clientHeight || 600;
    located = true;
  }
  $effect(() => {
    const root = scrollRoot;
    if (!root || !container || !active) return;
    refresh();
    root.addEventListener('scroll', refresh, { passive: true });
    window.addEventListener('resize', refresh);
    window.addEventListener('pointerdown', outsidePointer, true);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(refresh);
    observer?.observe(root);
    observer?.observe(container);
    return () => { root.removeEventListener('scroll', refresh); window.removeEventListener('resize', refresh); window.removeEventListener('pointerdown', outsidePointer, true); observer?.disconnect(); };
  });
  $effect(() => {
    const present = new Set(keys);
    untrack(() => { for (const key of heights.keys()) if (!present.has(key)) heights.delete(key); });
  });
  function measure(element: HTMLDivElement, key: string) {
    const read = () => {
      const value = element.getBoundingClientRect().height;
      if (!(value > 0)) return;
      const previous = heights.get(key) ?? estimate;
      if (Math.abs(previous - value) < 0.5) return;
      const index = keys.indexOf(key);
      // Keep the reading anchor stable when a retained row above it changes height.
      if (scrollRoot && index >= 0 && sums[index + 1]! <= top) scrollRoot.scrollTop += value - previous;
      heights.set(key, value);
      revision++;
    };
    read();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(read);
    observer?.observe(element);
    return { destroy: () => observer?.disconnect() };
  }
  function focusables(element: Element): HTMLElement[] {
    return [...element.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), a[href], [tabindex="0"]')]
      .filter(node => !node.closest('[inert]'));
  }
  async function focusAt(index: number, last = false): Promise<void> {
    if (!scrollRoot || index < 0 || index >= items.length) return;
    focusedKey = keys[index]!;
    const targetTop = sums[index]!, targetBottom = sums[index + 1]!;
    const origin = offset();
    if (targetTop < top) scrollRoot.scrollTop = origin + targetTop;
    else if (targetBottom > top + height) scrollRoot.scrollTop = origin + targetBottom - height;
    refresh();
    await tick();
    const slot = [...(container?.querySelectorAll<HTMLElement>('[data-window-key]') ?? [])].find(node => node.dataset.windowKey === focusedKey);
    if (!slot) return;
    const choices = focusables(slot);
    (last ? choices.at(-1) : choices[0])?.focus({ preventScroll: true });
  }
  function keydown(event: KeyboardEvent): void {
    if (!windowed || event.altKey || event.ctrlKey || event.metaKey || !(event.target instanceof HTMLElement)) return;
    const slot = event.target.closest<HTMLElement>('[data-window-key]');
    if (!slot || !container?.contains(slot)) return;
    const index = keys.indexOf(slot.dataset.windowKey!);
    const choices = focusables(slot);
    let target: number | null = null, last = false;
    if (event.key === 'Tab') {
      if (!event.shiftKey && event.target === choices.at(-1) && index + 1 < items.length) target = index + 1;
      if (event.shiftKey && event.target === choices[0] && index > 0) { target = index - 1; last = true; }
    } else if (event.target instanceof HTMLButtonElement && !event.shiftKey) {
      if (event.key === 'ArrowDown') target = index + 1;
      if (event.key === 'ArrowUp') target = index - 1;
      if (event.key === 'Home') target = 0;
      if (event.key === 'End') target = items.length - 1;
    }
    if (target === null || target < 0 || target >= items.length) return;
    event.preventDefault();
    void focusAt(target, last);
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="window-list" bind:this={container} onkeydown={keydown}
  onfocusout={event => { if (event.relatedTarget && !container?.contains(event.relatedTarget as Node)) focusedNode = undefined; }}
  onfocusin={event => { const slot = (event.target as HTMLElement).closest<HTMLElement>('[data-window-key]'); if (slot) { focusedKey = slot.dataset.windowKey ?? null; focusedNode = event.target as HTMLElement; } }}>
  {#each rendered as entry (entry.key)}
    {#if entry.gap > 0}<div class="spacer" style:height={`${entry.gap}px`} aria-hidden="true"></div>{/if}
    <div data-window-key={entry.key} use:measure={entry.key}>{@render row(entry.item)}</div>
  {/each}
  {#if bottom > 0}<div class="spacer" style:height={`${bottom}px`} aria-hidden="true"></div>{/if}
</div>

<style>
  .window-list { overflow-anchor: none; }
  .spacer { pointer-events: none; }
</style>
