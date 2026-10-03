<script lang="ts">
  import { onMount } from 'svelte';
  import { Check, Download, FileText, Image, Film, Music2, Maximize2, RefreshCw, X } from '@lucide/svelte';
  import { ATTACHMENT_MAX_BYTES, FILE_TICKET_TTL_MS, type MessagePart } from '@boite/contracts';
  import type { Store } from '../lib/store.svelte';
  import { experimentOn } from '../lib/experiments.svelte';
  import { fill, strings } from '../lib/strings';
  import { bytes, millis } from '../lib/format';
  import { localFileDirectory, openLocalFile } from '../lib/local-files';
  import { browserDownload, decodeBase64, saveAttachment, saveAttachmentUrl } from '../lib/attachment-save';
  import ImageViewer from './ImageViewer.svelte';

  let { file, store, threadId, messageId, partIndex, path, line, onclose }: {
    file?: Extract<MessagePart, { type: 'file' | 'artifact' }>; store?: Store; threadId?: string; messageId?: string;
    partIndex?: number; path?: string; line?: number; onclose?: () => void;
  } = $props();
  let url = $state('');
  let mime = $state('');
  let text = $state<string | null>(null);
  let size = $state(0);
  let error = $state('');
  let loading = $state(false);
  let expanded = $state(false);
  let opening = $state(false);
  let viewing = $state(false);
  let imageRequested = $state(false);
  /** Where the shell saved the file, shown in place of its size. */
  let saved = $state('');
  let saving = $state(false);
  let previewError = $state(false);
  let dimensions = $state('');
  let duration = $state(0);
  let attempt = $state(0);
  let disposed = false;
  let objectUrl = '';
  /** The attachment's decoded bytes, kept for the shell to save. */
  let body: Uint8Array<ArrayBuffer> | null = null;
  const directory = $derived(!file && path ? localFileDirectory(store, threadId) : null);
  const name = $derived(file?.name ?? path?.split('/').at(-1) ?? strings.composer.attachAlt);
  const rich = $derived(experimentOn('chat-artifacts'));
  const image = $derived(/^image\/(png|jpeg|gif|webp|avif|bmp)$/.test(mime));
  const pdf = $derived(mime === 'application/pdf');
  const audio = $derived(mime.startsWith('audio/'));
  const video = $derived(mime.startsWith('video/'));
  const deferredImage = $derived(image && size > ATTACHMENT_MAX_BYTES && !imageRequested);
  const inlineMedia = $derived(!!file && ((image && !deferredImage) || video || audio));
  const showPreview = $derived(inlineMedia || (expanded && rich));
  const previewable = $derived(text !== null || image || (pdf && !!file) || audio || video);

  async function open(): Promise<void> {
    if (!directory || !path || opening) return;
    opening = true;
    try { await openLocalFile(directory, path); }
    catch (reason) { error = reason instanceof Error ? reason.message : String(reason); }
    finally { opening = false; }
  }

  /**
   * The shell writes the file into Downloads and, asked to, opens it: a picture
   * or a document in its viewer, anything that could run shown in its folder.
   * Returns false outside the shell, where the browser handles it.
   */
  async function save(andOpen: boolean): Promise<boolean> {
    if (window.__TAURI_INTERNALS__ === undefined) return false;
    if (saving) return true;
    saving = true;
    try {
      if (file?.type === 'artifact') await loadArtifact();
      saved = (body ? await saveAttachment(name, body, andOpen) : await saveAttachmentUrl(name, url, andOpen))?.path ?? '';
      error = '';
    } catch (reason) { error = reason instanceof Error ? reason.message : String(reason); }
    finally { saving = false; }
    return true;
  }

  /** The name or the icon: take the file out and open it. */
  async function launch(): Promise<void> {
    if (directory && !image) return open();
    if (file?.type === 'file' && file.dataDeferred) await load();
    if (!url) return;
    if (image) { imageRequested = true; viewing = true; return; }
    if (await save(true)) return;
    if (file) {
      if (file.type === 'artifact') await loadArtifact();
      browserDownload(url, name);
    }
    else expanded = !expanded;
  }

  function download(event: MouseEvent): void {
    if (loading || saving) { event.preventDefault(); return; }
    if (file?.type === 'file' && file.dataDeferred) {
      event.preventDefault();
      void load().then(async () => { if (!disposed && url && !(await save(false))) browserDownload(url, name); });
      return;
    }
    if (window.__TAURI_INTERNALS__ === undefined) {
      if (file?.type === 'artifact') {
        event.preventDefault();
        void loadArtifact().then(() => browserDownload(url, name)).catch(reason => error = String(reason));
      }
      return;
    }
    event.preventDefault();
    void save(false);
  }

  async function loadArtifact(): Promise<void> {
    if (file?.type !== 'artifact' || !store || !threadId || !messageId) throw new Error(strings.artifacts.failed);
    const result = await store.readArtifact(threadId, messageId, file.id, url.split('/file/')[1]);
    if (disposed) return;
    if (!result.ok) throw new Error(result.error);
    url = result.value.url;
    mime = result.value.mimeType;
    size = result.value.bytes;
  }

  async function load() {
      loading = true;
      error = ''; previewError = false; attempt++;
      if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = ''; }
      if (file?.type === 'file') { url = ''; body = null; }
      try {
        if (file?.type === 'artifact') {
          await loadArtifact();
        } else if (file) {
          if (file.dataDeferred && (!store || !threadId || !messageId || partIndex === undefined)) throw new Error(strings.artifacts.failed);
          const data = file.dataDeferred ? await store!.loadMessageAttachment(threadId!, messageId!, partIndex!) : file.data;
          if (disposed) return;
          body = decodeBase64(data);
          mime = file.mimeType;
          if (mime === 'application/pdf' && new TextDecoder().decode(body.subarray(0, 5)) !== '%PDF-') mime = 'application/octet-stream';
          size = body.length;
          // Only inert media gets an inline URL. Other content is download-only.
          objectUrl = URL.createObjectURL(new Blob([body], { type: mime }));
          url = objectUrl;
        } else if (path && store && threadId) {
          if (!store.owner) throw new Error(strings.artifacts.ownerOnly);
          const result = await store.readFile(threadId, path);
          if (disposed) return;
          if (!result.ok) throw new Error(result.error);
          const content = result.value;
          size = content.bytes;
          if (content.kind === 'text') {
            text = content.text;
            objectUrl = URL.createObjectURL(new Blob([content.text], { type: 'text/plain' }));
            url = objectUrl;
          } else { url = content.url; mime = content.mime; }
          expanded = true;
        } else throw new Error(strings.artifacts.ownerOnly);
      } catch (reason) { if (!disposed) error = reason instanceof Error ? reason.message : strings.artifacts.failed; }
      finally { if (!disposed) loading = false; }
  }

  function imageLoaded(event: Event) {
    const element = event.currentTarget as HTMLImageElement;
    dimensions = `${element.naturalWidth} × ${element.naturalHeight}`;
  }

  function mediaLoaded(event: Event) {
    const element = event.currentTarget as HTMLMediaElement;
    duration = Number.isFinite(element.duration) ? element.duration : 0;
    if (element instanceof HTMLVideoElement) dimensions = `${element.videoWidth} × ${element.videoHeight}`;
  }

  onMount(() => {
    if (file?.type === 'file' && file.dataDeferred) { mime = file.mimeType; size = file.bytes ?? 0; }
    else void load();
    const renewal = file?.type === 'artifact' ? setInterval(() => {
      void loadArtifact().catch(() => {}); // A transient disconnect can retry on the next interval.
    }, FILE_TICKET_TTL_MS / 2) : null;
    const resume = () => { if (file?.type === 'artifact' && !document.hidden) void loadArtifact().catch(() => {}); };
    document.addEventListener('visibilitychange', resume);
    return () => { disposed = true; document.removeEventListener('visibilitychange', resume); if (renewal) clearInterval(renewal); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  });
</script>

<section class="chat-file" class:inline-media={inlineMedia} data-testid="chat-file" aria-busy={loading || saving}>
  {#if showPreview && url}
    <div class="preview" data-testid="artifact-content">
      {#if previewError}
        <div class="media-fallback" role="status"><FileText size={28} /><p>{strings.artifacts.mediaFailed}</p><button type="button" class="ghost small" onclick={load}><RefreshCw size={14} />{strings.artifacts.retry}</button></div>
      {:else}
        {#key attempt}
          {#if text !== null}<pre>{#if line}<span class="line">{`${path}:${line}\n`}</span>{/if}{text}</pre>
          {:else if image}<button type="button" class="shot" onclick={() => viewing = true} title={strings.artifacts.enlarge} aria-label={strings.artifacts.enlarge} data-testid="artifact-enlarge"><img src={url} alt={name} loading="lazy" decoding="async" onload={imageLoaded} onerror={() => previewError = true} /><span class="enlarge"><Maximize2 size={16} /></span></button>
          {:else if pdf && file}
            <!-- Only signature-checked PDF content reaches the built-in viewer. -->
            <iframe title={name} src={url} referrerpolicy="no-referrer"></iframe>
          {:else if video}<video src={url} aria-label={name} controls playsinline preload="metadata" onloadedmetadata={mediaLoaded} onerror={() => previewError = true}><track kind="captions" /></video>
          {:else if audio}<audio src={url} aria-label={name} controls preload="metadata" onloadedmetadata={mediaLoaded} onerror={() => previewError = true}></audio>
          {:else}<p>{directory ? strings.artifacts.openLocal : strings.artifacts.unavailable}</p>{/if}
        {/key}
      {/if}
    </div>
  {/if}
  <div class="file-row">
    <button type="button" class="identity" onclick={launch} disabled={opening || saving || loading || (!url && !directory && !(file?.type === 'file' && file.dataDeferred))} title={saved || name}
      aria-label={fill(strings.chat.openFile, { name })} data-testid="artifact-launch">
      {#if image}<Image size={18} />{:else if video}<Film size={18} />{:else if audio}<Music2 size={18} />{:else}<FileText size={20} />{/if}
      <span class="label"><span class="filename">{name}</span><small>{loading ? strings.artifacts.loading : saving ? strings.artifacts.saving : saved ? strings.artifacts.saved : [bytes(size), dimensions, duration ? millis(duration * 1000) : ''].filter(Boolean).join(' · ')}</small></span>
    </button>
    {#if directory}<button class="ghost small" type="button" onclick={open} disabled={opening} data-testid="artifact-open">{strings.artifacts.open}</button>{/if}
    {#if url || (file?.type === 'file' && file.dataDeferred)}
      {#if deferredImage}<button class="ghost small" type="button" onclick={() => imageRequested = true} data-testid="artifact-load-image">{strings.artifacts.loadImage}</button>
      {:else if rich && previewable && !inlineMedia}<button class="ghost small" type="button" onclick={() => expanded = !expanded} aria-expanded={expanded} data-testid="artifact-preview">{strings.artifacts.preview}</button>{/if}
      <a class="ghost small download" href={url || '#'} download={name} onclick={download} data-testid="artifact-download" aria-label={strings.artifacts.download} aria-disabled={saving || loading} title={strings.artifacts.download}>{#if saved}<Check size={16} />{:else}<Download size={16} />{/if}</a>
    {/if}
    {#if onclose}<button class="ghost small icon" type="button" onclick={onclose} aria-label={strings.artifacts.close}><X size={16} /></button>{/if}
  </div>
  {#if error}<div class="error" role="alert"><p>{error}</p><button type="button" class="ghost small" onclick={load} disabled={loading}>{strings.artifacts.retry}</button></div>{/if}
</section>
{#if viewing && url}<ImageViewer src={url} alt={name} ondownload={() => { if (window.__TAURI_INTERNALS__ === undefined) browserDownload(url, name); else void save(false); }} onclose={() => viewing = false} />{/if}

<style>
  .chat-file { margin-block: 10px; max-width: 100%; min-width: 0; border: 1px solid var(--color-border); border-radius: var(--radius-lg); background: var(--color-surface); overflow: hidden; display: flex; flex-direction: column; }
  .inline-media { width: fit-content; min-width: min(240px, 100%); max-width: min(560px, 100%); }
  .file-row { display: flex; align-items: center; gap: 10px; padding: 10px 12px; min-width: 0; order: 0; }
  .inline-media .file-row { order: 1; }
  .identity { flex: 1; min-width: 0; display: flex; align-items: center; gap: 10px; height: auto; margin: -6px; padding: 6px; border: 0; border-radius: var(--radius-sm); background: none; color: inherit; font: inherit; font-weight: 400; text-align: left; justify-content: flex-start; }
  .identity:hover:not(:disabled) { background: var(--color-hover); }
  .identity:disabled { cursor: default; opacity: 1; }
  .identity :global(svg) { flex: none; }
  .label { min-width: 0; display: flex; flex-direction: column; gap: 2px; font-size: var(--text-sm); }
  .filename { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .shot { position: relative; display: block; width: 100%; height: auto; padding: 0; border: 0; border-radius: 0; background: none; cursor: zoom-in; }
  .shot:hover:not(:disabled) { background: none; }
  .enlarge { position: absolute; right: 10px; top: 10px; display: grid; place-items: center; width: 30px; height: 30px; border-radius: var(--radius-sm); background: var(--color-surface); box-shadow: var(--shadow-e1); opacity: 0; transition: opacity var(--dur-1); }
  .shot:hover .enlarge, .shot:focus-visible .enlarge { opacity: 1; }
  small, .line { color: var(--color-muted-foreground); font-size: var(--text-xs); }
  .download { display: inline-flex; align-items: center; justify-content: center; min-height: var(--control); }
  .preview { order: 1; border-top: 1px solid var(--color-border); background: var(--color-surface-2); }
  .inline-media .preview { order: 0; border-top: 0; border-bottom: 1px solid var(--color-border); }
  .media-fallback { min-height: 150px; max-width: 360px; display: flex; align-items: center; justify-content: center; flex-direction: column; padding: 20px; text-align: center; color: var(--color-muted-foreground); }
  .error { order: 2; padding: 0 12px 10px; }
  p { margin: 12px; font-size: var(--text-sm); overflow-wrap: anywhere; }
  pre { margin: 0; padding: 12px; max-height: 420px; overflow: auto; font-family: var(--font-mono); font-size: var(--text-sm); }
  img, video { display: block; width: auto; height: auto; max-width: 100%; max-height: min(480px, 65vh); margin: auto; object-fit: contain; }
  img { min-height: 80px; }
  video { min-width: min(320px, 100%); }
  audio { width: 100%; }
  iframe { display: block; width: 100%; height: 420px; border: 0; }
  @media (hover: none) { .enlarge { opacity: 1; } }
  @media (max-width: 720px) { .inline-media { max-width: 100%; } .file-row { padding: 8px 10px; gap: 6px; } .download { min-width: 40px; min-height: 40px; } }
</style>
