<script lang="ts">
  import { onDestroy, untrack } from "svelte";
  import { tip } from "$lib/shared/actions/tooltip";
  import { logger } from "$lib/shared/services/logger.svelte";
  import { t } from "$lib/i18n/index.svelte";
  import ZoomIn from "@lucide/svelte/icons/zoom-in";
  import ZoomOut from "@lucide/svelte/icons/zoom-out";

  /**
   * A PDF, drawn page by page onto canvases.
   *
   * pdf.js rather than handing the file to the webview: the app owns the size,
   * the theme and the zoom, the same code runs on every platform, and the bytes
   * never have to become a URL — which is what a boite would need to serve one
   * day. It is also what every editor with a PDF tab does.
   *
   * Loaded through a dynamic import so its ~1 MB stays out of the entry bundle
   * for the sessions that never open a PDF.
   *
   * Note for anyone debugging this from outside the window: pdf.js drives its
   * render loop with `requestAnimationFrame`, which a backgrounded window does
   * not run. A page that stays blank under an automated probe is very probably
   * that, not this.
   */
  type Props = { bytes: Uint8Array; name: string };
  let { bytes, name }: Props = $props();

  let host: HTMLDivElement | null = $state(null);
  let pageCount = $state(0);
  let error = $state<string | null>(null);
  let scale = $state(1.2);
  /**
   * The loading task, not the document.
   *
   * `destroy()` lives on the task — the document proxy has no such method, and
   * calling it there threw on every zoom. Holding the task is also what frees
   * the worker rather than just the parsed pages.
   */
  let task: { destroy: () => Promise<void> } | null = null;

  const MIN_SCALE = 0.5;
  const MAX_SCALE = 4;

  function zoom(by: number) {
    scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.round((scale + by) * 10) / 10));
  }

  /**
   * Which render is the current one.
   *
   * A zoom while a long document is still drawing leaves two loops appending to
   * the same container, interleaving pages from two scales. The token lets the
   * older one notice it has been replaced and stop, and it is also why the state
   * writes below are untracked — the effect that starts a render reads this
   * component's own state, and writing it from inside would restart the run.
   */
  let renderToken = 0;

  async function render() {
    if (!host) return;
    const target = host;
    const token = ++renderToken;
    target.replaceChildren();
    try {
      const pdfjs = await import("pdfjs-dist");
      // The worker is bundled and served from the app's own origin, which is
      // what `script-src 'self'` and `worker-src 'self' blob:` allow. A CDN
      // default — pdf.js ships one — would be blocked, and silently: the promise
      // just never settles.
      const workerUrl = (await import("pdfjs-dist/build/pdf.worker.mjs?url")).default;
      pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
      // A copy, because pdf.js takes ownership of the buffer it is handed and
      // detaches it — re-rendering at another zoom would then read zero bytes.
      const loading = pdfjs.getDocument({ data: bytes.slice() });
      const loaded = await loading.promise;
      if (token !== renderToken) {
        void loading.destroy();
        return;
      }
      void task?.destroy();
      task = loading;
      untrack(() => (pageCount = loaded.numPages));
      const dpr = window.devicePixelRatio || 1;
      for (let n = 1; n <= loaded.numPages; n++) {
        if (token !== renderToken) return;
        const page = await loaded.getPage(n);
        const viewport = page.getViewport({ scale });
        const canvas = document.createElement("canvas");
        canvas.width = Math.floor(viewport.width * dpr);
        canvas.height = Math.floor(viewport.height * dpr);
        canvas.style.width = `${Math.floor(viewport.width)}px`;
        canvas.style.height = `${Math.floor(viewport.height)}px`;
        canvas.className = "page";
        const ctx = canvas.getContext("2d");
        if (!ctx) continue;
        target.append(canvas);
        // The device-pixel ratio goes in as pdf.js's own `transform` rather than
        // a `ctx.scale` before the call: pdf.js sets the context transform from
        // the viewport, so a scale applied beforehand is not what ends up
        // composing with it.
        await page.render({
          canvas,
          canvasContext: ctx,
          viewport,
          transform: dpr === 1 ? undefined : [dpr, 0, 0, dpr, 0, 0],
        }).promise;
      }
      if (token === renderToken) untrack(() => (error = null));
    } catch (err) {
      logger.warn("editor", `pdf render failed for ${name}`, String(err));
      if (token === renderToken) untrack(() => (error = String(err)));
    }
  }

  // Re-runs on zoom: the pages are raster, so a new scale is a new render rather
  // than a CSS transform, which would be a blurry enlargement of the old one.
  $effect(() => {
    void bytes;
    void scale;
    void render();
  });

  onDestroy(() => {
    renderToken++;
    void task?.destroy();
  });
</script>

<div class="flex h-full min-h-0 flex-col">
  <div
    class="flex h-7 shrink-0 items-center gap-2 border-b border-border bg-[var(--color-titlebar)] px-3 text-xs text-muted-foreground"
  >
    <span>{t("editor.pdfPages", { count: pageCount })}</span>
    <span class="ml-auto tabular-nums">{Math.round(scale * 100)}%</span>
    <button
      type="button"
      class="rounded p-1 transition hover:bg-[var(--color-surface-2)] hover:text-foreground"
      onclick={() => zoom(-0.2)}
      aria-label={t("editor.zoomOut")}
      use:tip={t("editor.zoomOut")}
    >
      <ZoomOut class="size-3.5" />
    </button>
    <button
      type="button"
      class="rounded p-1 transition hover:bg-[var(--color-surface-2)] hover:text-foreground"
      onclick={() => zoom(0.2)}
      aria-label={t("editor.zoomIn")}
      use:tip={t("editor.zoomIn")}
    >
      <ZoomIn class="size-3.5" />
    </button>
  </div>

  {#if error}
    <div class="flex flex-1 items-center justify-center px-4 text-center text-sm text-[var(--color-danger)]">
      {error}
    </div>
  {:else}
    <div bind:this={host} class="pages min-h-0 flex-1 overflow-auto p-4"></div>
  {/if}
</div>

<style>
  .pages {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 12px;
    background: var(--color-background);
  }
  /* A page is white paper whatever the app's theme is, and the shadow is what
     separates two of them in a scroll. */
  .pages :global(.page) {
    background: white;
    box-shadow: var(--shadow-e2);
    max-width: 100%;
  }
</style>
