<script lang="ts">
  import { workspace } from "$lib/backend";
  import { app } from "$lib/app/store.svelte";
  import { retryConnection } from "$lib/app/workspace";
  import { device } from "$lib/features/settings/device.svelte";
  import { settings } from "$lib/features/settings/store.svelte";
  import { t } from "$lib/i18n/index.svelte";

  // A dropped boite used to be signalled by a 1.5px pulsing outline and nothing
  // else, and only in pure remote mode: in dynamic mode the outline resolved to no
  // class at all, so a dead boite looked exactly like a healthy one. Meanwhile
  // every keystroke typed at a remote terminal is thrown away while the socket is
  // down, because replaying it into a live agent minutes later would be worse.
  // Something has to say so, and offer the way back.
  const mobile = $derived(settings.state.mobileLayout);

  let retrying = $state(false);

  // In dynamic mode the boite is one source of two, and the other one is fine.
  // A banner over the whole window then reports an outage the app is not having,
  // so it waits until the boite is what the user is actually working in: a
  // remote thread in the pane, or an imported project selected. The rest of the
  // time the sidebar ring and the pane ring carry it, and they say it where the
  // thing that is unreachable is. Pure remote mode has no such elsewhere: the
  // banner is unconditional there.
  const concernsScreen = $derived.by(() => {
    if (!workspace.isDynamic) return true;
    if (app.activeThread?.origin === "remote") return true;
    return app.projectById(app.currentProjectId)?.origin === "remote";
  });

  // Both modes that have a boite in play, not just pure remote. The login screen
  // carries its own message, so the banner stays out of its way.
  const visible = $derived(
    workspace.hasRemote &&
      !workspace.needsLogin &&
      workspace.connection !== "connected" &&
      concernsScreen,
  );

  const activeEntry = $derived(
    workspace.activeBoiteId ? device.getBoite(workspace.activeBoiteId) : null,
  );

  function hostOf(url: string): string {
    if (!url) return "";
    try {
      return new URL(url).host;
    } catch {
      return url;
    }
  }

  // Which boite is being waited on. The cached name survives a boite that has
  // never answered on this socket, which is exactly the case that needs naming.
  const name = $derived(
    workspace.info.name ||
      activeEntry?.name ||
      hostOf(activeEntry?.url ?? workspace.remoteUrl ?? "") ||
      t("workspace.remote"),
  );

  // Four states worth telling apart. A dial in flight is not a failure. A link
  // that answered once and went away is a loss, and what was typed since is gone
  // with it. One that never answered at all is a boite that may simply be asleep,
  // and saying "lost" about it would be a lie.
  //
  // `refused` is the fourth and was the missing one. A revoked or rotated token
  // is the only failure the boite itself decides, the only one waiting cannot
  // fix, and the only one that had nothing anywhere asking for a new credential:
  // the socket stops its backoff loop the moment it is refused, so the banner was
  // offering to keep trying something that had already given up, under a sentence
  // guessing the machine might be asleep.
  type LinkState = "reconnecting" | "lost" | "unreached" | "refused";
  const link = $derived.by<LinkState>(() => {
    // Read first and deliberately. `authRejected` is a plain field on the socket
    // and cannot be depended on; the connection state is the rune, and the socket
    // sets the flag before the close that publishes "disconnected", so this
    // recomputes at the right moment without either of them being reactive.
    const state = workspace.connection;
    if (workspace.remoteBackend?.authRejected) return "refused";
    if (state === "connecting") return "reconnecting";
    return workspace.linkEstablished ? "lost" : "unreached";
  });

  // A retry dials the same token, and that token is the thing the boite refused.
  // Nothing to shorten mid-dial either: the socket is already doing what the
  // button asks for.
  const canRetry = $derived(link !== "reconnecting" && link !== "refused");

  // Danger rather than warning for a refused token: the other three come back on
  // their own once the network does, and this one never does. Written out in
  // full rather than assembled, because Tailwind reads this file as text and a
  // class it cannot see spelled here is a class it never emits.
  const tone = $derived(
    link === "refused"
      ? { border: "border-[var(--color-danger)]/50", dot: "bg-[var(--color-danger)]" }
      : { border: "border-[var(--color-warning)]/40", dot: "bg-[var(--color-warning)]" },
  );

  async function retry() {
    if (retrying) return;
    retrying = true;
    try {
      await retryConnection();
    } finally {
      retrying = false;
    }
  }
</script>

{#if visible}
  <!-- role=status, not alert: worth announcing once, without cutting off whatever
       the screen reader is already on. -->
  <div class="conn-banner" class:conn-banner-mobile={mobile} role="status" aria-live="polite">
    <div
      class="flex items-center gap-3 rounded-lg border {tone.border} bg-[var(--color-surface-2)] px-3 py-2 shadow-lg"
    >
      <span
        class="size-2 shrink-0 rounded-full {tone.dot}"
        class:animate-pulse={link === "reconnecting"}
      ></span>
      <div class="min-w-0">
        <p class="text-sm font-medium text-foreground">
          {#if link === "reconnecting"}{t("connection.reconnecting", { name })}
          {:else if link === "lost"}{t("connection.lost", { name })}
          {:else if link === "refused"}{t("connection.refused", { name })}
          {:else}{t("connection.offline", { name })}{/if}
        </p>
        {#if link === "lost"}
          <p class="text-xs text-muted-2">{t("connection.lostDesc")}</p>
        {:else if link === "unreached"}
          <p class="text-xs text-muted-2">{t("connection.offlineDesc")}</p>
        {:else if link === "refused"}
          <p class="text-xs text-muted-2">{t("connection.refusedDesc")}</p>
        {/if}
      </div>
      {#if canRetry}
        <button
          type="button"
          disabled={retrying}
          class="shrink-0 rounded-md border border-edge bg-[var(--color-surface-3)] px-2 py-1 text-xs text-foreground transition hover:bg-accent disabled:opacity-50"
          onclick={retry}
        >
          {t("connection.retry")}
        </button>
      {/if}
    </div>
  </div>
{/if}

<style>
  /* Top centre on desktop, which is where the toast stack is not. */
  .conn-banner {
    position: fixed;
    top: calc(0.75rem + env(safe-area-inset-top, 0px));
    left: 50%;
    transform: translateX(-50%);
    z-index: var(--z-toast);
    max-width: calc(100vw - 2rem);
  }
  /* On a phone the toasts move to the top, so this moves to the bottom. Floating
     clear of the bottom bar rather than flush to it: the bar's height is its own
     business, and a pill overlapping it would swallow taps on a tab. */
  .conn-banner-mobile {
    top: auto;
    bottom: calc(4rem + env(safe-area-inset-bottom, 0px));
    max-width: calc(100vw - 6rem);
  }
</style>
