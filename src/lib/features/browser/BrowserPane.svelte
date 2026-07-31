<script lang="ts">
  import { openUrl } from "$lib/platform/opener";
  import { isLocalPage } from "./url";
  import { t } from "$lib/i18n/index.svelte";
  import RotateCw from "@lucide/svelte/icons/rotate-cw";
  import ExternalLink from "@lucide/svelte/icons/external-link";

  /**
   * A page, in a pane.
   *
   * The point is not browsing. It is that the thing an agent is talking about —
   * the dev server it just started, the docs page it is quoting, the PR it
   * opened — can sit next to the terminal saying it, instead of pulling the user
   * out of the window.
   *
   * An iframe, for now, and it is worth being honest about the ceiling: a site
   * that sends `X-Frame-Options: DENY` or a restrictive `frame-ancestors` will
   * refuse to load, and there is nothing this component can do about it from
   * inside the page. localhost dev servers, which is the case this exists for,
   * almost never send either. The upgrade is a Tauri child webview positioned
   * over the pane rect, exactly as the terminals already are; that also unlocks
   * driving it, which is what the agent side needs.
   */
  type Props = { url: string };
  let { url }: Props = $props();

  let frame = $state<HTMLIFrameElement | null>(null);
  let nonce = $state(0);

  /**
   * `allow-same-origin`, and who gets it.
   *
   * The address was chosen by an agent, not typed by the user, so the sandbox
   * is the difference between showing a page and running it. Kept for a dev
   * server on this machine, which is the user's own code and needs its own
   * storage and cookies to be worth looking at; dropped for everything else,
   * which then loads into an opaque origin with no storage to read, no cookies
   * to send and nothing of the app's to reach back through.
   */
  const sandbox = $derived(
    isLocalPage(url)
      ? "allow-scripts allow-same-origin allow-forms allow-popups"
      : "allow-scripts allow-forms allow-popups",
  );
  // A frame that never fires `load` is either slow or refused, and the two are
  // indistinguishable from here — the error is delivered to the console of a
  // document we are not allowed to touch. So the notice is offered rather than
  // asserted, and only once enough time has passed to rule out slow.
  let settled = $state(false);
  let stalled = $state(false);

  $effect(() => {
    // Re-arm on every navigation and every manual reload.
    void url;
    void nonce;
    settled = false;
    stalled = false;
    const timer = setTimeout(() => {
      if (!settled) stalled = true;
    }, 4000);
    return () => clearTimeout(timer);
  });

  function reload() {
    nonce += 1;
  }
</script>

<div class="flex h-full min-h-0 flex-col bg-[var(--color-surface)]">
  <div
    class="flex h-7 shrink-0 items-center gap-1.5 border-b border-border px-2"
  >
    <span
      class="min-w-0 flex-1 truncate font-mono text-2xs text-muted-foreground"
      title={url}
    >
      {url}
    </span>
    <button
      type="button"
      class="rounded-xs p-1 text-muted-foreground transition hover:bg-[var(--color-surface-2)] hover:text-foreground"
      onclick={reload}
      title={t("browser.reload")}
      aria-label={t("browser.reload")}
    >
      <RotateCw class="size-3" />
    </button>
    <button
      type="button"
      class="rounded-xs p-1 text-muted-foreground transition hover:bg-[var(--color-surface-2)] hover:text-foreground"
      onclick={() => void openUrl(url)}
      title={t("browser.openExternal")}
      aria-label={t("browser.openExternal")}
    >
      <ExternalLink class="size-3" />
    </button>
  </div>

  <div class="relative min-h-0 flex-1">
    {#key nonce}
      <iframe
        bind:this={frame}
        src={url}
        title={url}
        class="size-full border-0 bg-white"
        onload={() => (settled = true)}
        referrerpolicy="no-referrer"
        {sandbox}
      ></iframe>
    {/key}

    {#if stalled && !settled}
      <div
        class="pointer-events-none absolute inset-x-0 bottom-0 border-t border-border bg-[var(--color-surface)] px-3 py-2 text-2xs text-muted-foreground"
      >
        {t("browser.mayRefuse")}
      </div>
    {/if}
  </div>
</div>
