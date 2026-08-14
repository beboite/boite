<script lang="ts">
  import { openUrl } from "$lib/platform/opener";
  import { isLocalPage } from "./url";
  import { browserPanes } from "./state.svelte";
  import { paneDriver } from "./driver";
  import { app } from "$lib/app/store.svelte";
  import { paneStore } from "$lib/features/panes/store.svelte";
  import { t } from "$lib/i18n/index.svelte";
  import RotateCw from "@lucide/svelte/icons/rotate-cw";
  import ExternalLink from "@lucide/svelte/icons/external-link";
  import Bot from "@lucide/svelte/icons/bot";
  import Hand from "@lucide/svelte/icons/hand";

  /**
   * A page, in a pane.
   *
   * The point is not browsing. It is that the thing an agent is talking about —
   * the dev server it just started, the docs page it is quoting, the PR it
   * opened — can sit next to the terminal saying it, instead of pulling the user
   * out of the window.
   *
   * An iframe, and it is worth being honest about the ceiling: a site that sends
   * `X-Frame-Options: DENY` or a restrictive `frame-ancestors` will refuse to
   * load, and there is nothing this component can do about it from inside the
   * page. localhost dev servers, which is the case this exists for, almost never
   * send either.
   *
   * **The frame is cross-origin in every case the app allows** —
   * `boite_core::browser::classify` refuses Boite's own origin outright — so
   * nothing in THIS document can read the page, find an element in it or click
   * one. What can is the driver the webview itself injects into every frame
   * (`src-tauri/scripts/pane-driver.js`, an initialization script: below the
   * page's origin machinery rather than across it). This component only hands
   * the frame element to `driver.ts`, which talks to that script over
   * postMessage — the sandbox and the origin boundary stay exactly as they
   * were. Desktop only by construction: a pane drawn by a plain browser or a
   * phone has no injected script, and the agent tools say so.
   */
  type Props = { url: string; paneId: string; drivenBy?: string | null };
  let { url, paneId, drivenBy = null }: Props = $props();

  /**
   * `allow-same-origin`, and who gets it.
   *
   * The address was chosen by an agent, not typed by the user, so the sandbox
   * is the difference between showing a page and running it. Kept for a dev
   * server on this machine, which is the user's own code and needs its own
   * storage and cookies to be worth looking at; dropped for everything else,
   * which then loads into an opaque origin with no storage to read, no cookies
   * to send and nothing of the app's to reach back through.
   *
   * It never makes the frame same-origin with *Boite*. That would need the
   * frame to be on the app's own origin, which is the one address `classify`
   * exists to refuse.
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

  // An agent asks for a reload from outside this component, so the count that
  // remounts the frame is held beside the pane rather than in here.
  const nonce = $derived(browserPanes.nonceOf(paneId));
  const driver = $derived(drivenBy ? app.threadById(drivenBy) : null);

  // The frame element, for the pane driver: questions about the page go in
  // through its contentWindow and answers are matched back against it. Handed
  // over whenever a (re)mount produces a new element, taken back on unmount.
  let frame = $state<HTMLIFrameElement | null>(null);
  $effect(() => {
    if (!frame) return;
    paneDriver.attach(paneId, frame);
    return () => paneDriver.detach(paneId);
  });

  $effect(() => {
    // Re-arm on every navigation and every manual reload.
    void url;
    void nonce;
    settled = false;
    stalled = false;
    browserPanes.note(paneId, "loading");
    const timer = setTimeout(() => {
      if (!settled) {
        stalled = true;
        browserPanes.note(paneId, "stalled");
      }
    }, 4000);
    return () => clearTimeout(timer);
  });

  $effect(() => () => browserPanes.forget(paneId));

  function loaded() {
    settled = true;
    browserPanes.note(paneId, "loaded");
  }

  /**
   * The user taking the pane back.
   *
   * Clearing the mark is the whole mechanism: the endpoint reads it off the
   * window's description and refuses, and `agent-requests.ts` checks it again on
   * the device. Not undoable from the agent's side on purpose — a hand-back an
   * agent can reverse is not a hand-back.
   */
  function reclaim() {
    paneStore.setBrowser(paneId, { drivenBy: null });
  }
</script>

<div class="flex h-full min-h-0 flex-col bg-[var(--color-surface)]">
  <div
    class="flex h-7 shrink-0 items-center gap-1.5 border-b border-border px-2"
  >
    {#if drivenBy}
      <!-- A pane an agent is steering with no visible sign is the wrong
           product, so the mark sits before the address rather than after it. -->
      <span
        class="flex shrink-0 items-center gap-1 rounded-xs bg-[var(--color-surface-2)] px-1 py-0.5 text-2xs text-muted-foreground"
        title={t("browser.drivenByTitle", { agent: driver?.label ?? drivenBy })}
      >
        <Bot class="size-3" />
        {driver?.label ?? t("browser.drivenByAgent")}
      </span>
    {/if}
    <span
      class="min-w-0 flex-1 truncate text-2xs text-muted-foreground"
      title={url}
    >
      {url}
    </span>
    {#if drivenBy}
      <button
        type="button"
        class="rounded-xs p-1 text-muted-foreground transition hover:bg-[var(--color-surface-2)] hover:text-foreground"
        onclick={reclaim}
        title={t("browser.reclaim")}
        aria-label={t("browser.reclaim")}
      >
        <Hand class="size-3" />
      </button>
    {/if}
    <button
      type="button"
      class="rounded-xs p-1 text-muted-foreground transition hover:bg-[var(--color-surface-2)] hover:text-foreground"
      onclick={() => browserPanes.reload(paneId)}
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
        onload={loaded}
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
