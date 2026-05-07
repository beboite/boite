<script lang="ts">
  import { app } from "$lib/app/store.svelte";
  import { editorStore } from "./store.svelte";
  import EditorTabStrip from "./EditorTabStrip.svelte";
  import CodeMirror from "./CodeMirror.svelte";
  import DiffView from "./DiffView.svelte";
  import Save from "@lucide/svelte/icons/save";
  import FileText from "@lucide/svelte/icons/file-text";
  import TerminalSquare from "@lucide/svelte/icons/terminal-square";

  const active = $derived(editorStore.active);

  function backToTerminal() {
    app.view = "terminal";
  }

  $effect(() => {
    if (editorStore.buffers.length === 0 && app.view === "editor") {
      app.view = "terminal";
    }
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
  <div class="flex items-stretch border-b border-border bg-[var(--color-titlebar)]">
    <button
      type="button"
      class="flex h-8 shrink-0 items-center gap-1.5 border-r border-border px-2.5 text-[11px] text-muted-foreground transition hover:bg-[var(--color-surface-2)] hover:text-foreground"
      onclick={backToTerminal}
      title="Back to terminal"
      aria-label="Back to terminal"
    >
      <TerminalSquare class="size-3.5" />
      <span>Terminal</span>
    </button>
    <div class="min-w-0 flex-1">
      <EditorTabStrip />
    </div>
  </div>

  {#if !active}
    <div
      class="flex flex-1 flex-col items-center justify-center gap-2 text-muted-foreground/70"
    >
      <FileText class="size-8 opacity-40" />
      <p class="text-xs">Pick a file in the Files or Git panel.</p>
    </div>
  {:else if active.loading}
    <div class="flex flex-1 items-center justify-center text-xs text-muted-foreground/70">
      Loading…
    </div>
  {:else if active.error}
    <div
      class="flex flex-1 items-center justify-center px-4 text-center text-xs text-[var(--color-danger)]"
    >
      {active.error}
    </div>
  {:else if active.kind === "file"}
    <div class="flex h-7 shrink-0 items-center gap-2 border-b border-border bg-[var(--color-titlebar)] px-3 text-[10.5px] text-muted-foreground">
      <span class="truncate flex-1" title={active.path}>{active.path}</span>
      {#if active.isReadonly}
        <span class="rounded bg-[var(--color-surface-2)] px-1.5 py-0.5 text-[9.5px] uppercase">read-only</span>
      {/if}
      {#if active.content !== active.savedContent}
        <span class="text-foreground/80">●</span>
      {/if}
      <button
        type="button"
        class="rounded p-1 text-muted-foreground transition hover:bg-[var(--color-surface-2)] hover:text-foreground disabled:opacity-40"
        onclick={save}
        disabled={active.isReadonly || active.content === active.savedContent || active.saving}
        title="Save (Ctrl+S)"
        aria-label="Save"
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
        Binary file — diff not shown.
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
