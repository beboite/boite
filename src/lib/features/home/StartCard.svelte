<!--
  What a user can start, when nothing is running.

  The rows are the launcher shortcuts of the General tab, and the click is the
  one the sidebar's launcher menu makes: `launchTargetProjectId` picks the
  selected project (Scratch when there is none) and `launchShortcut` opens the
  terminal there. The hint under each label is `shortcutAgentHint`, so a row
  reading "pwsh -NoLogo -Command claude" names claude.
-->
<script lang="ts">
  import { app } from "$lib/app/store.svelte";
  import { settings } from "$lib/features/settings/store.svelte";
  import { launchShortcut, launchTargetProjectId } from "$lib/features/thread/api";
  import { shortcutAgentHint } from "$lib/features/shortcut/agent-hint";
  import DashboardCard from "$lib/features/project/DashboardCard.svelte";
  import ShortcutIcon from "$lib/shared/icons/ShortcutIcon.svelte";
  import Button from "$lib/shared/components/Button.svelte";
  import { resolveIconKey } from "$lib/shared/icons/detect";
  import { projectDisplayName } from "$lib/shared/project-label";
  import { t } from "$lib/i18n/index.svelte";
  import type { Shortcut } from "$lib/types";
  import Rocket from "@lucide/svelte/icons/rocket";

  const shortcuts = $derived(settings.state.shortcuts);

  const target = $derived(app.projectById(app.currentProjectId));
  const targetName = $derived(target ? projectDisplayName(target) : null);

  async function start(shortcut: Shortcut) {
    const projectId = await launchTargetProjectId(false);
    if (!projectId) return;
    await launchShortcut(shortcut, projectId);
  }

  function openSettings() {
    app.view = "settings";
  }
</script>

<DashboardCard title={t("home.start")} badge={shortcuts.length || null} flush>
  {#snippet icon()}<Rocket class="size-3.5" />{/snippet}
  {#snippet lead()}
    {#if targetName}
      <span class="text-xs text-muted-2">{t("home.startTarget", { project: targetName })}</span>
    {/if}
  {/snippet}
  {#if shortcuts.length === 0}
    <div class="flex flex-col items-start gap-2 px-3.5 pb-3">
      <p class="text-sm text-muted-foreground">{t("home.startEmpty")}</p>
      <Button variant="secondary" onclick={openSettings}>
        {t("shortcuts.addShortcuts")}
      </Button>
    </div>
  {:else}
    <div class="grid grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] gap-1.5 px-2.5 pb-3">
      {#each shortcuts as shortcut (shortcut.id)}
        {@const iconKey = resolveIconKey(shortcut.iconKey, shortcut.label, shortcut.command)}
        <button
          type="button"
          class="press flex min-w-0 items-center gap-2 rounded-md border border-edge bg-[var(--color-surface-2)] px-2.5 py-2 text-left transition hover:border-foreground/30 hover:bg-[var(--color-surface-3)] focus-visible:focus-ring-inset disabled:cursor-not-allowed disabled:opacity-40"
          disabled={!shortcut.command.trim()}
          onclick={() => void start(shortcut)}
        >
          <ShortcutIcon {iconKey} size={16} color={shortcut.iconColor ?? null} />
          <span class="min-w-0 flex-1">
            <span class="block truncate text-sm font-medium text-foreground">
              {shortcut.label}
            </span>
            <span class="block truncate text-xs text-muted-2">
              {shortcut.command.trim()
                ? shortcutAgentHint(shortcut.command)
                : t("shortcuts.emptyCommand")}
            </span>
          </span>
        </button>
      {/each}
    </div>
  {/if}
</DashboardCard>
