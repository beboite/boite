<script lang="ts">
  import ConfirmDialog from "./ConfirmDialog.svelte";
  import { confirmDialog } from "./confirm.svelte";
</script>

{#if confirmDialog.pending}
  <ConfirmDialog
    open={true}
    title={confirmDialog.pending.title}
    message={confirmDialog.pending.message ?? ""}
    confirmLabel={confirmDialog.pending.confirmLabel ?? "Confirm"}
    cancelLabel={confirmDialog.pending.cancelLabel ?? "Cancel"}
    danger={confirmDialog.pending.danger ?? false}
    onConfirm={() => confirmDialog.settle(true)}
    onCancel={() => confirmDialog.settle(false)}
  />
{/if}
