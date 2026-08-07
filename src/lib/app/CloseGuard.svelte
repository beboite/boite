<script lang="ts">
  import { onMount } from "svelte";
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import { hasTauri } from "$lib/backend/env";
  import { app } from "$lib/app/store.svelte";
  import { editorStore } from "$lib/features/editor/store.svelte";
  import ConfirmDialog from "$lib/shared/components/ConfirmDialog.svelte";
  import { t } from "$lib/i18n/index.svelte";

  let pendingClose = $state(false);
  let allowClose = false;

  // Any live PTY counts, not just "running": a ready agent with a live
  // process dies just as hard, and running/ready flaps between ticks.
  const busyCount = $derived(app.threads.filter((t) => t.ptyId).length);
  const dirtyCount = $derived(
    editorStore.buffers.filter((b) => editorStore.isDirty(b)).length,
  );

  const message = $derived.by(() => {
    const parts: string[] = [];
    if (busyCount > 0) {
      parts.push(
        busyCount === 1
          ? t("closeGuard.oneThread")
          : t("closeGuard.manyThreads", { count: busyCount }),
      );
    }
    if (dirtyCount > 0) {
      parts.push(
        dirtyCount === 1
          ? t("closeGuard.oneDirty")
          : t("closeGuard.manyDirty", { count: dirtyCount }),
      );
    }
    return parts.join(" ");
  });

  onMount(() => {
    // The OS-window close lifecycle only exists in the desktop shell. In a
    // browser/PWA getCurrentWindow() dereferences window.__TAURI_INTERNALS__,
    // which is undefined, and the throw aborts the boot effect flush (the app
    // stays stuck on "Loading…").
    //
    // "The browser handles its own tab close" was not true of anything: nothing
    // registered a `beforeunload`, so closing the tab took unsaved edits with
    // it in silence. Only the dirty buffers are worth a prompt there. The
    // threads are the server's processes and outlive the tab, which is the
    // whole point of a boite, so counting them would warn about a loss that
    // does not happen.
    if (!hasTauri()) {
      const onBeforeUnload = (event: BeforeUnloadEvent) => {
        if (dirtyCount === 0) return;
        // The text is the browser's, not ours: every engine replaced it with a
        // generic sentence years ago. `preventDefault` is what raises it at all.
        event.preventDefault();
        event.returnValue = "";
      };
      window.addEventListener("beforeunload", onBeforeUnload);
      return () => window.removeEventListener("beforeunload", onBeforeUnload);
    }
    const win = getCurrentWindow();
    const unlisten = win.onCloseRequested((event) => {
      if (allowClose) return;
      if (busyCount === 0 && dirtyCount === 0) return;
      event.preventDefault();
      pendingClose = true;
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  });

  function confirmClose() {
    allowClose = true;
    pendingClose = false;
    void getCurrentWindow().close();
  }

  function cancelClose() {
    pendingClose = false;
  }
</script>

<ConfirmDialog
  open={pendingClose}
  danger
  title={t("closeGuard.title")}
  {message}
  confirmLabel={t("closeGuard.confirmLabel")}
  cancelLabel={t("common.cancel")}
  onConfirm={confirmClose}
  onCancel={cancelClose}
/>
