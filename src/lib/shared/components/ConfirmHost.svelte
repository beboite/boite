<script lang="ts">
  import ConfirmDialog from "./ConfirmDialog.svelte";
  import { confirmDialog } from "./confirm.svelte";
  import { t } from "$lib/i18n/index.svelte";
</script>

{#if confirmDialog.pending}
  <ConfirmDialog
    open={true}
    title={confirmDialog.pending.title}
    message={confirmDialog.pending.message ?? ""}
    confirmLabel={confirmDialog.pending.confirmLabel ?? t("common.confirm")}
    cancelLabel={confirmDialog.pending.cancelLabel ?? t("common.cancel")}
    danger={confirmDialog.pending.danger ?? false}
    onConfirm={() => confirmDialog.settle(true)}
    onCancel={() => confirmDialog.settle(false)}
  />
{/if}
