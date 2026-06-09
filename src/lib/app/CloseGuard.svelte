<script lang="ts">
  import { onMount } from "svelte";
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import { app } from "$lib/app/store.svelte";
  import ConfirmDialog from "$lib/shared/components/ConfirmDialog.svelte";

  let pendingClose = $state(false);
  let allowClose = false;

  const busyCount = $derived(
    app.threads.filter((t) => t.ptyId && t.status === "running").length,
  );

  onMount(() => {
    const win = getCurrentWindow();
    const unlisten = win.onCloseRequested((event) => {
      if (allowClose) return;
      if (busyCount === 0) return;
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
  title="Des threads travaillent encore"
  message={busyCount === 1
    ? "1 thread tourne encore. Fermer l'application va tuer son process."
    : `${busyCount} threads tournent encore. Fermer l'application va tuer leurs process.`}
  confirmLabel="Fermer quand même"
  cancelLabel="Annuler"
  onConfirm={confirmClose}
  onCancel={cancelClose}
/>
