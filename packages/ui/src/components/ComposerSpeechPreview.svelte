<script lang="ts">
  let { status, preview, error }: { status: string; preview: string; error: boolean } = $props();
</script>

{#if status}
  <div class="speech-preview" class:error data-testid="dictation-preview">
    <span class="speech-status" role={error ? 'alert' : 'status'}>{status}</span>
    {#if preview}<p aria-live="polite" aria-atomic="true">{preview}</p>{/if}
  </div>
{/if}

<style>
  .speech-preview { padding: 0 14px 6px; min-width: 0; }
  .speech-status { font-size: var(--text-xs); color: var(--color-muted-foreground); }
  .speech-preview.error .speech-status { color: var(--color-danger); }
  .speech-preview p { margin: 2px 0 0; font-size: var(--text-sm); line-height: 1.5; color: var(--color-foreground); overflow-wrap: anywhere; max-height: 3em; overflow-y: auto; }

  @media (max-width: 720px) {
    .speech-preview { padding: 0 16px 8px; }
    .speech-status { color: var(--color-accent); }
  }
</style>
