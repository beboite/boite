<script lang="ts">
  /**
   * A message body, drawn the one way this app draws one.
   *
   * Lifted out of `features/home/ChatMessage.svelte` when the chat pane needed
   * the same thing: two components rendering assistant text would be two
   * answers to "what does a paragraph look like here", and the second one is
   * always the one that stops matching. `mine` is the only difference between
   * the two bubbles, and it is what the orchestrator chat already used.
   *
   * Deliberately not a markdown parser. What arrives is the agent's own text
   * and the app renders it as written, whitespace and all; the day a renderer
   * lands it lands here and both surfaces get it at once, which is the reason
   * this file exists rather than a copied `<div>`.
   */
  type Props = {
    text: string;
    /** The user's own line, which is the tinted right-aligned bubble. */
    mine?: boolean;
    /** Full width rather than the 85% a conversation bubble takes. */
    wide?: boolean;
  };
  let { text, mine = false, wide = false }: Props = $props();
</script>

<div
  class="rounded-md px-2.5 py-1.5 text-sm whitespace-pre-wrap break-words {wide
    ? 'w-full'
    : 'max-w-[85%]'} {mine
    ? 'bg-accent text-foreground'
    : 'bg-[var(--color-surface-2)] text-foreground'}"
>
  {text}
</div>
