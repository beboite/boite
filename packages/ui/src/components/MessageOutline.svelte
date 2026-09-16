<script lang="ts">
  import { ChevronUp } from '@lucide/svelte';
  import type { Message } from '@boite/contracts';
  import { fill, strings } from '../lib/strings';
  import { messagePreview } from '../lib/message-display';
  import { outlineEntries, type OutlineEntry } from '../lib/message-outline';
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
    preview = null;
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
  let preview = $state<{ text: string; top: number; left: number; number: number } | null>(null);
  $effect(() => {
    const selected = active;
    const node = rail;
    if (!node || node.matches(':hover') || node.contains(document.activeElement)) return;
    const marker = Array.from(node.querySelectorAll<HTMLElement>('[data-message-id]')).find(item => item.dataset.messageId === selected);
    if (marker) node.scrollTop = marker.offsetTop - node.clientHeight / 2;
  });
  function show(event: Event, message: Message, index: number) {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    preview = { text: messagePreview(message) || strings.chat.imagePart, top: Math.min(window.innerHeight - 130, Math.max(12, rect.top - 12)), left: rect.right + 8, number: index + 1 };
  }
  function onkeydown(event: KeyboardEvent) {
    if (event.key !== 'Escape') return;
    event.preventDefault(); event.stopPropagation(); preview = null;
    (event.target as HTMLElement).blur();
  }
</script>

<svelte:window onpointerdown={event => { if (!(event.target instanceof Element) || !event.target.closest('.group-menu, .outline-group')) disclosure.hide(); }} />

{#if prompts.length > 1 || hasOlder}
  <nav class="outline" bind:this={rail} aria-label={strings.chat.outline} data-testid="message-outline" data-message-count={prompts.length} onpointerleave={() => preview = null} onscroll={() => preview = null}>
    {#if hasOlder}
      <button class="earlier" disabled={loading} onclick={loadOlder} {onkeydown} aria-label={strings.chat.earlierMessages} title={strings.chat.earlierMessages} data-testid="outline-earlier"><ChevronUp size={14} /></button>
    {/if}
    {#each entries as entry (`${entry.start}:${entry.end}`)}
      {@const index = entry.start}
      {@const message = prompts[index]!}
      {#if entry.end > entry.start}
        <button class="outline-group" aria-label={fill(strings.chat.messageGroup, { count: String(entry.end - entry.start + 1) })} title={fill(strings.chat.messageGroup, { count: String(entry.end - entry.start + 1) })} aria-haspopup="dialog" aria-expanded={disclosure.open && group?.start === entry.start} data-testid="outline-group" onclick={event => void openGroup(event, entry)}><i></i><i></i></button>
      {:else}
      <button class="marker" class:active={active === message.id} {onkeydown} aria-current={active === message.id ? 'location' : undefined}
        aria-label={fill(strings.chat.goToMessage, { number: String(index + 1), text: messagePreview(message) || strings.chat.imagePart })}
        aria-describedby={preview?.number === index + 1 ? 'message-preview' : undefined}
        onpointerenter={event => show(event, message, index)} onfocus={event => show(event, message, index)} onblur={() => preview = null}
        data-testid="message-marker" data-message-id={message.id} onclick={event => { jump(message.id); if (event.detail > 0) event.currentTarget.blur(); }}>
        <i aria-hidden="true"></i>
      </button>
      {/if}
    {/each}
  </nav>
  {#if disclosure.shown && group}
    <div class="group-menu" class:closing={disclosure.closing} bind:this={groupMenu} use:disclosure.attach onanimationend={disclosure.end} role="dialog" aria-label={strings.chat.outline} tabindex="-1" onkeydown={groupKeys} style:top={`${groupPosition.top}px`} style:left={`${groupPosition.left}px`} data-testid="outline-group-menu">
      {#each prompts.slice(group.start, group.end + 1) as message, offset (message.id)}
        <button onclick={() => { jump(message.id); disclosure.hide(); }} data-group-message={message.id}><span class="number">{group.start + offset + 1}</span><span>{messagePreview(message) || strings.chat.imagePart}</span></button>
      {/each}
    </div>
  {/if}
  {#if preview}
    <div class="preview" id="message-preview" role="tooltip" data-testid="message-preview" style:top={`${preview.top}px`} style:left={`${preview.left}px`}>
      <span class="number">{String(preview.number).padStart(2, '0')}</span><p>{preview.text}</p>
    </div>
  {/if}
{/if}

<style>
  .outline { position: absolute; z-index: 5; left: 4px; top: 50%; transform: translateY(-50%); width: 28px; max-height: min(60%, 320px); overflow-y: auto; scrollbar-width: none; padding: 4px 0; }
  button { display: flex; align-items: center; justify-content: center; width: 28px; height: 12px; min-height: 12px; padding: 0; border: 0; border-radius: var(--radius-sm); background: transparent; color: var(--color-muted-foreground); }
  .outline-group { flex-direction: column; gap: 3px; }
  .outline-group i { width: 8px; opacity: .6; }
  .group-menu { position: fixed; z-index: 30; width: min(300px, calc(100vw - 70px)); max-height: 264px; overflow-y: auto; padding: 6px; border: 1px solid var(--color-border); border-radius: var(--radius-lg); background: var(--color-surface-2); box-shadow: var(--shadow-e2); animation: pop var(--dur-2); }
  .group-menu.closing { animation-name: pop-out; pointer-events: none; }
  .group-menu button { width: 100%; height: auto; min-height: var(--control); padding: 6px 8px; gap: 10px; justify-content: flex-start; text-align: left; font-size: var(--text-sm); }
  .group-menu button span:last-child { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  button:hover, button:focus-visible { background: var(--color-hover); color: var(--color-foreground); }
  button:active { transform: none; }
  i { display: block; width: 12px; height: 2px; border-radius: var(--radius-sm); background: var(--color-subtle); transition: width var(--dur-2), background var(--dur-2); }
  .active i { background: var(--color-accent); width: 18px; }
  button:hover i, button:focus-visible i { background: var(--color-foreground); width: 18px; }
  .preview { position: fixed; z-index: 30; display: flex; align-items: flex-start; gap: 10px; width: max-content; max-width: min(330px, calc(100vw - 70px)); padding: 12px 14px; border: 1px solid var(--color-border); border-radius: var(--radius-lg); background: var(--color-surface-2); box-shadow: var(--shadow-e2); pointer-events: none; animation: fade-in var(--dur-2); }
  .number { color: var(--color-subtle); font-size: var(--text-xs); font-variant-numeric: tabular-nums; padding-top: 2px; }
  p { margin: 0; font-size: var(--text-sm); line-height: 1.5; color: var(--color-foreground); overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 3; line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
  @media (pointer: coarse) { .outline button { height: 18px; min-height: 18px; } }
</style>

