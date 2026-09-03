<script lang="ts">
  import { app } from "$lib/app/store.svelte";
  import { tip } from "$lib/shared/actions/tooltip";
  import { editorStore } from "./store.svelte";
  import { paneStore } from "$lib/features/panes/store.svelte";
  import EditorTabStrip from "./EditorTabStrip.svelte";
  import CodeMirror from "./CodeMirror.svelte";
  import PdfView from "./PdfView.svelte";
  import DiffView from "./DiffView.svelte";
  import { canRevealItem, revealItemInDir } from "$lib/platform/opener";
  import Save from "@lucide/svelte/icons/save";
  import FolderOpen from "@lucide/svelte/icons/folder-open";
  import FileText from "@lucide/svelte/icons/file-text";
  import RotateCw from "@lucide/svelte/icons/rotate-cw";
  import { t } from "$lib/i18n/index.svelte";

  /**
   * `inPane` is the editor living inside a pane rather than covering the whole
   * main area. It stops the empty-buffer effect from changing the app view out
   * from under a layout that never set it.
   *
   * `paneId` and `paneProjectId` are that pane's own, and only the pane passes
   * them: they are what lets the last tab closing take the pane with it.
   */
  type Props = { inPane?: boolean; paneId?: string | null; paneProjectId?: string | null };
  let { inPane = false, paneId = null, paneProjectId = null }: Props = $props();

  const here = $derived(editorStore.forProject(app.currentProjectId));

  // Nothing from another project is drawn: the active buffer is global, and
  // walking to another project would otherwise leave its file on screen with a
  // tab strip that does not contain it.
  const active = $derived(
    here.some((b) => b.id === editorStore.activeId) ? editorStore.active : null,
  );

  // Stepping onto a project whose files are open but none of them active: take
  // the first rather than show "pick a file" over a strip full of tabs.
  $effect(() => {
    if (active || here.length === 0) return;
    editorStore.setActive(here[0].id);
  });

  $effect(() => {
    if (inPane) return;
    if (here.length === 0 && app.view === "editor") {
      app.view = "terminal";
    }
  });

  /**
   * An editor pane whose last file was closed goes with it.
   *
   * The empty state below is an instruction to the file panel, which is fine
   * when the editor is the whole surface and useless in a pane an agent opened
   * to show one image: closing the preview left a rectangle saying "pick a
   * file" with no tab, no close button of its own and nothing to pick from.
   *
   * Counted on the pane's OWN project rather than the selected one, so walking
   * to another project does not close the editor panes of the one left behind,
   * and latched on having held something: a pane opened empty from the palette
   * is a place the user is about to open a file into, not a leftover.
   */
  const mine = $derived(editorStore.forProject(paneProjectId ?? app.currentProjectId));
  let held = $state(false);
  $effect(() => {
    if (!inPane || !paneId) return;
    if (mine.length > 0) {
      held = true;
      return;
    }
    if (held) paneStore.closePane(paneId);
  });

  function onChange(next: string) {
    if (active && active.kind === "file") editorStore.setContent(active.id, next);
  }

  function save() {
    if (active && active.kind === "file") void editorStore.save(active.id);
  }

  function handleKeydown(e: KeyboardEvent) {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      if (active && active.kind === "file") {
        e.preventDefault();
        void editorStore.save(active.id);
      }
    }
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="flex h-full min-h-0 flex-col">
  <!-- No way-out button of its own any more: the titlebar's editor button is
       lit while this view is up and takes you back, which is the same round
       trip in the place that already owns "which surface am I on". A second
       one here spent a tab's worth of the strip saying it twice. -->
  <div class="flex items-stretch border-b border-border bg-[var(--color-titlebar)]">
    <div class="min-w-0 flex-1">
      <EditorTabStrip />
    </div>
  </div>

  <div
    id="editor-panel"
    role="tabpanel"
    aria-labelledby={active ? `editor-tab-${active.id}` : undefined}
    class="flex min-h-0 flex-1 flex-col"
  >
  {#if !active}
    <div
      class="flex flex-1 flex-col items-center justify-center gap-2 text-muted-2"
    >
      <FileText class="size-8 opacity-40" />
      <p class="text-xs">{t("editor.pickAFile")}</p>
    </div>
  {:else if active.loading}
    <div class="flex flex-1 items-center justify-center text-xs text-muted-2">
      {t("common.loading")}
    </div>
  {:else if active.error}
    <div
      class="flex flex-1 items-center justify-center px-4 text-center text-xs text-[var(--color-danger)]"
    >
      {active.error}
    </div>
  {:else if active.kind === "preview"}
    <div class="flex h-7 shrink-0 items-center gap-2 border-b border-border bg-[var(--color-titlebar)] px-3 text-xs text-muted-foreground">
      <span class="truncate flex-1" use:tip={active.path}>{active.path}</span>
      <!-- Reveal, not open: `opener:allow-open-path` is not among the app's
           capabilities, and handing the OS an arbitrary path to run its default
           handler on is a wider door than a preview button needs.
           Absent off this machine: the file manager is the local one and the
           path would be the boite's. -->
      {#if canRevealItem(active.path)}
        <button
          type="button"
          class="rounded p-1 text-muted-foreground transition hover:bg-[var(--color-surface-2)] hover:text-foreground"
          onclick={() => active && void revealItemInDir(active.path)}
          use:tip={t("explorer.revealInFileManager")}
          aria-label={t("explorer.revealInFileManager")}
        >
          <FolderOpen class="size-3.5" />
        </button>
      {/if}
    </div>
    {#if active.media === "pdf"}
      <PdfView bytes={active.bytes} name={active.displayName} />
    {:else}
      <!-- A data URL, which `img-src 'self' data: blob:` already allows, so an
           image needs no endpoint and no frame. `object-contain` rather than a
           natural size: a screenshot is usually wider than the pane. -->
      <div class="checkerboard min-h-0 flex-1 overflow-auto p-4">
        <img
          class="mx-auto max-h-full max-w-full object-contain"
          src={active.dataUrl}
          alt={active.displayName}
        />
      </div>
    {/if}
  {:else if active.kind === "file"}
    <div class="flex h-7 shrink-0 items-center gap-2 border-b border-border bg-[var(--color-titlebar)] px-3 text-xs text-muted-foreground">
      <span class="truncate flex-1" use:tip={active.path}>{active.path}</span>
      {#if active.isReadonly}
        <span class="rounded bg-[var(--color-surface-2)] px-1.5 py-0.5 text-2xs uppercase">{t("editor.readonly")}</span>
      {/if}
      {#if active.externalChange}
        <span
          class="rounded bg-[var(--color-warning)]/15 px-1.5 py-0.5 text-2xs uppercase text-[var(--color-warning)]"
          use:tip={t("editor.staleWarning")}
        >
          {t("editor.changedOnDisk")}
        </span>
        <button
          type="button"
          class="rounded p-1 text-muted-foreground transition hover:bg-[var(--color-surface-2)] hover:text-foreground"
          onclick={() => active && void editorStore.reloadFromDisk(active.id)}
          use:tip={t("editor.reloadFromDisk")}
          aria-label={t("editor.reload")}
        >
          <RotateCw class="size-3.5" />
        </button>
      {/if}
      {#if active.dirty}
        <span
          class="text-foreground"
          role="img"
          aria-label={t("editor.unsaved")}
          use:tip={t("editor.unsaved")}>●</span
        >
      {/if}
      <button
        type="button"
        class="rounded p-1 text-muted-foreground transition hover:bg-[var(--color-surface-2)] hover:text-foreground disabled:opacity-40"
        onclick={save}
        disabled={active.isReadonly || !active.dirty || active.saving}
        use:tip={t("editor.saveWithShortcut")}
        aria-label={t("editor.save")}
      >
        <Save class="size-3.5 {active.saving ? 'animate-pulse' : ''}" />
      </button>
    </div>
    <div class="min-h-0 flex-1">
      {#key active.id}
        <CodeMirror
          value={active.content}
          filename={active.displayName}
          readonly={active.isReadonly}
          {onChange}
          onSave={save}
        />
      {/key}
    </div>
  {:else if active.kind === "diff"}
    {#if active.binary}
      <div
        class="flex flex-1 items-center justify-center px-4 text-center text-xs text-muted-foreground"
      >
        {t("editor.binaryDiff")}
      </div>
    {:else}
      <div class="min-h-0 flex-1">
        {#key active.id}
          <DiffView
            leftContent={active.leftContent}
            rightContent={active.rightContent}
            leftLabel={active.leftLabel}
            rightLabel={active.rightLabel}
            filename={active.path.split(/[\\/]/).pop() ?? null}
          />
        {/key}
      </div>
    {/if}
  {/if}
  </div>
</div>

<style>
  /* Transparency has to look like transparency, not like the app's background:
     a PNG with an alpha channel is exactly what you open a preview to check. */
  .checkerboard {
    background-image:
      linear-gradient(45deg, var(--color-surface-2) 25%, transparent 25%),
      linear-gradient(-45deg, var(--color-surface-2) 25%, transparent 25%),
      linear-gradient(45deg, transparent 75%, var(--color-surface-2) 75%),
      linear-gradient(-45deg, transparent 75%, var(--color-surface-2) 75%);
    background-size: 16px 16px;
    background-position: 0 0, 0 8px, 8px -8px, -8px 0;
  }
</style>
