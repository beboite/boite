<script lang="ts">
  import { onMount } from "svelte";
  import {
    connectAndInitDetailed,
    defaultRemoteWsUrl,
    type ConnectAttempt,
  } from "$lib/app/workspace";
  import { device } from "$lib/features/settings/device.svelte";
  import { t } from "$lib/i18n/index.svelte";
  import BoiteLogo from "$lib/shared/components/BoiteLogo.svelte";

  // PWA / browser entry: there is no local backend, so the app gates here
  // until it can reach a boite-server. URL defaults to the last-saved boite,
  // else the serving origin.
  let url = $state(device.active?.url || defaultRemoteWsUrl());
  let token = $state(device.active?.token || "");
  let busy = $state(false);
  // The outcome rather than a rendered message, so the text follows a locale
  // change instead of freezing whatever language was active when the attempt
  // failed. `detail` is the transport's own words and is shown as data.
  let attempt = $state<ConnectAttempt | null>(null);

  let urlInput = $state<HTMLInputElement | null>(null);
  let tokenInput = $state<HTMLInputElement | null>(null);

  // This is the whole app in a browser, so something has to hold the caret. The
  // token is the field that is usually empty; the URL comes prefilled from the
  // serving origin or the last boite.
  onMount(() => {
    (url && !token ? tokenInput : urlInput)?.focus();
  });

  // Auth rejection, a hostname that does not resolve, a TLS handshake the browser
  // refused and the connect timeout used to read as one sentence about the token,
  // which sent people editing a credential that was never the problem. Only the
  // first is about the token; the rest mean nothing answered, and the detail line
  // below carries which of them it was in the transport's own words.
  const failMessage = $derived.by(() => {
    if (!attempt || attempt.outcome === "ok") return "";
    // A literal key per branch: the outcome already tells the four apart, and
    // each one sends the user somewhere different. Borrowing the banner's line
    // for all three non-auth cases told them "it did not answer" when the real
    // answer was "that address cannot work".
    if (attempt.outcome === "auth") return t("workspace.loginFailed");
    if (attempt.outcome === "url") return t("workspace.loginBadUrl");
    if (attempt.outcome === "timeout") return t("workspace.loginTimeout");
    return t("workspace.loginUnreachable");
  });

  async function submit(e: Event) {
    e.preventDefault();
    if (busy || !token.trim()) return;
    attempt = null;
    busy = true;
    const res = await connectAndInitDetailed(url.trim(), token.trim());
    busy = false;
    if (res.outcome !== "ok") attempt = res;
  }
</script>

<div class="flex h-full w-full items-center justify-center bg-[var(--color-background)] p-6">
  <form onsubmit={submit} class="flex w-full max-w-sm flex-col gap-4">
    <div class="mb-2 flex flex-col items-center gap-3">
      <span class="text-muted-foreground/60"><BoiteLogo size={48} /></span>
      <h1 class="text-sm text-muted-foreground">{t("workspace.loginTitle")}</h1>
    </div>

    <label class="flex flex-col gap-1 text-xs text-muted-foreground">
      {t("workspace.serverUrl")}
      <!-- type/inputmode url: this is the one screen where a phone user has to
           type a ws:// URL, and the stock keyboard has no slash or colon on its
           first layer. -->
      <input
        bind:this={urlInput}
        class="rounded-md border border-border bg-[var(--color-surface)] px-3 py-2 font-mono text-sm text-foreground outline-none focus:border-[var(--color-success)]"
        type="url"
        inputmode="url"
        bind:value={url}
        placeholder="wss://host/ws"
        autocomplete="off"
        autocapitalize="off"
        spellcheck="false"
      />
    </label>

    <label class="flex flex-col gap-1 text-xs text-muted-foreground">
      {t("workspace.token")}
      <input
        bind:this={tokenInput}
        class="rounded-md border border-border bg-[var(--color-surface)] px-3 py-2 text-sm text-foreground outline-none focus:border-[var(--color-success)]"
        type="password"
        bind:value={token}
        autocomplete="off"
      />
    </label>

    {#if failMessage}
      <div class="flex flex-col gap-1">
        <p class="text-xs text-danger">{failMessage}</p>
        {#if attempt?.detail}
          <p class="text-xs text-muted-foreground/70">{attempt.detail}</p>
        {/if}
      </div>
    {/if}

    <button
      type="submit"
      disabled={busy || !token.trim()}
      class="rounded-md border border-border bg-[var(--color-surface-2)] px-3 py-2 text-sm text-foreground transition hover:bg-[var(--color-surface-3)] disabled:opacity-50"
    >
      {busy ? t("workspace.connecting") : t("workspace.connect")}
    </button>
  </form>
</div>
