<script lang="ts">
  import { app } from "$lib/app/store.svelte";
  import { settings } from "$lib/features/settings/store.svelte";
  import { threadIconColor } from "$lib/features/fastpick/threadAccent";
  import { visibleStatus } from "$lib/domain/thread-status";
  import { projectDisplayName } from "$lib/shared/project-label";
  import { t } from "$lib/i18n/index.svelte";
  import ThreadGlyph from "$lib/features/thread/ThreadGlyph.svelte";
  import type { Thread } from "$lib/types";

  /**
   * The pinned section, drawn once for the whole sidebar.
   *
   * A section of its own rather than a flag on the rows inside each project,
   * because the order the user arranges is one order: a pinned list scattered
   * back into the folders it came from makes "move up" mean nothing. Which
   * project each one belongs to is on the row.
   *
   * Deliberately not the project rows' component. Those carry drag-to-reorder,
   * inline rename and the keyboard walk, all of which are wired to the tree they
   * live in, and grafting a second parent onto them to gain a header is a large
   * change to the one file in this repo that is already too big. This draws the
   * same glyph and the same accent and leaves that file to filter.
   */

  interface Props {
    onActivateThread: (threadId: string) => void;
    onContext: (thread: Thread, event: MouseEvent) => void;
  }

  let { onActivateThread, onContext }: Props = $props();

  const pinned = $derived(app.pinnedThreads);
</script>

{#if pinned.length > 0}
  <div class="mb-2">
    <div
      class="px-2 py-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase"
    >
      {t("sidebar.pinned")}
    </div>
    {#each pinned as thread (thread.id)}
      {@const project = app.projectById(thread.projectId)}
      <div
        class="group relative flex items-center gap-1.5 rounded-sm px-2 py-1 hover:bg-[var(--color-surface-2)]"
        class:bg-[var(--color-surface-2)]={app.activeThreadId === thread.id}
        data-thread-row={thread.id}
      >
        <button
          type="button"
          class="absolute inset-0 cursor-pointer rounded-sm"
          aria-label={thread.title ?? thread.label}
          onclick={() => onActivateThread(thread.id)}
          oncontextmenu={(e) => {
            e.preventDefault();
            onContext(thread, e);
          }}
        ></button>
        <ThreadGlyph
          status={visibleStatus(thread.status, !!thread.ptyId)}
          iconKey={thread.iconKey}
          color={threadIconColor(thread)}
          asleep={thread.autoSlept ?? false}
          keepAwake={thread.keepAwake ?? false}
          design={settings.state.sidebarDesign}
          showLogo={false}
          revealLogo={false}
          onToggleKeepAwake={() => app.toggleThreadKeepAwake(thread.id)}
          title={thread.title ?? thread.label}
          label={t("sidebar.toggleKeepAwake")}
        />
        <span class="relative min-w-0 flex-1 truncate text-base leading-[19px]">
          {thread.title ?? thread.label}
        </span>
        {#if project}
          <span class="relative shrink-0 truncate text-[11px] text-muted-foreground">
            {projectDisplayName(project)}
          </span>
        {/if}
      </div>
    {/each}
  </div>
{/if}
