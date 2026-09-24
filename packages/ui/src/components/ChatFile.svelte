<script lang="ts">
  import { onMount } from 'svelte';
  import { Download, FileText, X } from '@lucide/svelte';
  import type { MessagePart } from '@boite/contracts';
  import type { Store } from '../lib/store.svelte';
  import { experimentOn } from '../lib/experiments.svelte';
  import { strings } from '../lib/strings';
  import { bytes } from '../lib/format';

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
  const name = $derived(file?.name ?? path?.split('/').at(-1) ?? strings.composer.attachAlt);
  const rich = $derived(experimentOn('chat-artifacts'));
  const image = $derived(/^image\/(png|jpeg|gif|webp|avif|bmp)$/.test(mime));
  const pdf = $derived(mime === 'application/pdf');
  const audio = $derived(mime.startsWith('audio/'));
  const video = $derived(mime.startsWith('video/'));

  onMount(() => {
    let disposed = false;
    let objectUrl = '';
    async function load() {
      loading = true;
      try {
        if (file) {
          const body = Uint8Array.from(atob(file.data), c => c.charCodeAt(0));
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
    <FileText size={22} />
    <span class="identity"><span>{name}</span>{#if !error}<small>{loading ? strings.artifacts.loading : bytes(size)}</small>{/if}</span>
    {#if url}
      {#if rich}<button class="ghost small" type="button" onclick={() => expanded = !expanded} aria-expanded={expanded} data-testid="artifact-preview">{strings.artifacts.preview}</button>{/if}
      <a class="ghost small download" href={url} download={name} data-testid="artifact-download" aria-label={strings.artifacts.download}><Download size={16} /></a>
    {/if}
    {#if onclose}<button class="ghost small icon" type="button" onclick={onclose} aria-label={strings.artifacts.close}><X size={16} /></button>{/if}
  </div>
  {#if error}<p role="alert">{error}</p>{/if}
  {#if expanded && rich && url}
    <div class="preview" data-testid="artifact-content">
      {#if text !== null}<pre>{#if line}<span class="line">{`${path}:${line}\n`}</span>{/if}{text}</pre>
      {:else if image}<img src={url} alt={name} />
      {:else if pdf && file}
        <!-- Only a signature-checked application/pdf Blob reaches the built-in PDF viewer. Sandboxed frames disable that viewer. -->
        <iframe title={name} src={url} referrerpolicy="no-referrer"></iframe>
      {:else if video}<video src={url} controls preload="metadata"><track kind="captions" /></video>
      {:else if audio}<audio src={url} controls preload="metadata"></audio>
      {:else}<p>{strings.artifacts.unavailable}</p>{/if}
    </div>
  {/if}
</section>

<style>
  .chat-file { margin-block: 10px; border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-surface-2); overflow: hidden; }
  .file-row { display: flex; align-items: center; gap: 10px; padding: 12px; }
  .identity { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; overflow-wrap: anywhere; font-size: var(--text-sm); }
  small, .line { color: var(--color-muted-foreground); font-size: var(--text-xs); }
  .download { display: inline-flex; align-items: center; justify-content: center; min-height: var(--control); }
  .preview { border-top: 1px solid var(--color-border); }
  p { margin: 12px; font-size: var(--text-sm); overflow-wrap: anywhere; }
  pre { margin: 0; padding: 12px; max-height: 420px; overflow: auto; font-family: var(--font-mono); font-size: var(--text-sm); }
  img, video { display: block; max-width: 100%; max-height: 420px; margin: auto; }
  audio { width: 100%; }
  iframe { display: block; width: 100%; height: 420px; border: 0; }
</style>
