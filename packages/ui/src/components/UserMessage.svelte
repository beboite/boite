<script lang="ts">
  import { Check, FileText } from '@lucide/svelte';
  import type { Message, Turn } from '@boite/contracts';
  import { bytes } from '../lib/format';
  import { decodedBytes } from '../lib/attachments';
  import { strings } from '../lib/strings';
  import type { Store } from '../lib/store.svelte';
  import { claudeKeywords, promptCommand, promptSegments, promptText } from '../lib/message-display';
  import type { TurnProgress } from '../lib/turn-progress.svelte';
  import PreviewReferences from './PreviewReferences.svelte';

  /**
   * A prompt in the timeline: its bubble, the pictures and files it was sent
   * with, and the two receipts under it. `expanded` belongs to the list, so a
   * picture opened stays open when the window drops the message and builds it again.
   */
  let {
    store,
    message,
    turn,
    progress,
    expanded,
    ontoggle
  }: {
    store: Store;
    message: Message;
    turn: Turn | undefined;
    progress: TurnProgress;
    expanded: string[];
    ontoggle: (id: string) => void;
  } = $props();

  type ImagePart = Extract<Message['parts'][number], { type: 'image' }>;

  /** The pictures a prompt was sent with; an assistant message never has one. */
  function imagesOf(message: Message): ImagePart[] {
    return message.parts.filter((part): part is ImagePart => part.type === 'image');
  }

  const images = $derived(imagesOf(message));
</script>

<div class="bubble">
  {#each message.parts as part, index (index)}
    {#if part.type === 'text'}
      {@const prompt = promptText(part)}
      {@const keywords = turn?.execution
        ? claudeKeywords(store.providerOf(turn.execution.providerId)?.protocol, turn.execution.model)
        : claudeKeywords(store.providerOf(store.openThread?.providerId ?? '')?.protocol, store.openThread?.model)}
      <p class="user-text" data-testid="text-part">{#if part.previewReferences?.length}<PreviewReferences text={prompt} references={part.previewReferences} {store} threadId={message.threadId} {keywords} />{:else}{#each promptSegments(prompt, promptCommand(prompt), keywords) as segment, at (at)}{#if segment.kind === 'command'}<span class="command">{segment.text}</span>{:else if segment.kind === 'plain'}{segment.text}{:else}<span class="keyword-{segment.kind}" data-testid="keyword-highlight">{segment.text}</span>{/if}{/each}{/if}</p>
    {:else if part.type === 'file'}
      <a class="file-attachment" data-testid="file-part" href="data:application/octet-stream;base64,{part.data}" download={part.name ?? strings.composer.attachAlt}>
        <FileText size={20} strokeWidth={1.5} />
        <span><span>{part.name ?? strings.composer.attachAlt}</span><small>{bytes(decodedBytes(part.data))}</small></span>
      </a>
    {/if}
  {/each}
  {#if images.length > 0}
    <div class="images">
      {#each images as image, at (at)}
        {@const id = `${message.id}:${at}`}
        <button
          type="button"
          class="shot"
          class:full={expanded.includes(id)}
          title={image.alt ?? strings.chat.imagePart}
          onclick={() => ontoggle(id)}
        >
          <img
            data-testid="image-part"
            src="data:{image.mimeType};base64,{image.data}"
            alt={image.alt ?? ''}
          />
        </button>
      {/each}
    </div>
  {/if}
</div>
<div class="receipts" data-testid="message-receipts">
  <span class:received={!!turn} title={strings.chat.accepted} aria-label={strings.chat.accepted}><Check size={12} /></span>
  <span class:received={progress.responded(message.turnId)} title={strings.chat.responseStarted} aria-label={strings.chat.responseStarted}><Check size={12} /></span>
</div>

<style>
  .receipts { display: flex; gap: 1px; margin: 4px 2px 0; color: var(--color-muted-foreground); }
  .receipts span { display: flex; opacity: .45; }
  .receipts .received { color: var(--color-accent); opacity: 1; }
  .command { color: var(--color-accent); font-weight: 600; }

  .bubble {
    max-width: 75%;
    padding: 10px 14px;
    background: var(--color-accent-soft);
    border: 1px solid color-mix(in oklch, var(--color-accent) 35%, transparent);
    border-radius: var(--radius-lg);
    border-bottom-right-radius: var(--radius-sm);
    box-shadow: var(--shadow-e1);
  }

  .user-text {
    white-space: pre-wrap;
    word-break: break-word;
  }

  /* The images sent with the prompt, in a row that wraps under the text. */
  .file-attachment { display: flex; align-items: center; gap: 10px; margin-top: 8px; padding: 10px 12px; border: 1px solid var(--color-border); border-radius: var(--radius-md); color: inherit; text-decoration: none; max-width: 280px; }
  .file-attachment:hover { background: var(--color-surface); }
  .file-attachment > span { min-width: 0; display: flex; flex-direction: column; gap: 3px; }
  .file-attachment > span > span { overflow-wrap: anywhere; font-size: var(--text-sm); }
  .file-attachment small { color: var(--color-muted-foreground); font-size: var(--text-xs); }
  .images {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 8px;
  }

  .user-text + .images {
    margin-top: 8px;
  }

  .shot {
    height: auto;
    width: auto;
    max-width: 100%;
    padding: 0;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-surface);
    overflow: hidden;
    cursor: zoom-in;
  }

  .shot:hover:not(:disabled) {
    background: var(--color-surface);
    border-color: var(--color-edge);
  }

  .shot img {
    display: block;
    max-width: 100%;
    max-height: 240px;
    object-fit: contain;
  }

  /* Clicked once, the picture is worth its own size instead of a thumbnail. */
  .shot.full {
    cursor: zoom-out;
  }

  .shot.full img {
    max-height: none;
  }
</style>
