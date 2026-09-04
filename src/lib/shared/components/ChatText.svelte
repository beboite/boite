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
   * `plain` is the third answer and is the chat pane's: an agent's turn is
   * paragraphs, tool cards and a footer under one another, and a tinted bubble
   * around the paragraphs alone breaks that column into stripes. The bubble
   * stays the default because the orchestrator is a conversation of two voices,
   * where the tint is what tells them apart.
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
    /** No bubble at all: prose in a column, which is the chat pane's. */
    plain?: boolean;
    /** The thin bar at the end of an item still being streamed into. */
    caret?: boolean;
  };
  let { text, mine = false, wide = false, plain = false, caret = false }: Props = $props();
</script>

<div
  class="text-sm whitespace-pre-wrap break-words {wide || plain
    ? 'w-full'
    : 'max-w-[85%]'} {plain
    ? 'text-foreground'
    : mine
      ? 'rounded-md bg-accent px-2.5 py-1.5 text-foreground'
      : 'rounded-md bg-[var(--color-surface-2)] px-2.5 py-1.5 text-foreground'}"
>{text}{#if caret}<span class="chat-caret" aria-hidden="true"></span>{/if}</div>

<style>
  /* Two steps rather than a fade: a cursor that dims looks like a rendering
     glitch, and one that blinks reads as text still arriving. */
  .chat-caret {
    display: inline-block;
    width: 2px;
    height: 0.95em;
    margin-left: 1px;
    vertical-align: text-bottom;
    background: var(--color-foreground);
    animation: chat-blink 1s steps(2, start) infinite;
  }
  @keyframes chat-blink {
    50% {
      opacity: 0;
    }
  }
  :global(html[data-motion="reduced"]) .chat-caret {
    animation: none;
  }
</style>
