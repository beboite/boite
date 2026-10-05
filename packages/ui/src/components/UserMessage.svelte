<script lang="ts">
  import { Check, CornerDownLeft, FileText } from '@lucide/svelte';
  import type { Message, Turn } from '@boite/contracts';
  import { bytes } from '../lib/format';
  import { decodedBytes } from '../lib/attachments';
  import { browserDownload, decodeBase64, saveAttachment } from '../lib/attachment-save';
  import { galleryFrom, media, viewerHost, type Gallery, type MediaItem } from '../lib/media-gallery';
  import { strings } from '../lib/strings';
  import type { Store } from '../lib/store.svelte';
  import { claudeKeywords, promptCommand, promptSegments, promptText } from '../lib/message-display';
  import type { TurnProgress } from '../lib/turn-progress.svelte';
  import PreviewReferences from './PreviewReferences.svelte';
  import OmittedPart from './OmittedPart.svelte';
  import MessageActions from './MessageActions.svelte';
  import MoveMarker from './MoveMarker.svelte';
  import ImageViewer from './ImageViewer.svelte';

  /**
   * A prompt in the timeline: its bubble, the pictures and files it was sent
   * with, and the two receipts under it. A picture opens in the viewer, with
   * the thread's other pictures and videos a swipe away.
   */
  let {
    store,
    message,
    turn,
    progress,
    edit
  }: {
    store: Store;
    message: Message;
    turn: Turn | undefined;
    progress: TurnProgress;
    /** Rewinds the thread to before this prompt and puts it back in the composer. */
    edit?: () => void;
  } = $props();

  type ImagePart = Extract<Message['parts'][number], { type: 'image' }>;

  /** The pictures a prompt was sent with, each with its place among the parts; an assistant message never has one. */
  function imagesOf(message: Message): { image: ImagePart; index: number }[] {
    return message.parts.flatMap((part, index) => (part.type === 'image' ? [{ image: part, index }] : []));
  }

  /** A picture a light page left on the core, read once its place nears the screen. */
  function loadImage(index: number): void {
    store.loadMessageAttachment(message.threadId, message.id, index).catch((error: unknown) => { store.reportError(error, 'minor'); });
  }

  type FilePart = Extract<Message['parts'][number], { type: 'file' }>;

  /** In the shell the link saves the file into Downloads and opens it; a browser downloads it. */
  async function openFile(event: MouseEvent, part: FilePart): Promise<void> {
    if (window.__TAURI_INTERNALS__ === undefined && !part.dataDeferred) return;
    event.preventDefault();
    const owner = store, threadId = message.threadId, messageId = message.id, index = message.parts.indexOf(part);
    try {
      const data = part.dataDeferred ? await owner.loadMessageAttachment(threadId, messageId, index) : part.data;
      if (window.__TAURI_INTERNALS__ === undefined) browserDownload(`data:application/octet-stream;base64,${data}`, part.name ?? strings.composer.attachAlt);
      else await saveAttachment(part.name ?? strings.composer.attachAlt, decodeBase64(data), true);
    } catch (error) {
      owner.reportError(error, 'minor');
    }
  }

  const images = $derived(imagesOf(message));
  /** The timeline's viewer; outside one (a test, a preview) the message shows its own. */
  const host = viewerHost();
  let viewing = $state<Gallery | null>(null);
  function show(gallery: Gallery): void {
    if (host) host.open(gallery); else viewing = gallery;
  }

  /** The picture as the viewer shows it, under a name a saved copy can keep. */
  function viewed(image: ImagePart, at: number): MediaItem {
    const extension = image.mimeType.split('/')[1]?.replace('jpeg', 'jpg') ?? 'png';
    const name = image.alt || `image-${at + 1}.${extension}`;
    const src = `data:${image.mimeType};base64,${image.data}`;
    return {
      src, name, mimeType: image.mimeType, kind: 'image',
      save: () => {
        if (window.__TAURI_INTERNALS__ === undefined) { browserDownload(src, name); return; }
        saveAttachment(name, decodeBase64(image.data), false).catch((error: unknown) => { store.reportError(error, 'minor'); });
      }
    };
  }
  const copyText = $derived(message.parts.flatMap((part) => part.type === 'text' ? [promptText(part)] : []).join('\n\n'));
  /** The move this prompt told the agent about, first thing the core put before its words. */
  const moved = $derived(message.parts.flatMap((part) => (part.type === 'text' && part.moved ? [part.moved] : []))[0]);
  /** The thread whose agent sent this prompt with `boite thread new`. */
  const startedBy = $derived(message.parts.flatMap((part) => (part.type === 'text' && part.startedBy ? [part.startedBy] : []))[0]);
  /** The starting thread opens while this machine still has it. */
  const starterPresent = $derived(!!startedBy && store.threads.some((thread) => thread.id === startedBy.threadId && !thread.archived));
</script>

{#if moved}<MoveMarker notice={moved} />{/if}
<!-- A prompt another thread's agent wrote reads like forwarded mail, on the agents' side: never as the user's own bubble. -->
<div class="bubble" class:agent={!!startedBy} data-testid={startedBy ? 'agent-prompt' : undefined}>
  {#if startedBy}
    <div class="agent-from" data-testid="spawn-marker" data-direction="from">
      <span class="agent-icon"><CornerDownLeft size={16} strokeWidth={1.75} aria-hidden="true" /></span>
      <span class="agent-source">
        <span class="agent-label">{strings.chat.promptFromAgent}</span>
        {#if starterPresent}
          <button type="button" class="agent-link" data-testid="spawn-marker-open" title={strings.chat.openLinkedThread} onclick={() => void store.open(startedBy.threadId)}>{startedBy.title}</button>
        {:else}
          <strong>{startedBy.title}</strong>
        {/if}
        <span class="agent-project">{startedBy.project}</span>
      </span>
    </div>
  {/if}
  {#each message.parts as part, index (index)}
    {#if part.type === 'text'}
      {@const prompt = promptText(part)}
      {@const keywords = turn?.execution
        ? claudeKeywords(store.providerOf(turn.execution.providerId)?.protocol, turn.execution.model)
        : claudeKeywords(store.providerOf(store.openThread?.providerId ?? '')?.protocol, store.openThread?.model)}
      <p class="user-text" data-testid="text-part">{#if part.previewReferences?.length}<PreviewReferences text={prompt} references={part.previewReferences} {store} threadId={message.threadId} {keywords} />{:else}{#each promptSegments(prompt, promptCommand(prompt), keywords) as segment, at (at)}{#if segment.kind === 'command'}<span class="command">{segment.text}</span>{:else if segment.kind === 'plain'}{segment.text}{:else}<span class="keyword-{segment.kind}" data-testid="keyword-highlight">{segment.text}</span>{/if}{/each}{/if}</p>
    {:else if part.type === 'file'}
      <a class="file-attachment" data-testid="file-part" href={part.dataDeferred ? '#' : `data:application/octet-stream;base64,${part.data}`} download={part.name ?? strings.composer.attachAlt} onclick={(event) => openFile(event, part)}>
        <FileText size={20} strokeWidth={1.5} />
        <span><span>{part.name ?? strings.composer.attachAlt}</span><small>{bytes(part.bytes ?? decodedBytes(part.data))}</small></span>
      </a>
    {/if}
  {/each}
  {#if images.length > 0}
    <div class="images">
      {#each images as { image, index }, at (at)}
        {#if image.dataDeferred}
          <OmittedPart bytes={image.bytes ?? 0} load={() => loadImage(index)} />
        {:else}
        <button
          type="button"
          class="shot"
          title={image.alt ?? strings.chat.imagePart}
          use:media={() => viewed(image, at)}
          onclick={(event) => show(galleryFrom(event.currentTarget, viewed(image, at)))}
          data-testid="image-open"
        >
          <img
            data-testid="image-part"
            src="data:{image.mimeType};base64,{image.data}"
            alt={image.alt ?? ''}
          />
        </button>
        {/if}
      {/each}
    </div>
  {/if}
</div>
{#if viewing}<ImageViewer items={viewing.items} index={viewing.index} onclose={() => viewing = null} />{/if}
<div class="receipts" class:agent={!!startedBy} data-testid="message-receipts">
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
    max-width: min(85%, var(--prose));
    padding: 12px 16px;
    background: var(--color-accent-soft);
    border: 1px solid color-mix(in oklch, var(--color-accent) 35%, transparent);
    border-radius: var(--radius-bubble);
    border-bottom-right-radius: var(--radius-sm);
    box-shadow: var(--shadow-e1);
  }

  .bubble.agent, .receipts.agent { align-self: flex-start; }
  .bubble.agent {
    background: var(--color-surface-2);
    border-color: var(--color-border);
    border-left: 2px solid var(--color-edge);
    border-radius: var(--radius-lg);
    border-bottom-left-radius: var(--radius-sm);
  }
  .agent-from { display: flex; align-items: flex-start; gap: 9px; margin-bottom: 8px; color: var(--color-muted-foreground); }
  .agent-icon { display: flex; flex: none; margin-top: 2px; color: var(--color-foreground); }
  .agent-source { min-width: 0; display: flex; flex-direction: column; align-items: flex-start; gap: 2px; font-size: var(--text-xs); }
  .agent-source strong, .agent-link { color: var(--color-foreground); font-size: var(--text-sm); font-weight: 600; overflow-wrap: anywhere; white-space: normal; text-align: left; }
  .agent-link { height: auto; padding: 0; border: 0; border-radius: var(--radius-sm); background: transparent; }
  .agent-link:hover { text-decoration: underline; }
  .agent-project { overflow-wrap: anywhere; }

  @media (max-width: 720px) { .bubble { max-width: 90%; padding: 10px 14px; } }

  .user-text {
    white-space: pre-wrap;
    word-break: break-word;
    font-size: var(--text-reading);
    line-height: var(--leading-reading);
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

</style>
