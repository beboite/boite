<script lang="ts">
  import { app } from "$lib/app/store.svelte";
  import type { PaneContent } from "./types";
  import { lazyComponent } from "$lib/shared/lazy.svelte";
  import GitPanel from "$lib/features/git/GitPanel.svelte";
  import ExplorerPanel from "$lib/features/explorer/ExplorerPanel.svelte";
  import TodoPanel from "$lib/features/todo/TodoPanel.svelte";
  import BrowserPane from "$lib/features/browser/BrowserPane.svelte";
  import { t } from "$lib/i18n/index.svelte";

  /**
   * Whatever is not a terminal, drawn inside its pane.
   *
   * Terminals are absent on purpose: they render to a WebGL canvas that cannot
   * be reparented, so the page positions them over the rectangle this shell
   * measured. Everything here is ordinary DOM and lives in the tree.
   */
  /**
   * `projectId` is the group's, and every panel gets it: a panel used to read
   * the selected project instead, so a git panel sitting beside a terminal in
   * one project described whichever project the sidebar was pointing at.
   */
  type Props = { content: PaneContent; projectId: string; paneId: string };
  let { content, projectId, paneId }: Props = $props();

  // CodeMirror is ~600 KB and the overview pulls in the usage charts; neither
  // belongs in the entry graph just because a pane kind exists.
  const EditorView = lazyComponent(
    () => import("$lib/features/editor/EditorPanel.svelte"),
  );
  const OverviewView = lazyComponent(
    () => import("$lib/features/project/ProjectOverview.svelte"),
  );

  $effect(() => {
    if (content.kind === "editor") void EditorView.ensure();
    if (content.kind === "dashboard") void OverviewView.ensure();
  });

  const project = $derived(app.projects.find((p) => p.id === projectId) ?? null);

  function openThread(threadId: string) {
    app.activeThreadId = threadId;
    app.view = "terminal";
  }
</script>

<div class="h-full min-h-0 w-full overflow-hidden">
  {#if content.kind === "git"}
    <GitPanel {projectId} />
  {:else if content.kind === "explorer"}
    <ExplorerPanel {projectId} />
  {:else if content.kind === "todo"}
    <TodoPanel {projectId} />
  {:else if content.kind === "browser"}
    <BrowserPane url={content.url} {paneId} drivenBy={content.drivenBy ?? null} />
  {:else if content.kind === "editor"}
    {#if EditorView.current}
      {@const EditorComp = EditorView.current}
      <EditorComp inPane />
    {:else}
      <div class="flex h-full items-center justify-center text-xs text-muted-foreground/70">
        {t("common.loading")}
      </div>
    {/if}
  {:else if content.kind === "dashboard"}
    {#if project && OverviewView.current}
      {@const OverviewComp = OverviewView.current}
      <div class="h-full scroll-pane overflow-y-auto p-3">
        <OverviewComp {project} onOpenThread={openThread} />
      </div>
    {:else}
      <div class="flex h-full items-center justify-center text-xs text-muted-foreground/70">
        {t("common.loading")}
      </div>
    {/if}
  {/if}
</div>
