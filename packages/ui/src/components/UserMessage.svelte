<script lang="ts">
  import { Check, FileText } from '@lucide/svelte';
  import type { Message, Turn } from '@boite/contracts';
  import { bytes } from '../lib/format';
  import { decodedBytes } from '../lib/attachments';
  import { decodeBase64, saveAttachment } from '../lib/attachment-save';
  import { strings } from '../lib/strings';
  import type { Store } from '../lib/store.svelte';
  import { claudeKeywords, promptCommand, promptSegments, promptText } from '../lib/message-display';
  import type { TurnProgress } from '../lib/turn-progress.svelte';
  import ChatImage from './ChatImage.svelte';
  import PreviewReferences from './PreviewReferences.svelte';
  import { THUMB_HEIGHT } from '../lib/message-window';
  import MessageActions from './MessageActions.svelte';
  import MoveMarker from './MoveMarker.svelte';
  import SpawnMarker from './SpawnMarker.svelte';

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
    ontoggle,
    edit
  }: {
    store: Store;
    message: Message;
    turn: Turn | undefined;
    progress: TurnProgress;
    expanded: string[];
    ontoggle: (id: string) => void;
    /** Rewinds the thread to before this prompt and puts it back in the composer. */
    edit?: () => void;
  } = $props();

  type ImagePart = Extract<Message['parts'][number], { type: 'image' }>;


  /** The pictures a prompt was sent with; an assistant message never has one. */
  function imagesOf(message: Message): ImagePart[] {
    return message.parts.filter((part): part is ImagePart => part.type === 'image');
  }

  type FilePart = Extract<Message['parts'][number], { type: 'file' }>;

  /** What the file's link points at: its bytes inline, or nothing until they are fetched. */
  function fileHref(part: FilePart): string | undefined {
    return part.data.length > 0 ? `data:application/octet-stream;base64,${part.data}` : undefined;
  }

  /**
   * In the shell the link saves the file into Downloads and opens it; a browser
   * downloads it. A file sent as a reference is fetched first: its bytes never
   * came with the thread.
   */
  async function openFile(event: MouseEvent, part: FilePart): Promise<void> {
    const shell = window.__TAURI_INTERNALS__ !== undefined;
    if (!shell && part.data.length > 0) return;
    event.preventDefault();
    const name = part.name ?? strings.composer.attachAlt;
    try {
      const data = part.data.length > 0 || !part.media
        ? part.data
        : (await store.media.bytes({ threadId: message.threadId, messageId: message.id, slot: part.media.slot })).data;
      if (shell) {
        await saveAttachment(name, decodeBase64(data), true);
        return;
      }
      const url = URL.createObjectURL(new Blob([decodeBase64(data)], { type: 'application/octet-stream' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = name;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (error) {
      store.error = error instanceof Error ? error.message : String(error);
    }
  }

  const images = $derived(imagesOf(message));
  const copyText = $derived(message.parts.flatMap((part) => part.type === 'text' ? [promptText(part)] : []).join('\n\n'));
  /** The move this prompt told the agent about, first thing the core put before its words. */
  const moved = $derived(message.parts.flatMap((part) => (part.type === 'text' && part.moved ? [part.moved] : []))[0]);
  /** The thread whose agent sent this prompt with `boite thread new`. */
  const startedBy = $derived(message.parts.flatMap((part) => (part.type === 'text' && part.startedBy ? [part.startedBy] : []))[0]);
</script>

{#if moved}<MoveMarker notice={moved} />{/if}
{#if startedBy}<SpawnMarker {store} link={startedBy} direction="from" />{/if}
<div class="bubble">
  {#each message.parts as part, index (index)}
    {#if part.type === 'text'}
      {@const prompt = promptText(part)}
      {@const keywords = turn?.execution
        ? claudeKeywords(store.providerOf(turn.execution.providerId)?.protocol, turn.execution.model)
        : claudeKeywords(store.providerOf(store.openThread?.providerId ?? '')?.protocol, store.openThread?.model)}
      <p class="user-text" data-testid="text-part">{#if part.previewReferences?.length}<PreviewReferences text={prompt} references={part.previewReferences} {store} threadId={message.threadId} {keywords} />{:else}{#each promptSegments(prompt, promptCommand(prompt), keywords) as segment, at (at)}{#if segment.kind === 'command'}<span class="command">{segment.text}</span>{:else if segment.kind === 'plain'}{segment.text}{:else}<span class="keyword-{segment.kind}" data-testid="keyword-highlight">{segment.text}</span>{/if}{/each}{/if}</p>
    {:else if part.type === 'file'}
      <a class="file-attachment" data-testid="file-part" href={fileHref(part) ?? '#'} download={part.name ?? strings.composer.attachAlt} onclick={(event) => openFile(event, part)}>
        <FileText size={20} strokeWidth={1.5} />
        <span><span>{part.name ?? strings.composer.attachAlt}</span><small>{bytes(part.media?.bytes ?? decodedBytes(part.data))}</small></span>
      </a>
    {/if}
  {/each}
  {#if images.length > 0}
    <div class="images">
      {#each images as image, at (at)}
        {@const id = `${message.id}:${at}`}
        {@const full = expanded.includes(id)}
        <button
          type="button"
          class="shot"
          class:full
          title={image.alt ?? strings.chat.imagePart}
          onclick={() => ontoggle(id)}
        >
          <ChatImage
            {store}
            threadId={message.threadId}
            messageId={message.id}
            mimeType={image.mimeType}
            data={image.data}
            media={image.media}
            alt={image.alt ?? ''}
            maxHeight={full ? null : THUMB_HEIGHT}
            testid="image-part"
          />
        </button>
      {/each}
    </div>
  {/if}
</div>
<div class="receipts" data-testid="message-receipts">
  <MessageActions text={copyText} at={message.createdAt} {edit} />
  <span class="tick" data-testid="receipt-accepted" class:received={!!turn} title={strings.chat.accepted} aria-label={strings.chat.accepted}><Check size={12} /></span>
  <span class="tick" data-testid="receipt-responded" class:received={progress.responded(message.turnId)} title={strings.chat.responseStarted} aria-label={strings.chat.responseStarted}><Check size={12} /></span>
</div>

<style>
  .receipts { display: flex; align-items: center; gap: 1px; margin: 4px 2px 0; color: var(--color-muted-foreground); }
  .receipts .tick { display: flex; opacity: .45; }
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

  /* Clicked once, the picture is worth its own size instead of a thumbnail. */
  .shot.full {
    cursor: zoom-out;
  }
</style>
