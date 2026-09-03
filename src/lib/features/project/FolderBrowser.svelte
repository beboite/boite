<script lang="ts">
  import { tick } from "svelte";
  import { folderBrowser } from "./folderBrowserStore.svelte";
  import { workspace } from "$lib/backend";
  import { addProjectByPath } from "./api";
  import { t } from "$lib/i18n/index.svelte";
  import { restoreFocus } from "$lib/shared/keyboard/overlay";
  import type { DirEntry } from "$lib/features/explorer/api";

  // This modal always browses the boite's filesystem: in pure remote mode
  // that's the active backend, in dynamic mode it's explicitly the remote one.
  const be = () => workspace.backendFor("remote");

  let root = $state<string | null>(null);
  let path = $state<string>("");
  let entries = $state<DirEntry[]>([]);
  let loading = $state(false);
  let err = $state<string | null>(null);
  let busy = $state(false);
  let started = false;
  let panelEl = $state<HTMLDivElement | null>(null);
  let addBtn = $state<HTMLButtonElement | null>(null);

  // Same shape as ConfirmDialog: without this the dialog opens with the keyboard
  // still on the row behind it, and closing drops focus on <body>.
  $effect(() => {
    if (!folderBrowser.open) return;
    const previous = document.activeElement as HTMLElement | null;
    const surface = panelEl;
    // The primary action, unless it is still disabled because the listing has
    // not landed yet: focusing a disabled button focuses nothing at all.
    const target = addBtn && !addBtn.disabled ? addBtn : panelEl;
    target?.focus();
    return () => restoreFocus(previous, surface);
  });

  // Walking into a folder destroys the row that was clicked, so without this the
  // keyboard sits on <body> until the next Tab.
  $effect(() => {
    if (!folderBrowser.open) return;
    void entries;
    let cancelled = false;
    void tick().then(() => {
      if (cancelled || !folderBrowser.open) return;
      if (panelEl?.contains(document.activeElement)) return;
      panelEl?.focus();
    });
    return () => {
      cancelled = true;
    };
  });

  function focusables(): HTMLElement[] {
    return Array.from(
      panelEl?.querySelectorAll<HTMLElement>("button:not(:disabled)") ?? [],
    );
  }

  // On the window, like ConfirmDialog, not on the dialog element: walking into a
  // folder replaces the whole list, so the row that was clicked is gone and
  // focus falls on <body>, from where nothing bubbles through the dialog. The
  // layout's dispatcher leaves Escape alone while an aria-modal dialog is up.
  function onKeydown(e: KeyboardEvent) {
    if (!folderBrowser.open) return;
    if (e.key === "Escape") {
      // Stopped here: one press closes this dialog and nothing else.
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    if (e.key !== "Tab") return;
    const all = focusables();
    if (all.length === 0) return;
    const idx = all.indexOf(document.activeElement as HTMLElement);
    e.preventDefault();
    if (idx < 0) {
      all[e.shiftKey ? all.length - 1 : 0].focus();
      return;
    }
    all[(idx + (e.shiftKey ? -1 : 1) + all.length) % all.length].focus();
  }

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
    root = await be().scope.workspaceRoot().catch(() => null);
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
      const list = await be().explorer.readDir(p);
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
    // A caller that asked for a folder gets the folder; nobody else's job
    // changed, so the default is still "add a project here".
    const pick = folderBrowser.onPick;
    if (pick) {
      try {
        await pick(path);
      } finally {
        busy = false;
      }
      folderBrowser.close();
      return;
    }
    const p = await addProjectByPath(path, "remote");
    busy = false;
    if (p) folderBrowser.close();
  }

  function close() {
    folderBrowser.close();
  }
</script>

<svelte:window onkeydown={onKeydown} />

{#if folderBrowser.open}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div
    class="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center bg-[var(--color-scrim)] backdrop-blur-sm p-6"
    role="dialog"
    aria-modal="true"
    aria-labelledby="folder-browser-title"
    tabindex="-1"
    onclick={(e) => {
      if (e.target === e.currentTarget) close();
    }}
  >
    <div
      bind:this={panelEl}
      tabindex="-1"
      class="surface-dialog flex max-h-[70vh] w-full max-w-md flex-col outline-none"
    >
      <div class="flex items-center justify-between border-b border-border px-3 py-2">
        <span id="folder-browser-title" class="text-xs font-medium text-foreground">
          {t("folderBrowser.title")}
        </span>
        <button
          type="button"
          class="text-muted-foreground transition hover:text-foreground"
          onclick={close}
          aria-label={t("titlebar.close")}>✕</button
        >
      </div>

      {#if !root}
        <p class="p-4 text-sm text-muted-foreground">
          {t("folderBrowser.noWorkspaceDir", { variable: "BOITE_WORKSPACE_DIR" })}
        </p>
      {:else}
        <div class="flex items-center gap-2 border-b border-border px-3 py-1.5">
          <button
            type="button"
            class="rounded px-1.5 py-0.5 text-sm text-muted-foreground transition hover:text-foreground disabled:opacity-40"
            onclick={up}
            disabled={path === root}>↑ {t("folderBrowser.up")}</button
          >
          <span class="min-w-0 truncate text-sm text-muted-foreground">{path}</span>
        </div>

        <div class="min-h-0 flex-1 overflow-auto p-1">
          {#if loading}
            <p class="p-3 text-sm text-muted-2">{t("common.loading")}</p>
          {:else if err}
            <p class="p-3 text-sm text-danger">{err}</p>
          {:else if entries.length === 0}
            <p class="p-3 text-sm text-muted-2">
              {t("folderBrowser.noSubfolders")}
            </p>
          {:else}
            {#each entries as e (e.path)}
              <button
                type="button"
                class="flex w-full min-w-0 items-center gap-2 rounded px-2 py-1 text-left text-sm text-foreground transition hover:bg-[var(--color-surface-2)]"
                onclick={() => go(e.path)}
              >
                <span class="text-muted-2">▸</span>
                <span class="min-w-0 truncate">{e.name}</span>
              </button>
            {/each}
          {/if}
        </div>

        <div class="flex justify-end gap-2 border-t border-border px-3 py-2">
          <button
            type="button"
            class="rounded px-2 py-1 text-sm text-muted-foreground transition hover:text-foreground"
            onclick={close}
            disabled={busy}>{t("common.cancel")}</button
          >
          <button
            type="button"
            bind:this={addBtn}
            class="rounded bg-foreground px-2.5 py-1 text-sm font-medium text-background transition hover:bg-foreground/90 disabled:opacity-50"
            onclick={addHere}
            disabled={busy || !path}
          >
            {busy
              ? t("folderBrowser.adding")
              : folderBrowser.onPick
                ? t("folderBrowser.useThisFolder")
                : t("folderBrowser.addThisFolder")}
          </button>
        </div>
      {/if}
    </div>
  </div>
{/if}
