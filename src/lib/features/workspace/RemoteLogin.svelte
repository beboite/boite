<script lang="ts">
  import { onMount } from "svelte";
  import {
    connectAndInitDetailed,
    defaultRemoteWsUrl,
    type ConnectAttempt,
  } from "$lib/app/workspace";
  import { device } from "$lib/features/settings/device.svelte";
  import { redeemPairing, takePairingTokenFromHash } from "./pairing";
  import { t } from "$lib/i18n/index.svelte";
  import BoiteLogo from "$lib/shared/components/BoiteLogo.svelte";

  // PWA / browser entry: there is no local backend, so the app gates here
  // until it can reach a boite-server. URL defaults to the last-saved boite,
  // else the serving origin.
  //
  // What is typed here is a *pairing token*, not a workspace secret. It is spent
  // once, in exchange for a credential this device alone holds, which is what
  // makes revoking one phone possible without touching any other device. A
  // device already holding a credential never sees this screen.
  let url = $state(device.active?.url || defaultRemoteWsUrl());
  let token = $state("");
  let busy = $state(false);
  // The outcome rather than a rendered message, so the text follows a locale
  // change instead of freezing whatever language was active when the attempt
  // failed. `detail` is the transport's own words and is shown as data.
  let attempt = $state<ConnectAttempt | null>(null);
  // A refusal from the pairing exchange, which happens before there is a
  // connection to have an outcome about.
  let pairError = $state("");

  let urlInput = $state<HTMLInputElement | null>(null);
  let tokenInput = $state<HTMLInputElement | null>(null);

  // A link scanned off a QR lands here with its token in the fragment. Read and
  // stripped on mount, before anything can put it in a history entry that
  // survives a reload, then spent straight away: making the user press a button
  // after following a link is a step with nothing in it.
  onMount(() => {
    const fromLink = takePairingTokenFromHash();
    if (fromLink) {
      token = fromLink;
      void submit();
      return;
    }
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

  async function submit(e?: Event) {
    e?.preventDefault();
    if (busy || !token.trim()) return;
    attempt = null;
    pairError = "";
    busy = true;
    try {
      // Two steps, and only the first one is spendable. The invitation buys a
      // credential; the credential is what is saved and what every later
      // connection uses.
      const paired = await redeemPairing(url.trim(), token.trim());
      token = "";
      const res = await connectAndInitDetailed(url.trim(), paired.credential);
      if (res.outcome !== "ok") attempt = res;
    } catch (err) {
      pairError = err instanceof Error ? err.message : String(err);
    } finally {
      busy = false;
    }
  }
</script>

<div class="flex h-full w-full items-center justify-center bg-[var(--color-background)] p-6">
  <form onsubmit={submit} class="flex w-full max-w-sm flex-col gap-4">
    <div class="mb-2 flex flex-col items-center gap-3">
      <span class="text-muted-2"><BoiteLogo size={48} /></span>
      <h1 class="text-sm text-muted-foreground">{t("workspace.loginTitle")}</h1>
    </div>

    <label class="flex flex-col gap-1 text-sm text-muted-foreground">
      {t("workspace.serverUrl")}
      <!-- type/inputmode url: this is the one screen where a phone user has to
           type a ws:// URL, and the stock keyboard has no slash or colon on its
           first layer. -->
      <input
        bind:this={urlInput}
        class="rounded-md border border-edge bg-[var(--color-surface)] px-3 py-2 font-mono text-sm text-foreground outline-none focus:border-[var(--color-success)]"
        type="url"
        inputmode="url"
        bind:value={url}
        placeholder="wss://host/ws"
        autocomplete="off"
        autocapitalize="off"
        spellcheck="false"
      />
    </label>

    <label class="flex flex-col gap-1 text-sm text-muted-foreground">
      {t("workspace.pairingToken")}
      <input
        bind:this={tokenInput}
        class="rounded-md border border-edge bg-[var(--color-surface)] px-3 py-2 text-sm text-foreground outline-none focus:border-[var(--color-success)]"
        type="password"
        bind:value={token}
        autocomplete="off"
      />
      <span class="text-sm text-muted-2">{t("workspace.pairingHint")}</span>
    </label>

    {#if pairError}
      <p class="text-sm text-danger">{pairError}</p>
    {:else if failMessage}
      <div class="flex flex-col gap-1">
        <p class="text-sm text-danger">{failMessage}</p>
        {#if attempt?.detail}
          <p class="text-sm text-muted-2">{attempt.detail}</p>
        {/if}
      </div>
    {/if}

    <button
      type="submit"
      disabled={busy || !token.trim()}
      class="rounded-md border border-edge bg-[var(--color-surface-2)] px-3 py-2 text-sm text-foreground transition hover:bg-[var(--color-surface-3)] disabled:opacity-50"
    >
      {busy ? t("workspace.connecting") : t("workspace.pairThisDevice")}
    </button>
  </form>
</div>
