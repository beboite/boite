<script lang="ts">
  import { fade, scale } from "svelte/transition";
  import { app } from "$lib/app/store.svelte";
  import { workspace } from "$lib/backend";
  import { device } from "$lib/features/settings/device.svelte";
  import { projectDisplayName } from "$lib/shared/project-label";
  import { focusTrap } from "$lib/shared/actions/focusTrap";
  import { t } from "$lib/i18n/index.svelte";
  import Check from "@lucide/svelte/icons/check";
  import FolderPlus from "@lucide/svelte/icons/folder-plus";

  /**
   * Which of the boite's projects this device shows.
   *
   * Dynamic mode used to be all-or-nothing: switching it on grafted every remote
   * project onto the local sidebar, and the only way back out was switching the
   * whole mode off. The boite-coloured `+` opens this instead, and the rows it
   * ticks are per device — the phone and the desktop want different halves of
   * the same boite.
   *
   * Adding a project on the boite still lives here, at the bottom, because it is
   * the same question one step further: this list, plus one that is not on it
   * yet.
   */
  type Props = {
    onClose: () => void;
    onAddRemote: () => void;
  };
  let { onClose, onAddRemote }: Props = $props();

  const boiteId = $derived(workspace.activeBoiteId);
  const boiteColor = $derived(workspace.info.color || "var(--color-success)");
  const boiteName = $derived(workspace.info.name || "boite");

  // Every remote row the workspace loaded, ticked or not: this is the one place
  // that has to see past the sidebar's own filter.
  const remoteProjects = $derived(
    app.projects
      .filter((p) => p.origin === "remote" && !p.archived)
      .sort((a, b) => projectDisplayName(a).localeCompare(projectDisplayName(b))),
  );
  const shownCount = $derived(
    remoteProjects.filter((p) => device.isRemoteProjectShown(boiteId, p.id)).length,
  );

  function toggle(projectId: string) {
    if (!boiteId) return;
    device.setRemoteProjectShown(
      boiteId,
      projectId,
      !device.isRemoteProjectShown(boiteId, projectId),
    );
  }

  function setAll(shown: boolean) {
    if (!boiteId) return;
    device.setRemoteProjects(boiteId, shown ? remoteProjects.map((p) => p.id) : []);
  }

  function backdropClick(e: MouseEvent) {
    if (e.target === e.currentTarget) onClose();
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    onClose();
  }
</script>

<svelte:window onkeydown={onKeydown} />

<!-- svelte-ignore a11y_click_events_have_key_events -->
<div
  class="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center bg-[var(--color-scrim)] p-4 backdrop-blur-sm"
  role="dialog"
  aria-modal="true"
  aria-labelledby="remote-projects-title"
  tabindex="-1"
  use:focusTrap
  onclick={backdropClick}
  transition:fade={{ duration: 120 }}
>
  <div
    class="surface-dialog flex max-h-[min(70vh,520px)] w-[420px] max-w-full flex-col overflow-hidden"
    style:--boite={boiteColor}
    transition:scale={{ duration: 140, start: 0.97 }}
  >
    <header class="flex items-start gap-2.5 px-4 py-3">
      <span class="mt-1 size-2.5 shrink-0 rounded-full" style:background-color={boiteColor}
      ></span>
      <div class="min-w-0 flex-1">
        <h2
          id="remote-projects-title"
          class="truncate text-sm font-semibold tracking-tight text-foreground"
        >
          {t("sidebar.remoteProjectsTitle", { name: boiteName })}
        </h2>
        <p class="mt-0.5 text-sm text-muted-foreground">
          {t("sidebar.remoteProjectsDesc")}
        </p>
      </div>
    </header>

    {#if remoteProjects.length > 0}
      <div
        class="flex items-center justify-between gap-2 border-t border-border px-4 py-1.5 text-xs text-muted-foreground"
      >
        <span>
          {t("sidebar.remoteProjectsCount", {
            shown: shownCount,
            total: remoteProjects.length,
          })}
        </span>
        <span class="flex gap-1">
          <button
            type="button"
            class="rounded px-1.5 py-0.5 transition hover:bg-accent hover:text-foreground"
            onclick={() => setAll(true)}
          >
            {t("sidebar.remoteProjectsAll")}
          </button>
          <button
            type="button"
            class="rounded px-1.5 py-0.5 transition hover:bg-accent hover:text-foreground"
            onclick={() => setAll(false)}
          >
            {t("sidebar.remoteProjectsNone")}
          </button>
        </span>
      </div>
    {/if}

    <div class="min-h-0 flex-1 scroll-pane overflow-y-auto border-t border-border p-1.5">
      {#if remoteProjects.length === 0}
        <p class="px-3 py-6 text-center text-sm text-muted-foreground">
          {t("sidebar.remoteProjectsEmpty")}
        </p>
      {:else}
        {#each remoteProjects as project (project.id)}
          {@const shown = device.isRemoteProjectShown(boiteId, project.id)}
          <button
            type="button"
            role="switch"
            aria-checked={shown}
            class="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition hover:bg-accent"
            onclick={() => toggle(project.id)}
          >
            <span
              class="box flex size-4 shrink-0 items-center justify-center rounded-xs border transition"
              class:on={shown}
            >
              {#if shown}
                <Check class="size-3" />
              {/if}
            </span>
            <span
              class="flex size-5 shrink-0 items-center justify-center overflow-hidden rounded-xs"
              style:background={project.icon ? "transparent" : "var(--color-surface-3)"}
            >
              {#if project.icon}
                <img
                  src={project.icon}
                  alt=""
                  class="size-full object-contain"
                  loading="lazy"
                  decoding="async"
                  draggable="false"
                />
              {:else}
                <span class="text-xs font-semibold text-muted-foreground">
                  {projectDisplayName(project).charAt(0).toUpperCase()}
                </span>
              {/if}
            </span>
            <span class="min-w-0 flex-1">
              <span class="block truncate text-base leading-tight text-foreground">
                {projectDisplayName(project)}
              </span>
              <span class="block truncate text-sm text-muted-2">
                {project.cwd}
              </span>
            </span>
          </button>
        {/each}
      {/if}
    </div>

    <footer
      class="flex items-center justify-between gap-2 border-t border-border bg-[var(--color-titlebar)] px-4 py-2.5"
    >
      <button
        type="button"
        class="flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-sm text-muted-foreground transition hover:text-foreground"
        style:border-color={boiteColor}
        onclick={onAddRemote}
      >
        <FolderPlus class="size-3.5" />
        {t("sidebar.addProjectOn", { name: boiteName })}
      </button>
      <button
        type="button"
        class="rounded-md px-3 py-1.5 text-sm text-muted-foreground transition hover:bg-accent hover:text-foreground"
        onclick={onClose}
      >
        {t("common.close")}
      </button>
    </footer>
  </div>
</div>

<style>
  .box {
    border-color: var(--color-border-strong);
    color: var(--color-background);
  }
  .box.on {
    background: var(--boite);
    border-color: var(--boite);
  }
</style>
