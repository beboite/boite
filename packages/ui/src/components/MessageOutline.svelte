<script lang="ts">
  import { ChevronUp } from '@lucide/svelte';
  import type { Message } from '@boite/contracts';
  import { fill, strings } from '../lib/strings';
  import { messagePreview, promptCommand } from '../lib/message-display';
  import { outlineEntries, outlineUnfold, outlineWave, type OutlineEntry } from '../lib/message-outline';
  import { tick } from 'svelte';
  import { Closing } from '../lib/closing.svelte';

  let { messages, active, jump, hasOlder, loading, loadOlder }: {
    messages: Message[]; active: string | null; jump: (id: string) => void;
    hasOlder: boolean; loading: boolean; loadOlder: () => void;
  } = $props();
  const prompts = $derived(messages.filter(message => message.role === 'user'));
  const entries = $derived(outlineEntries(prompts.length, prompts.findIndex(message => message.id === active)));
  const disclosure = new Closing();
  let group = $state<OutlineEntry | null>(null);
  let groupPosition = $state({ top: 0, left: 0 });
  let groupMenu = $state<HTMLDivElement>();
  let groupTrigger: HTMLButtonElement | null = null;
  async function openGroup(event: MouseEvent, entry: OutlineEntry) {
    const rect = event.currentTarget instanceof HTMLElement ? event.currentTarget.getBoundingClientRect() : null;
    if (!rect) return;
    groupTrigger = event.currentTarget as HTMLButtonElement;
    shown = null;
    group = entry;
    groupPosition = { top: Math.max(8, Math.min(window.innerHeight - 280, rect.top - 40)), left: rect.right + 8 };
    disclosure.show();
    await tick();
    groupMenu?.querySelector<HTMLButtonElement>('button')?.focus();
  }
  function groupKeys(event: KeyboardEvent) {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); disclosure.hide(); groupTrigger?.focus({ preventScroll: true }); return; }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const buttons = Array.from(groupMenu?.querySelectorAll<HTMLButtonElement>('button') ?? []);
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (at + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next]?.focus();
  }
  let rail = $state<HTMLElement>();
  let track = $state<HTMLElement>();
  /** Px per entry once the rail opens: what a pointer can aim at comfortably. */
  const OPEN = 14;
  /**
   * The rail opens around the point it was entered at, in px from its top at
   * rest, and holds that layout until the pointer leaves: a bar never slides
   * away from the pointer aiming at it. Null while the rail is closed.
   */
  let unfold = $state<{ at: number; room: { min: number; max: number } } | null>(null);
  /** Where the width wave peaks, in the same px; it follows the pointer and moves nothing. */
  let wave = $state<number | null>(null);
  /** The rest pitch and the screen edges the preview is placed from, read when the rail opens. */
  let frame = $state({ pitch: 6, top: 0, right: 0 });
  /** The prompt whose preview is open. */
  let shown = $state<string | null>(null);
  let pointing = false;
  const offsets = $derived(unfold ? outlineUnfold(entries.length, frame.pitch, OPEN, unfold.at, unfold.room) : entries.map(() => 0));
  const centers = $derived(offsets.map((offset, slot) => (slot + 0.5) * frame.pitch + offset));
  const weights = $derived(wave === null ? centers.map(() => 0) : outlineWave(centers, wave, OPEN * 1.4));
  const preview = $derived.by(() => {
    const slot = shown === null ? -1 : entries.findIndex(entry => entry.end === entry.start && prompts[entry.start]?.id === shown);
    if (slot < 0) return null;
    const number = entries[slot]!.start + 1;
    const text = messagePreview(prompts[number - 1]!) || strings.chat.imagePart;
    // The first line of the bubble sits level with its bar, wherever the open rail put that bar.
    const middle = frame.top + (centers[slot] ?? 0);
    return { text, command: promptCommand(text), number, top: Math.min(window.innerHeight - 130, Math.max(12, middle - 21)), left: frame.right + 8 };
  });
  $effect(() => {
    const selected = active;
    const node = rail;
    if (!node || node.matches(':hover') || node.contains(document.activeElement)) return;
    const marker = Array.from(node.querySelectorAll<HTMLElement>('[data-message-id]')).find(item => item.dataset.messageId === selected);
    if (marker) node.scrollTop = marker.offsetTop - node.clientHeight / 2;
  });
  /** Opens the rail around `at` (px from its top at rest), inside the timeline it floats over. */
  function open(at: (pitch: number, top: number) => number) {
    const first = track?.firstElementChild;
    const bounds = rail?.offsetParent?.getBoundingClientRect();
    if (!track || !rail || !bounds || !(first instanceof HTMLElement)) return;
    const top = track.getBoundingClientRect().top;
    const head = track.offsetTop;
    frame = { pitch: first.offsetHeight || 6, top, right: rail.getBoundingClientRect().right };
    unfold = { at: at(frame.pitch, top), room: { min: bounds.top + 8 + head - top, max: bounds.bottom - 8 - top } };
  }
  function point(event: PointerEvent) {
    if (event.pointerType === 'touch') return;
    pointing = true;
    if (!unfold) open((_, top) => event.clientY - top);
    wave = event.clientY - frame.top;
  }
  function release() {
    pointing = false;
    unfold = null;
    wave = null;
    shown = null;
  }
  /** Keyboard focus opens the rail around the focused entry, unless a pointer already holds it open. */
  function focusOn(id: string | null, slot: number) {
    shown = id;
    if (pointing) return;
    open(pitch => (slot + 0.5) * pitch);
    wave = centers[slot] ?? null;
  }
  function unfocus() {
    if (!pointing) release();
  }
  function onkeydown(event: KeyboardEvent) {
    if (event.key !== 'Escape') return;
    event.preventDefault(); event.stopPropagation(); shown = null;
    (event.target as HTMLElement).blur();
  }
</script>

<svelte:window onpointerdown={event => { if (!(event.target instanceof Element) || !event.target.closest('.group-menu, .outline-group')) disclosure.hide(); }} />

{#if prompts.length > 1 || hasOlder}
  <nav class="outline" class:open={unfold !== null} bind:this={rail} aria-label={strings.chat.outline} data-testid="message-outline" data-message-count={prompts.length} onscroll={() => shown = null} onpointermove={point} onpointerleave={release}>
    {#if hasOlder}
      <button class="earlier" style:--offset={`${unfold ? (centers[0] ?? 0) - OPEN / 2 : 0}px`} disabled={loading} onclick={loadOlder} {onkeydown} aria-label={strings.chat.earlierMessages} title={strings.chat.earlierMessages} data-testid="outline-earlier"><ChevronUp size={14} /></button>
    {/if}
    <div class="track" bind:this={track}>
      {#each entries as entry, slot (`${entry.start}:${entry.end}`)}
        {@const index = entry.start}
        {@const message = prompts[index]!}
        {@const lensed = { offset: offsets[slot] ?? 0, size: unfold ? OPEN : frame.pitch, weight: weights[slot] ?? 0 }}
        {#if entry.end > entry.start}
          <button class="outline-group" style:--offset={`${lensed.offset}px`} style:--size={`${lensed.size}px`} style:--weight={lensed.weight}
            aria-label={fill(strings.chat.messageGroup, { count: String(entry.end - entry.start + 1) })} title={fill(strings.chat.messageGroup, { count: String(entry.end - entry.start + 1) })} aria-haspopup="dialog" aria-expanded={disclosure.open && group?.start === entry.start} data-testid="outline-group"
            onpointerenter={() => shown = null} onfocus={() => focusOn(null, slot)} onblur={unfocus} onclick={event => void openGroup(event, entry)}><i aria-hidden="true"></i></button>
        {:else}
          <button class="marker" class:active={active === message.id} class:hot={shown === message.id} {onkeydown} aria-current={active === message.id ? 'location' : undefined}
            style:--offset={`${lensed.offset}px`} style:--size={`${lensed.size}px`} style:--weight={lensed.weight}
            aria-label={fill(strings.chat.goToMessage, { number: String(index + 1), text: messagePreview(message) || strings.chat.imagePart })}
            aria-describedby={shown === message.id ? 'message-preview' : undefined}
            onpointerenter={() => shown = message.id} onfocus={() => focusOn(message.id, slot)} onblur={unfocus}
            data-testid="message-marker" data-message-id={message.id} onclick={event => { jump(message.id); if (event.detail > 0) event.currentTarget.blur(); }}>
            <i aria-hidden="true"></i>
          </button>
        {/if}
      {/each}
    </div>
  </nav>
  {#if disclosure.shown && group}
    <div class="group-menu" class:closing={disclosure.closing} bind:this={groupMenu} use:disclosure.attach onanimationend={disclosure.end} role="dialog" aria-label={strings.chat.outline} tabindex="-1" onkeydown={groupKeys} style:top={`${groupPosition.top}px`} style:left={`${groupPosition.left}px`} data-testid="outline-group-menu">
      {#each prompts.slice(group.start, group.end + 1) as message, offset (message.id)}
        <button onclick={() => { jump(message.id); disclosure.hide(); }} data-group-message={message.id}><span class="number">{group.start + offset + 1}</span><span>{messagePreview(message) || strings.chat.imagePart}</span></button>
      {/each}
    </div>
  {/if}
  {#if preview}
    <!-- Drawn as the prompt's own bubble, so the rail reads as the list of what was sent. -->
    <div class="preview" id="message-preview" role="tooltip" data-testid="message-preview" style:top={`${preview.top}px`} style:left={`${preview.left}px`}>
      <span class="number">{String(preview.number).padStart(2, '0')}</span>
      <p>{#if preview.command}<span class="command">{preview.command}</span>{preview.text.slice(preview.command.length)}{:else}{preview.text}{/if}</p>
    </div>
  {/if}
{/if}

<style>
  /* With a mouse the rail stays tight and never scrolls: fourteen entries fit, and the open rail spills past its edges. */
  .outline { position: absolute; z-index: 5; left: 4px; top: 50%; transform: translateY(-50%); width: 28px; padding: 4px 0; }
  button { display: flex; align-items: center; width: 28px; padding: 0; border: 0; border-radius: var(--radius-sm); background: transparent; color: var(--color-muted-foreground); }
  button:active { transform: none; }
  button.earlier, .track button { translate: 0 var(--offset, 0px); transition: translate var(--dur-3) var(--ease-out-quint), color var(--dur-2), background var(--dur-2); }
  .earlier { justify-content: center; height: 20px; min-height: 20px; }
  .earlier:hover:not(:disabled), .earlier:focus-visible { background: var(--color-hover); color: var(--color-foreground); }
  .track { --pitch: 6px; }
  .track button { position: relative; justify-content: flex-start; height: var(--pitch); min-height: var(--pitch); padding-left: 6px; }
  /* The hit area is the slot the open rail gives the entry. It eases on the same curve as the bar, so the slots
     tile the rail at every frame: no gap between two bars, and no overlap that would hand a click to a neighbour. */
  .track button::before { content: ''; position: absolute; inset-inline: 0; top: 50%; height: var(--size, 100%); translate: 0 -50%; transition: height var(--dur-3) var(--ease-out-quint); }
  .track button:hover:not(:disabled) { background: transparent; }
  .track button:focus-visible { outline: none; }
  i { display: block; flex: none; width: calc(10px + 12px * var(--weight, 0)); height: 2px; border-radius: 1px; background: currentColor; opacity: calc(0.45 + 0.55 * var(--weight, 0)); transition: width var(--dur-2) var(--ease-out-quint), opacity var(--dur-2), box-shadow var(--dur-2); }
  .outline-group i { background: repeating-linear-gradient(to right, currentColor 0 2px, transparent 2px 4px); }
  .hot, .track button:focus-visible { color: var(--color-foreground); }
  .hot i, .track button:focus-visible i { opacity: 1; }
  .marker.active { color: var(--color-accent); }
  .marker.active i { width: calc(16px + 6px * var(--weight, 0)); opacity: 1; box-shadow: 0 0 8px color-mix(in oklch, var(--color-accent) 55%, transparent); }
  .group-menu { position: fixed; z-index: 30; width: min(300px, calc(100vw - 70px)); max-height: 264px; overflow-y: auto; padding: 6px; border: 1px solid var(--color-border); border-radius: var(--radius-lg); background: var(--color-surface-2); box-shadow: var(--shadow-e2); animation: pop var(--dur-2); }
  .group-menu.closing { animation-name: pop-out; pointer-events: none; }
  .group-menu button { width: 100%; height: auto; min-height: var(--control); padding: 6px 8px; gap: 10px; justify-content: flex-start; text-align: left; font-size: var(--text-sm); }
  .group-menu button span:last-child { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .group-menu button:hover, .group-menu button:focus-visible { background: var(--color-hover); color: var(--color-foreground); }
  /* The user bubble of the timeline, laid on the page colour so the tint matches, its short corner toward the bar. */
  .preview { position: fixed; z-index: 30; display: flex; align-items: baseline; gap: 10px; width: max-content; max-width: min(360px, calc(100vw - 70px)); padding: 10px 14px; border: 1px solid color-mix(in oklch, var(--color-accent) 35%, transparent); border-radius: var(--radius-lg); border-top-left-radius: var(--radius-sm); background: linear-gradient(var(--color-accent-soft), var(--color-accent-soft)), var(--color-background); box-shadow: var(--shadow-e2), 0 0 28px -10px color-mix(in oklch, var(--color-accent) 60%, transparent); pointer-events: none; transform-origin: 0 21px; animation: pop var(--dur-2) var(--ease-out-quint); transition: top var(--dur-2) var(--ease-out-quint); }
  .number { flex: none; color: var(--color-subtle); font-size: var(--text-xs); font-variant-numeric: tabular-nums; }
  .preview .number { color: var(--color-accent); font-family: var(--font-mono); }
  .command { color: var(--color-accent); font-weight: 600; }
  p { margin: 0; line-height: 1.5; color: var(--color-foreground); overflow-wrap: anywhere; white-space: pre-wrap; display: -webkit-box; -webkit-line-clamp: 3; line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
  /* A finger has no hover to open the rail: wider rows, and the rail scrolls when a short timeline cannot hold it. */
  @media (pointer: coarse) {
    .outline { max-height: min(60%, 320px); overflow-y: auto; scrollbar-width: none; }
    .track { --pitch: 18px; }
  }
</style>
