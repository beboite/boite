<script lang="ts">
  import { onMount } from 'svelte';
  import { Check, Download, FileText, X } from '@lucide/svelte';
  import type { MessagePart } from '@boite/contracts';
  import type { Store } from '../lib/store.svelte';
  import { experimentOn } from '../lib/experiments.svelte';
  import { fill, strings } from '../lib/strings';
  import { bytes } from '../lib/format';
  import { localFileDirectory, openLocalFile } from '../lib/local-files';
  import { browserDownload, decodeBase64, saveAttachment } from '../lib/attachment-save';
  import ImageViewer from './ImageViewer.svelte';

  let { file, store, threadId, path, line, onclose }: {
    file?: Extract<MessagePart, { type: 'file' }>; store?: Store; threadId?: string;
    path?: string; line?: number; onclose?: () => void;
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
  /** Where the shell saved the file, shown in place of its size. */
  let saved = $state('');
  let saving = $state(false);
  /** The attachment's decoded bytes, kept for the shell to save. */
  let body: Uint8Array<ArrayBuffer> | null = null;
  const directory = $derived(!file && path ? localFileDirectory(store, threadId) : null);
  const name = $derived(file?.name ?? path?.split('/').at(-1) ?? strings.composer.attachAlt);
  const rich = $derived(experimentOn('chat-artifacts'));
  const image = $derived(/^image\/(png|jpeg|gif|webp|avif|bmp)$/.test(mime));
  const pdf = $derived(mime === 'application/pdf');
  const audio = $derived(mime.startsWith('audio/'));
  const video = $derived(mime.startsWith('video/'));
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
      const data = body ?? new Uint8Array(await (await fetch(url)).arrayBuffer());
      saved = (await saveAttachment(name, data, andOpen))?.path ?? '';
      error = '';
    } catch (reason) { error = reason instanceof Error ? reason.message : String(reason); }
    finally { saving = false; }
    return true;
  }

  /** The name or the icon: take the file out and open it. */
  async function launch(): Promise<void> {
    if (directory) return open();
    if (!url) return;
    if (await save(true)) return;
    if (image) viewing = true;
    else if (file) browserDownload(url, name);
    else expanded = !expanded;
  }

  function download(event: MouseEvent): void {
    if (window.__TAURI_INTERNALS__ === undefined) return;
    event.preventDefault();
    void save(false);
  }

  onMount(() => {
    let disposed = false;
    let objectUrl = '';
    async function load() {
      loading = true;
      try {
        if (file) {
          body = decodeBase64(file.data);
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
    void load();
    return () => { disposed = true; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  });
</script>

<section class="chat-file" data-testid="chat-file">
  <div class="file-row">
    <button type="button" class="identity" onclick={launch} disabled={opening || saving || (!url && !directory)} title={saved || name}
      aria-label={fill(strings.chat.openFile, { name })} data-testid="artifact-launch">
      <FileText size={22} />
      <span class="label"><span>{name}</span>{#if !error}<small>{loading ? strings.artifacts.loading : saved ? strings.artifacts.saved : bytes(size)}</small>{/if}</span>
    </button>
    {#if directory}<button class="ghost small" type="button" onclick={open} disabled={opening} data-testid="artifact-open">{strings.artifacts.open}</button>{/if}
    {#if url}
      {#if rich && previewable}<button class="ghost small" type="button" onclick={() => expanded = !expanded} aria-expanded={expanded} data-testid="artifact-preview">{strings.artifacts.preview}</button>{/if}
      <a class="ghost small download" href={url} download={name} onclick={download} data-testid="artifact-download" aria-label={strings.artifacts.download} title={strings.artifacts.download}>{#if saved}<Check size={16} />{:else}<Download size={16} />{/if}</a>
    {/if}
    {#if onclose}<button class="ghost small icon" type="button" onclick={onclose} aria-label={strings.artifacts.close}><X size={16} /></button>{/if}
  </div>
  {#if error}<p role="alert">{error}</p>{/if}
  {#if expanded && rich && url}
    <div class="preview" data-testid="artifact-content">
      {#if text !== null}<pre>{#if line}<span class="line">{`${path}:${line}\n`}</span>{/if}{text}</pre>
      {:else if image}<button type="button" class="shot" onclick={() => viewing = true} title={strings.artifacts.enlarge} aria-label={strings.artifacts.enlarge} data-testid="artifact-enlarge"><img src={url} alt={name} /></button>
      {:else if pdf && file}
        <!-- Only a signature-checked application/pdf Blob reaches the built-in PDF viewer. Sandboxed frames disable that viewer. -->
        <iframe title={name} src={url} referrerpolicy="no-referrer"></iframe>
      {:else if video}<video src={url} controls preload="metadata"><track kind="captions" /></video>
      {:else if audio}<audio src={url} controls preload="metadata"></audio>
      {:else}<p>{directory ? strings.artifacts.openLocal : strings.artifacts.unavailable}</p>{/if}
    </div>
  {/if}
</section>
{#if viewing && url}<ImageViewer src={url} alt={name} onclose={() => viewing = false} />{/if}

<style>
  .chat-file { margin-block: 10px; border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-surface-2); overflow: hidden; }
  .file-row { display: flex; align-items: center; gap: 10px; padding: 12px; }
  .identity { flex: 1; min-width: 0; display: flex; align-items: center; gap: 10px; height: auto; margin: -6px; padding: 6px; border: 0; border-radius: var(--radius-sm); background: none; color: inherit; font: inherit; font-weight: 400; text-align: left; justify-content: flex-start; }
  .identity:hover:not(:disabled) { background: var(--color-hover); }
  .identity:disabled { cursor: default; opacity: 1; }
  .identity :global(svg) { flex: none; }
  .label { min-width: 0; display: flex; flex-direction: column; gap: 3px; overflow-wrap: anywhere; font-size: var(--text-sm); }
  .shot { display: block; width: 100%; height: auto; padding: 0; border: 0; border-radius: 0; background: none; cursor: zoom-in; }
  .shot:hover:not(:disabled) { background: none; }
  small, .line { color: var(--color-muted-foreground); font-size: var(--text-xs); }
  .download { display: inline-flex; align-items: center; justify-content: center; min-height: var(--control); }
  .preview { border-top: 1px solid var(--color-border); }
  p { margin: 12px; font-size: var(--text-sm); overflow-wrap: anywhere; }
  pre { margin: 0; padding: 12px; max-height: 420px; overflow: auto; font-family: var(--font-mono); font-size: var(--text-sm); }
  img, video { display: block; max-width: 100%; max-height: 420px; margin: auto; }
  audio { width: 100%; }
  iframe { display: block; width: 100%; height: 420px; border: 0; }
</style>
