<script lang="ts">
  import { CornerDownLeft, FileText } from '@lucide/svelte';
  import type { Message, Turn } from '@boite/contracts';
  import { bytes, count } from '../lib/format';
  import { decodedBytes } from '../lib/attachments';
  import { browserDownload, decodeBase64, saveAttachment } from '../lib/attachment-save';
  import { galleryFrom, media, viewerHost, type Gallery, type MediaItem } from '../lib/media-gallery';
  import { fill, strings } from '../lib/strings';
  import type { Store } from '../lib/store.svelte';
  import { claudeKeywords, promptCommand, promptSegments, promptText } from '../lib/message-display';
  import PreviewReferences from './PreviewReferences.svelte';
  import ChatImage from './ChatImage.svelte';
  import { THUMB_HEIGHT } from '../lib/message-window';
  import MessageReceipts from './MessageReceipts.svelte';
  import MoveMarker from './MoveMarker.svelte';
  import Deferred, { parts } from './Deferred.svelte';

  /**
   * A prompt in the timeline: its bubble, the pictures and files it was sent
   * with, and the two receipts under it. A picture opens in the viewer, with
   * the thread's other pictures and videos a swipe away. An agent's
   * conversation draws its user's messages with it too, from a message whose
   * pictures and files are read where the agent's turn keeps them.
   */
  let {
    store,
    message,
    turn,
    accepted,
    responded,
    edit
  }: {
    store: Store;
    message: Message;
    turn: Turn | undefined;
    /** The first tick: the core holds the prompt. */
    accepted: boolean;
    /** The second tick: the agent took it into a turn. */
    responded: boolean;
    /** Rewinds the thread to before this prompt and puts it back in the composer. */
    edit?: () => void;
  } = $props();

  type ImagePart = Extract<Message['parts'][number], { type: 'image' }>;

  /** The pictures a prompt was sent with, each with its place among the parts; an assistant message never has one. */
  function imagesOf(message: Message): { image: ImagePart; index: number }[] {
    return message.parts.flatMap((part, index) => (part.type === 'image' ? [{ image: part, index }] : []));
  }

  type FilePart = Extract<Message['parts'][number], { type: 'file' }>;

  /** In the shell the link saves the file into Downloads and opens it; a browser downloads it. */
  async function openFile(event: MouseEvent, part: FilePart): Promise<void> {
    if (window.__TAURI_INTERNALS__ === undefined && !part.dataDeferred) return;
    event.preventDefault();
    const owner = store, threadId = message.threadId, messageId = message.id, index = message.parts.indexOf(part);
    try {
      const data = part.dataDeferred ? await owner.loadMessageAttachment(threadId, messageId, index) : part.data;
      if (data === null) return;
      if (window.__TAURI_INTERNALS__ === undefined) browserDownload(`data:application/octet-stream;base64,${data}`, part.name ?? strings.composer.attachAlt);
      else await saveAttachment(part.name ?? strings.composer.attachAlt, decodeBase64(data), true);
    } catch (error) {
      owner.reportError(error, 'minor');
    }
  }

  const images = $derived(imagesOf(message));
  /**
   * The pictures keep to one row of thumbnails: the ones that wrap past it are
   * clipped, and a "+N" over the last one in the row unfolds the rest. Every
   * thumbnail stays laid out, so the bubble is as wide as all of them would be
   * and what fits never depends on what is shown.
   */
  let row = $state<HTMLDivElement>();
  let rowSize = $state<DOMRectReadOnly>();
  let unfolded = $state(false);
  let fits = $state(Infinity);
  let cover = $state<{ left: number; width: number } | null>(null);
  $effect(() => {
    void rowSize?.width;
    void images.length;
    if (!row || unfolded) { fits = Infinity; cover = null; return; }
    const tiles = Array.from(row.querySelectorAll<HTMLElement>(':scope > .shot'));
    const top = tiles[0]?.offsetTop;
    const count = tiles.filter(tile => tile.offsetTop === top).length;
    const last = tiles[count - 1];
    fits = count;
    cover = count < tiles.length && last ? { left: last.offsetLeft, width: last.offsetWidth } : null;
  });
  // The tile under the +N is pointer-blocked and its focus ring would be hidden:
  // it is inert like the wrapped ones, and counted with them.
  let hidden = $derived(cover ? images.length - fits + 1 : 0);
  /** The timeline's viewer; outside one (a test, a preview) the message shows its own. */
  const host = viewerHost();
  let viewing = $state<Gallery | null>(null);
  function show(gallery: Gallery): void {
    if (host) host.open(gallery); else viewing = gallery;
  }

  /** The picture as the viewer shows it, under a name a saved copy can keep; none while its original is on the core. */
  function viewed(image: ImagePart, at: number): MediaItem | null {
    if (image.dataDeferred || !image.data) return null;
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
  /** The picture whose original is on its way to the viewer. */
  let opening = $state<number | null>(null);
  /**
   * The viewer shows the original. A deferred picture is drawn from its light
   * copy, so its original is fetched first, once, and then opens.
   */
  async function open(from: HTMLElement, image: ImagePart, index: number, at: number): Promise<void> {
    let shown = image;
    if (image.dataDeferred) {
      if (opening !== null) return;
      opening = index;
      try {
        // A message the store holds gets its bytes too; one drawn from elsewhere opens from the answer.
        const data = await store.loadMessageAttachment(message.threadId, message.id, index);
        if (data === null) return;
        shown = { ...image, data, dataDeferred: undefined };
      } catch (error) {
        store.reportError(error, 'minor');
        return;
      } finally {
        opening = null;
      }
    }
    const item = viewed(shown, at);
    if (item) show(galleryFrom(from, item));
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
          <button type="button" class="agent-link" data-testid="spawn-marker-open" data-preload-thread={startedBy.threadId} title={strings.chat.openLinkedThread} onclick={() => void store.open(startedBy.threadId)}>{startedBy.title}</button>
        {:else}
          <strong>{startedBy.title}</strong>
        {/if}
        <span class="agent-project">{startedBy.machine ? `${startedBy.project} · ${startedBy.machine}` : startedBy.project}</span>
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
      {#if part.omitted}<p class="text-omitted" data-testid="text-omitted">{fill(strings.chat.textOmitted, { count: count(part.omitted) })}</p>{/if}
    {:else if part.type === 'file'}
      <a class="file-attachment" data-testid="file-part" href={part.dataDeferred ? '#' : `data:application/octet-stream;base64,${part.data}`} download={part.name ?? strings.composer.attachAlt} onclick={(event) => openFile(event, part)}>
        <FileText size={20} strokeWidth={1.5} />
        <span><span>{part.name ?? strings.composer.attachAlt}</span><small>{bytes(part.bytes ?? decodedBytes(part.data))}</small></span>
      </a>
    {/if}
  {/each}
  {#if images.length > 0}
    <div class="images" class:unfolded bind:this={row} bind:contentRect={rowSize} style:--thumb="{THUMB_HEIGHT}px" data-testid="message-images">
      {#each images as { image, index }, at (at)}
        <!-- One box from the blur to the light copy to the original: nothing changes size. -->
        <button
          type="button"
          class="shot"
          title={image.alt ?? strings.chat.imagePart}
          aria-busy={opening === index}
          inert={at >= (cover ? fits - 1 : fits)}
          use:media={() => viewed(image, at)}
          onclick={(event) => void open(event.currentTarget, image, index, at)}
          data-testid="image-open"
        >
          <ChatImage {store} threadId={message.threadId} messageId={message.id} partIndex={index} {image} tile={THUMB_HEIGHT} />
        </button>
      {/each}
      {#if cover}
        <button
          type="button"
          class="more"
          style:left="{cover.left}px"
          style:width="{cover.width}px"
          aria-label={fill(strings.composer.attachMore, { count: String(hidden) })}
          title={fill(strings.composer.attachMore, { count: String(hidden) })}
          onclick={() => unfolded = true}
          data-testid="message-images-more"
        >+{hidden}</button>
      {/if}
    </div>
  {/if}
</div>
{#if viewing}{@const view = viewing}<Deferred part={parts.ImageViewer} floating>{#snippet children(ImageViewer)}<ImageViewer items={view.items} index={view.index} onclose={() => viewing = null} />{/snippet}</Deferred>{/if}
<MessageReceipts text={copyText} at={message.createdAt} {edit} {accepted} {responded} agent={!!startedBy} />

<style>
  .text-omitted { margin: 4px 0 0; font-size: var(--text-xs); color: var(--color-muted-foreground); }

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

  .bubble.agent { align-self: flex-start; }
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
    position: relative;
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    max-height: calc(var(--thumb) + 2px);
    overflow: hidden;
    margin-top: 8px;
  }

  .images.unfolded {
    max-height: none;
  }

  .shot {
    flex: none;
    height: auto;
    width: auto;
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

  /* Over the row's last thumbnail, which still shows through. */
  .more {
    position: absolute;
    top: 0;
    height: calc(var(--thumb) + 2px);
    padding: 0;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: color-mix(in oklab, var(--color-background) 72%, transparent);
    color: var(--color-foreground);
    font-size: var(--text-lg);
    font-weight: 600;
  }

  .more:hover {
    background: color-mix(in oklab, var(--color-background) 58%, transparent);
  }

  .shot[aria-busy='true'] {
    cursor: progress;
  }

</style>
