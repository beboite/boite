<script lang="ts">
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import { app } from "$lib/app/store.svelte";
  import { hasTauri } from "$lib/backend/env";
  import WorkspaceToggle from "$lib/features/workspace/WorkspaceToggle.svelte";
  import MobileLaunchSheet from "./MobileLaunchSheet.svelte";
  import MobileThreadSheet from "./MobileThreadSheet.svelte";
  import Plus from "@lucide/svelte/icons/plus";
  import MoreVertical from "@lucide/svelte/icons/more-vertical";
  import Minus from "@lucide/svelte/icons/minus";
  import X from "@lucide/svelte/icons/x";

  const isTauri = hasTauri();
  const win = isTauri ? getCurrentWindow() : null;

  const project = $derived(
    app.currentProjectId
      ? app.projects.find((p) => p.id === app.currentProjectId) ?? null
      : null,
  );
  const onTerminal = $derived(app.mobileTab === "terminal");
  const activeTitle = $derived(app.activeThread?.title ?? app.activeThread?.label ?? null);

  let launchOpen = $state(false);
  let threadsOpen = $state(false);
</script>

<header
  data-tauri-drag-region
  class="flex h-12 shrink-0 select-none items-center gap-2 border-b border-border bg-[var(--color-titlebar)] px-2"
  style="padding-top: env(safe-area-inset-top, 0px);"
>
  <button
    type="button"
    class="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-1.5 py-1 text-left transition active:bg-accent/40"
    onclick={() => (app.mobileTab = "projects")}
    aria-label="Switch project"
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
            {project.name.charAt(0).toUpperCase()}
          </span>
        {/if}
      </span>
      <span class="flex min-w-0 flex-col leading-tight">
        <span class="truncate text-[13px] font-semibold text-foreground">{project.name}</span>
        {#if onTerminal && activeTitle}
          <span class="truncate text-[11px] text-muted-foreground">{activeTitle}</span>
        {/if}
      </span>
    {:else}
      <span class="truncate text-[13px] font-medium text-muted-foreground">No project</span>
    {/if}
  </button>

  {#if onTerminal}
    <button
      type="button"
      class="flex size-9 shrink-0 items-center justify-center rounded-lg text-foreground/80 transition hover:bg-accent active:bg-accent/70 disabled:opacity-40"
      onclick={() => (launchOpen = true)}
      disabled={!project}
      aria-label="New terminal"
      title="New terminal"
    >
      <Plus class="size-5" />
    </button>
    <button
      type="button"
      class="flex size-9 shrink-0 items-center justify-center rounded-lg text-foreground/80 transition hover:bg-accent active:bg-accent/70 disabled:opacity-40"
      onclick={() => (threadsOpen = true)}
      disabled={!project}
      aria-label="Terminals"
      title="Terminals"
    >
      <MoreVertical class="size-5" />
    </button>
  {/if}

  <div class="shrink-0">
    <WorkspaceToggle />
  </div>

  {#if isTauri}
    <button
      type="button"
      class="flex size-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition hover:bg-muted/50 hover:text-foreground"
      onclick={() => void win?.minimize()}
      aria-label="Minimize"
    >
      <Minus class="size-4" />
    </button>
    <button
      type="button"
      class="flex size-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition hover:bg-danger hover:text-white"
      onclick={() => void win?.close()}
      aria-label="Close"
    >
      <X class="size-4" />
    </button>
  {/if}
</header>

<MobileLaunchSheet open={launchOpen} onClose={() => (launchOpen = false)} />
<MobileThreadSheet open={threadsOpen} onClose={() => (threadsOpen = false)} />
