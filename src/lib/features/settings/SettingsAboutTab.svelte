<script lang="ts">
  import SettingsCard from "$lib/shared/components/SettingsCard.svelte";
  import UpdatesCard from "$lib/features/updater/UpdatesCard.svelte";
  import BoiteLogo from "$lib/shared/components/BoiteLogo.svelte";
  import { hasTauri } from "$lib/backend/env";
  import { workspace } from "$lib/backend";
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
</script>

<SettingsCard title={t("about.title")} description={t("about.description")}>
  <div class="flex items-center gap-3 rounded-lg border border-border bg-[var(--color-surface-2)] px-3 py-2.5">
    <span class="shrink-0 text-muted-foreground/50"><BoiteLogo size={32} /></span>
    <dl class="grid min-w-0 flex-1 grid-cols-[auto_1fr] items-baseline gap-x-3 gap-y-1 text-xs">
      <dt class="text-muted-foreground">{t("about.version")}</dt>
      <dd class="justify-self-end font-mono text-foreground">v{__APP_VERSION__}</dd>

      <dt class="text-muted-foreground">{t("about.platform")}</dt>
      <dd class="justify-self-end text-foreground/90">
        {canUpdate ? t("about.platformDesktop") : t("about.platformBrowser")}
      </dd>

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
          class="truncate font-mono text-foreground/90 underline decoration-border underline-offset-2 transition hover:decoration-foreground"
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
