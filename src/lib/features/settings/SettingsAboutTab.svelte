<script lang="ts">
  import SettingsCard from "$lib/shared/components/SettingsCard.svelte";
  import UpdatesCard from "$lib/features/updater/UpdatesCard.svelte";
  import LogsSection from "./LogsSection.svelte";
  import BoiteLogo from "$lib/shared/components/BoiteLogo.svelte";
  import { hasTauri } from "$lib/backend/env";
  import { workspace } from "$lib/backend";
  import type { ServerIdentity } from "$lib/backend/types";
  import type { Platform } from "$lib/storage/platform.svelte";
  import { openUrl } from "$lib/platform/opener";
  import { t } from "$lib/i18n/index.svelte";

  /**
   * Which build is running, and the one control that changes it.
   *
   * The version used to be a line of grey monospace in the settings footer,
   * present on every tab and belonging to none of them, while the thing you go
   * looking for when you read a version — whether there is a newer one — was a
   * card under General between push notifications and the shortcut editor.
   *
   * Nothing to update in a browser tab: the page is whatever the server last
   * served, so the card is desktop-only and the rest of this tab still answers
   * the question it was opened for.
   */
  const canUpdate = hasTauri();

  const REPO_URL = "https://github.com/beboite/boite";

  /**
   * The boite's own identity, or null when there is no boite in play.
   *
   * `__APP_VERSION__` is a Vite constant describing the bundle this window
   * downloaded, and it sat one row above a line saying the workspace was on
   * another machine. It read as the server's version and it never was: on a
   * phone it names the SPA the server happened to serve, and on a desktop
   * driving a boite it names an install that is not running any of the threads.
   *
   * Both reads below are runes and both are load-bearing. `mode` decides whether
   * a boite is in play, `connection` is what flips when a handshake finishes,
   * and the identity itself is a plain field written before the socket ever says
   * "connected". Re-reading it on that flag is therefore enough, and no effect
   * is needed to chase it.
   */
  const server = $derived.by<ServerIdentity | null>(() => {
    if (!workspace.hasRemote || workspace.connection !== "connected") return null;
    return workspace.remoteBackend?.serverIdentity ?? null;
  });

  /**
   * A machine that answered and is none of the three, against one that never
   * said. Kept apart rather than folded into one word: a server built before
   * `hello` carried any of this is silent, not exotic.
   */
  function osLabel(os: Platform | null): string {
    if (os === "windows") return t("about.osWindows");
    if (os === "macos") return t("about.osMacos");
    if (os === "linux") return t("about.osLinux");
    if (os === "unknown") return t("about.osUnknown");
    return t("about.boiteSilent");
  }

  const boiteVersion = $derived(
    server?.version ? `v${server.version}` : t("about.boiteSilent"),
  );
  const boiteOs = $derived(osLabel(server?.platform ?? null));
  const boiteHost = $derived(server?.host ?? t("about.boiteSilent"));
</script>

<SettingsCard title={t("about.title")} anchor="about.title" description={t("about.description")}>
  <div class="flex items-center gap-3 rounded-lg border border-border bg-[var(--color-surface-2)] px-3 py-2.5">
    <span class="shrink-0 text-muted-foreground/50"><BoiteLogo size={32} /></span>
    <dl class="grid min-w-0 flex-1 grid-cols-[auto_1fr] items-baseline gap-x-3 gap-y-1 text-xs">
      <!-- Unqualified while this device is the only machine there is. The label
           only has to name a machine once there are two of them to confuse. -->
      <dt class="text-muted-foreground">
        {server ? t("about.versionHere") : t("about.version")}
      </dt>
      <dd class="justify-self-end tabular-nums text-foreground">v{__APP_VERSION__}</dd>

      <dt class="text-muted-foreground">{t("about.platform")}</dt>
      <dd class="justify-self-end text-foreground/90">
        {canUpdate ? t("about.platformDesktop") : t("about.platformBrowser")}
      </dd>

      {#if server}
        <dt class="text-muted-foreground">{t("about.versionBoite")}</dt>
        <dd class="justify-self-end tabular-nums text-foreground">{boiteVersion}</dd>

        <dt class="text-muted-foreground">{t("about.boitePlatform")}</dt>
        <dd class="justify-self-end text-foreground/90">{boiteOs}</dd>

        <dt class="text-muted-foreground">{t("about.boiteHost")}</dt>
        <dd class="min-w-0 justify-self-end truncate text-foreground/90">
          {boiteHost}
        </dd>
      {/if}

      <dt class="text-muted-foreground">{t("about.workspace")}</dt>
      <dd class="min-w-0 justify-self-end truncate text-foreground/90">
        {workspace.isRemote ? t("about.workspaceRemote") : t("about.workspaceLocal")}
      </dd>

      <dt class="text-muted-foreground">{t("about.source")}</dt>
      <dd class="min-w-0 justify-self-end truncate">
        <!-- Through the opener, never an <a href>: in the desktop webview a plain
             link navigates the app window itself, and there is no way back. -->
        <button
          type="button"
          class="truncate text-foreground/90 underline decoration-border underline-offset-2 transition hover:decoration-foreground"
          onclick={() => void openUrl(REPO_URL)}
        >
          beboite/boite
        </button>
      </dd>
    </dl>
  </div>
</SettingsCard>

{#if canUpdate}
  <UpdatesCard />
{/if}

<!-- The logs were their own page in the rail, which spent a permanent line on
     a page opened when something has already gone wrong. They belong beside
     the build number: what version is this, and what did it write. -->
<LogsSection />
