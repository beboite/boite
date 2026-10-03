<script lang="ts">
  import { strings } from '../lib/strings';

  let { bubble = false, label }: { bubble?: boolean; label?: string } = $props();
  let hidden = $state(document.hidden);
</script>

<svelte:document onvisibilitychange={() => hidden = document.hidden} />
<span class="typing" class:paused={hidden} role="status" aria-label={label ?? strings.chat.writing} data-testid="typing-indicator">
  <span class="dots" class:bubble aria-hidden="true">
    <span class="dot" data-testid="typing-dot"></span>
    <span class="dot" data-testid="typing-dot"></span>
    <span class="dot" data-testid="typing-dot"></span>
  </span>
  {#if label}<span class="label" aria-hidden="true">{label}</span>{/if}
</span>

<style>
  .typing { display: inline-flex; align-items: center; gap: 10px; color: var(--color-muted-foreground); font-size: var(--text-sm); }
  .dots { display: inline-flex; align-items: center; justify-content: center; gap: 4px; min-height: 24px; padding: 4px 2px; }
  .dots.bubble { min-width: 58px; min-height: 40px; padding: 10px 14px; background: var(--color-chat-reply); border: 1px solid var(--color-chat-reply-edge); border-radius: var(--radius-chat-bubble); border-bottom-left-radius: var(--radius-sm); }
  .dot { width: 5px; height: 5px; border-radius: var(--radius-full); background: currentColor; animation: typing var(--dur-typing) ease-in-out infinite; }
  .dot:nth-child(2) { animation-delay: var(--dur-typing-step); }
  .dot:nth-child(3) { animation-delay: calc(var(--dur-typing-step) * 2); }
  .paused .dot { animation-play-state: paused; }
  @keyframes typing { 0%, 60%, 100% { opacity: .4; transform: translateY(0); } 30% { opacity: 1; transform: translateY(-3px); } }
  @media (prefers-reduced-motion: reduce) { .dot { animation: none; } }
  :global(html[data-motion='reduced']) .dot { animation: none; }
</style>
