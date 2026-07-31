<script lang="ts">
  import { workspace } from "$lib/backend";
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

  // Both modes that have a boite in play, not just pure remote. The login screen
  // carries its own message, so the banner stays out of its way.
  const visible = $derived(
    workspace.hasRemote && !workspace.needsLogin && workspace.connection !== "connected",
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

  // Three states worth telling apart. A dial in flight is not a failure. A link
  // that answered once and went away is a loss, and what was typed since is gone
  // with it. One that never answered at all is a boite that may simply be asleep,
  // and saying "lost" about it would be a lie.
  type LinkState = "reconnecting" | "lost" | "unreached";
  const link = $derived.by<LinkState>(() => {
    if (workspace.connection === "connecting") return "reconnecting";
    return workspace.linkEstablished ? "lost" : "unreached";
  });

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
      class="flex items-center gap-3 rounded-lg border border-[var(--color-warning)]/40 bg-[var(--color-surface-2)] px-3 py-2 shadow-lg"
    >
      <span
        class="size-2 shrink-0 rounded-full bg-[var(--color-warning)]"
        class:animate-pulse={link === "reconnecting"}
      ></span>
      <div class="min-w-0">
        <p class="text-sm font-medium text-foreground">
          {link === "reconnecting"
            ? t("connection.reconnecting", { name })
            : link === "lost"
              ? t("connection.lost", { name })
              : t("connection.offline", { name })}
        </p>
        {#if link === "lost"}
          <p class="text-xs text-muted-foreground/80">{t("connection.lostDesc")}</p>
        {:else if link === "unreached"}
          <p class="text-xs text-muted-foreground/80">{t("connection.offlineDesc")}</p>
        {/if}
      </div>
      <!-- No button mid-dial: there is nothing to shorten, and the socket is
           already doing the thing the button asks for. -->
      {#if link !== "reconnecting"}
        <button
          type="button"
          disabled={retrying}
          class="shrink-0 rounded-md border border-border bg-[var(--color-surface-3)] px-2 py-1 text-xs text-foreground transition hover:bg-accent disabled:opacity-50"
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
