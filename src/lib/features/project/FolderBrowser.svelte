<script lang="ts">
  import { folderBrowser } from "./folderBrowserStore.svelte";
  import { backend } from "$lib/backend";
  import { addProjectByPath } from "./api";
  import type { DirEntry } from "$lib/features/explorer/api";

  let root = $state<string | null>(null);
  let path = $state<string>("");
  let entries = $state<DirEntry[]>([]);
  let loading = $state(false);
  let err = $state<string | null>(null);
  let busy = $state(false);
  let started = false;

  // Lazily start browsing the first time the modal opens.
  $effect(() => {
    if (folderBrowser.open && !started) {
      started = true;
      void start();
    }
    if (!folderBrowser.open) started = false;
  });

  async function start() {
    err = null;
    root = await backend().scope.workspaceRoot().catch(() => null);
    if (!root) {
      entries = [];
      path = "";
      return;
    }
    await go(root);
  }

  async function go(p: string) {
    loading = true;
    err = null;
    try {
      const list = await backend().explorer.readDir(p);
      entries = list
        .filter((e) => e.isDir && !e.isHidden)
        .sort((a, b) => a.name.localeCompare(b.name));
      path = p;
    } catch (e) {
      err = String(e);
    } finally {
      loading = false;
    }
  }

  function up() {
    if (!root || path === root) return;
    const parent = path.replace(/\/+[^/]+\/*$/, "");
    void go(parent.length >= root.length && parent.startsWith(root) ? parent : root);
  }

  async function addHere() {
    if (busy || !path) return;
    busy = true;
    const p = await addProjectByPath(path);
    busy = false;
    if (p) folderBrowser.open = false;
  }

  function close() {
    folderBrowser.open = false;
  }
</script>

{#if folderBrowser.open}
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6"
    role="dialog"
    aria-modal="true"
    tabindex="-1"
    onclick={(e) => {
      if (e.target === e.currentTarget) close();
    }}
    onkeydown={(e) => {
      if (e.key === "Escape") close();
    }}
  >
    <div
      class="flex max-h-[70vh] w-full max-w-md flex-col rounded-lg border border-border bg-[var(--color-surface)] shadow-xl"
    >
      <div class="flex items-center justify-between border-b border-border px-3 py-2">
        <span class="text-xs font-medium text-foreground">Add a project folder</span>
        <button
          class="text-muted-foreground transition hover:text-foreground"
          onclick={close}
          aria-label="Close">✕</button
        >
      </div>

      {#if !root}
        <p class="p-4 text-xs text-muted-foreground">
          This server has no browsable workspace directory. Set
          <code class="font-mono">BOITE_WORKSPACE_DIR</code> to enable the folder picker.
        </p>
      {:else}
        <div class="flex items-center gap-2 border-b border-border px-3 py-1.5">
          <button
            class="rounded px-1.5 py-0.5 text-xs text-muted-foreground transition hover:text-foreground disabled:opacity-40"
            onclick={up}
            disabled={path === root}>↑ Up</button
          >
          <span class="truncate font-mono text-[11px] text-muted-foreground">{path}</span>
        </div>

        <div class="min-h-0 flex-1 overflow-auto p-1">
          {#if loading}
            <p class="p-3 text-xs text-muted-foreground/60">Loading…</p>
          {:else if err}
            <p class="p-3 text-xs text-danger">{err}</p>
          {:else if entries.length === 0}
            <p class="p-3 text-xs text-muted-foreground/60">No subfolders here.</p>
          {:else}
            {#each entries as e (e.path)}
              <button
                class="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs text-foreground transition hover:bg-[var(--color-surface-2)]"
                onclick={() => go(e.path)}
              >
                <span class="text-muted-foreground/60">▸</span>
                {e.name}
              </button>
            {/each}
          {/if}
        </div>

        <div class="flex justify-end gap-2 border-t border-border px-3 py-2">
          <button
            class="rounded px-2 py-1 text-xs text-muted-foreground transition hover:text-foreground"
            onclick={close}
            disabled={busy}>Cancel</button
          >
          <button
            class="rounded bg-foreground px-2.5 py-1 text-xs font-medium text-background transition hover:bg-foreground/90 disabled:opacity-50"
            onclick={addHere}
            disabled={busy || !path}
          >
            {busy ? "Adding…" : "Add this folder"}
          </button>
        </div>
      {/if}
    </div>
  </div>
{/if}
