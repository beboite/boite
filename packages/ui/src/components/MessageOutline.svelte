<script lang="ts">
  import { ChevronUp } from '@lucide/svelte';
  import type { Message } from '@boite/contracts';
  import { fill, strings } from '../lib/strings';

  let { messages, active, jump, hasOlder, loading, loadOlder }: {
    messages: Message[];
    active: string | null;
    jump: (id: string) => void;
    hasOlder: boolean;
    loading: boolean;
    loadOlder: () => void;
  } = $props();
  const prompts = $derived(messages.filter(message => message.role === 'user'));
  let rail = $state<HTMLElement>();
  $effect(() => {
    const selected = active;
    const node = rail;
    if (!node || node.matches(':hover') || node.contains(document.activeElement)) return;
    const marker = Array.from(node.querySelectorAll<HTMLElement>('[data-message-id]')).find(item => item.dataset.messageId === selected);
    if (marker) node.scrollTop = marker.offsetTop - node.clientHeight / 2;
  });
  function preview(message: Message): string {
    return message.parts.filter(part => part.type === 'text').map(part => part.text).join(' ').trim() || strings.chat.imagePart;
  }
  function onkeydown(event: KeyboardEvent) {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    (event.target as HTMLElement).blur();
  }
</script>

{#if prompts.length > 1 || hasOlder}
  <nav class="outline" bind:this={rail} aria-label={strings.chat.outline} data-testid="message-outline">
    {#if hasOlder}
      <button class="earlier" disabled={loading} onclick={loadOlder} {onkeydown} aria-label={strings.chat.earlierMessages} title={strings.chat.earlierMessages} data-testid="outline-earlier">
        <ChevronUp size={14} /><span>{loading ? strings.chat.loadingOlder : strings.chat.earlierMessages}</span>
      </button>
    {/if}
    {#each prompts as message, index (message.id)}
      <button class="marker" class:active={active === message.id} {onkeydown} aria-current={active === message.id ? 'location' : undefined}
        aria-label={fill(strings.chat.goToMessage, { number: String(index + 1), text: preview(message) })}
        title={preview(message)} data-testid="message-marker" data-message-id={message.id} onclick={event => {
          jump(message.id);
          if (event.detail > 0) event.currentTarget.blur();
        }}>
        <i aria-hidden="true"></i><span>{preview(message)}</span>
      </button>
    {/each}
  </nav>
{/if}

<style>
  .outline { position: absolute; z-index: 5; left: 4px; top: 50%; transform: translateY(-50%); width: 28px; max-height: min(70%, 420px); padding: 4px 0; overflow: auto; scrollbar-width: none; border: 1px solid transparent; border-radius: var(--radius-lg); transition: width var(--dur-2) var(--ease-out-quint), background var(--dur-2); }
  .outline:hover, .outline:focus-within { width: min(280px, calc(100% - 16px)); background: var(--color-surface-2); border-color: var(--color-border); box-shadow: var(--shadow-e2); }
  button { display: flex; gap: 10px; width: 100%; height: var(--control-sm); min-height: var(--control-sm); padding: 0 6px; border: 0; border-radius: var(--radius-sm); background: transparent; color: var(--color-muted-foreground); text-align: left; justify-content: flex-start; }
  button:hover, button:focus-visible { background: var(--color-hover); color: var(--color-foreground); }
  button:active { transform: none; }
  i { display: block; flex: none; width: 12px; height: 2px; border-radius: var(--radius-sm); background: var(--color-subtle); }
  .active i, button:hover i, button:focus-visible i { background: var(--color-foreground); }
  .active span { color: var(--color-foreground); }
  span { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: var(--text-xs); opacity: 0; }
  .outline:hover span, .outline:focus-within span { opacity: 1; }
  .earlier :global(svg) { flex: none; }
  @media (pointer: coarse) { button { height: var(--control); min-height: var(--control); } }
</style>
