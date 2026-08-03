<script lang="ts">
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import { platform as detectPlatform } from "@tauri-apps/plugin-os";
  import { app } from "$lib/app/store.svelte";
  import { projectDisplayName } from "$lib/shared/project-label";
  import { hasTauri } from "$lib/backend/env";
  import { t } from "$lib/i18n/index.svelte";
  import WorkspaceToggle from "$lib/features/workspace/WorkspaceToggle.svelte";
  import MobileLaunchSheet, { launchSheet } from "./MobileLaunchSheet.svelte";
  import MobileThreadSheet from "./MobileThreadSheet.svelte";
  import Plus from "@lucide/svelte/icons/plus";
  import MoreVertical from "@lucide/svelte/icons/more-vertical";
  import Minus from "@lucide/svelte/icons/minus";
  import X from "@lucide/svelte/icons/x";

  const isTauri = hasTauri();
  const win = isTauri ? getCurrentWindow() : null;
  // Same deal as the desktop titlebar: macOS draws its own traffic lights over
  // this bar, so no controls of ours and a free corner for them.
  const isMacOS = isTauri && safePlatform() === "macos";

  function safePlatform(): string | null {
    try {
      return detectPlatform();
    } catch {
      return null;
    }
  }

  const project = $derived(
    app.currentProjectId
      ? app.projects.find((p) => p.id === app.currentProjectId) ?? null
      : null,
  );
  const onTerminal = $derived(app.mobileTab === "terminal");
  const activeTitle = $derived(app.activeThread?.title ?? app.activeThread?.label ?? null);

  let threadsOpen = $state(false);
</script>

<header
  data-tauri-drag-region
  class="flex min-h-12 shrink-0 select-none items-center gap-2 border-b border-border bg-[var(--color-titlebar)] {isMacOS
    ? 'pl-[78px]'
    : ''}"
  style="padding-top: env(safe-area-inset-top, 0px); padding-left: max(env(safe-area-inset-left, 0px), 0.5rem); padding-right: max(env(safe-area-inset-right, 0px), 0.5rem);"
>
  <button
    type="button"
    class="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-1.5 py-1 text-left transition active:bg-accent/40"
    onclick={() => (app.mobileTab = "projects")}
    aria-label={t("mobile.switchProject")}
  >
    {#if project}
      <span
        class="flex size-7 shrink-0 items-center justify-center overflow-hidden rounded-md"
        style:background={project.icon ? "transparent" : "var(--color-surface-3)"}
      >
        {#if project.icon}
          <img src={project.icon} alt="" class="size-full object-contain" decoding="async" draggable="false" />
        {:else}
          <span class="text-xs font-semibold text-muted-foreground">
            {projectDisplayName(project).charAt(0).toUpperCase()}
          </span>
        {/if}
      </span>
      <span class="flex min-w-0 flex-col leading-tight">
        <span class="truncate text-base font-semibold text-foreground">{projectDisplayName(project)}</span>
        {#if onTerminal && activeTitle}
          <span class="truncate text-xs text-muted-foreground">{activeTitle}</span>
        {/if}
      </span>
    {:else}
      <span class="truncate text-base font-medium text-muted-foreground">{t("mobile.noProject")}</span>
    {/if}
  </button>

  <!-- size-11, not size-9: this bar only ever exists under a finger, and 44px
       is the smallest target a thumb hits reliably. -->
  {#if onTerminal}
    <button
      type="button"
      class="flex size-11 shrink-0 items-center justify-center rounded-lg text-foreground/80 transition hover:bg-accent active:bg-accent/70 disabled:opacity-40"
      onclick={() => (launchSheet.open = true)}
      disabled={!project}
      aria-label={t("mobile.newTerminal")}
      title={t("mobile.newTerminal")}
    >
      <Plus class="size-5" />
    </button>
    <button
      type="button"
      class="flex size-11 shrink-0 items-center justify-center rounded-lg text-foreground/80 transition hover:bg-accent active:bg-accent/70 disabled:opacity-40"
      onclick={() => (threadsOpen = true)}
      disabled={!project}
      aria-label={t("mobile.terminals")}
      title={t("mobile.terminals")}
    >
      <MoreVertical class="size-5" />
    </button>
  {/if}

  <!-- The header is `select-none` because it doubles as the window drag region,
       but the workspace sheet opens inside it, and a boite's URL and name are
       there to be read and copied. -->
  <div class="shrink-0 select-text">
    <WorkspaceToggle />
  </div>

  {#if isTauri && !isMacOS}
    <button
      type="button"
      class="flex size-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition hover:bg-muted/50 hover:text-foreground"
      onclick={() => void win?.minimize()}
      aria-label={t("titlebar.minimize")}
    >
      <Minus class="size-4" />
    </button>
    <button
      type="button"
      class="flex size-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition hover:bg-danger hover:text-white"
      onclick={() => void win?.close()}
      aria-label={t("titlebar.close")}
    >
      <X class="size-4" />
    </button>
  {/if}
</header>

<MobileLaunchSheet open={launchSheet.open} onClose={() => (launchSheet.open = false)} />
<MobileThreadSheet open={threadsOpen} onClose={() => (threadsOpen = false)} />
