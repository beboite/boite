<script lang="ts">
  import { ChevronUp } from '@lucide/svelte';
  import type { Message } from '@boite/contracts';
  import { fill, strings } from '../lib/strings';
  import { messagePreview } from '../lib/message-display';

  let { messages, active, jump, hasOlder, loading, loadOlder }: {
    messages: Message[]; active: string | null; jump: (id: string) => void;
    hasOlder: boolean; loading: boolean; loadOlder: () => void;
  } = $props();
  const prompts = $derived(messages.filter(message => message.role === 'user'));
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

{#if prompts.length > 1 || hasOlder}
  <nav class="outline" bind:this={rail} aria-label={strings.chat.outline} data-testid="message-outline" onpointerleave={() => preview = null} onscroll={() => preview = null}>
    {#if hasOlder}
      <button class="earlier" disabled={loading} onclick={loadOlder} {onkeydown} aria-label={strings.chat.earlierMessages} title={strings.chat.earlierMessages} data-testid="outline-earlier"><ChevronUp size={14} /></button>
    {/if}
    {#each prompts as message, index (message.id)}
      <button class="marker" class:active={active === message.id} {onkeydown} aria-current={active === message.id ? 'location' : undefined}
        aria-label={fill(strings.chat.goToMessage, { number: String(index + 1), text: messagePreview(message) || strings.chat.imagePart })}
        aria-describedby={preview?.number === index + 1 ? 'message-preview' : undefined}
        onpointerenter={event => show(event, message, index)} onfocus={event => show(event, message, index)} onblur={() => preview = null}
        data-testid="message-marker" data-message-id={message.id} onclick={event => { jump(message.id); if (event.detail > 0) event.currentTarget.blur(); }}>
        <i aria-hidden="true"></i>
      </button>
    {/each}
  </nav>
  {#if preview}
    <div class="preview" id="message-preview" role="tooltip" data-testid="message-preview" style:top={`${preview.top}px`} style:left={`${preview.left}px`}>
      <span class="number">{String(preview.number).padStart(2, '0')}</span><p>{preview.text}</p>
    </div>
  {/if}
{/if}

<style>
  .outline { position: absolute; z-index: 5; left: 4px; top: 50%; transform: translateY(-50%); width: 28px; max-height: min(60%, 320px); overflow-y: auto; scrollbar-width: none; padding: 4px 0; }
  button { display: flex; align-items: center; justify-content: center; width: 28px; height: 22px; min-height: 22px; padding: 0; border: 0; border-radius: var(--radius-sm); background: transparent; color: var(--color-muted-foreground); }
  button:hover, button:focus-visible { background: var(--color-hover); color: var(--color-foreground); }
  button:active { transform: none; }
  i { display: block; width: 12px; height: 2px; border-radius: var(--radius-sm); background: var(--color-subtle); transition: width var(--dur-2), background var(--dur-2); }
  .active i { background: var(--color-accent); width: 18px; }
  button:hover i, button:focus-visible i { background: var(--color-foreground); width: 18px; }
  .preview { position: fixed; z-index: 30; display: flex; align-items: flex-start; gap: 10px; width: max-content; max-width: min(330px, calc(100vw - 70px)); padding: 12px 14px; border: 1px solid var(--color-border); border-radius: var(--radius-lg); background: var(--color-surface-2); box-shadow: var(--shadow-e2); pointer-events: none; animation: fade-in var(--dur-2); }
  .number { color: var(--color-subtle); font-size: var(--text-xs); font-variant-numeric: tabular-nums; padding-top: 2px; }
  p { margin: 0; font-size: var(--text-sm); line-height: 1.5; color: var(--color-foreground); overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 3; line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
  @media (pointer: coarse) { button { height: var(--control); min-height: var(--control); } }
</style>

