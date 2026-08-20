<script lang="ts">
  import { updater } from "./store.svelte";
  import { tip } from "$lib/shared/actions/tooltip";
  import { t } from "$lib/i18n/index.svelte";

  // Only surfaces once the payload is on disk. Anything earlier would offer a
  // restart that still has to wait on the network.
  const version = $derived(updater.readyVersion);
  const installing = $derived(updater.status.kind === "installing");
</script>

{#if version}
  <button
    type="button"
    class="update-btn"
    onclick={() => updater.install()}
    disabled={installing}
    use:tip={t("updater.readyTooltip", { version })}
    aria-label={t("updater.restartLabel", { version })}
  >
    {installing ? t("updater.ctaInstalling") : t("updater.ctaAvailable")}
  </button>
{/if}

<style>
  /* Lifted from accshift's titlebar CTA: a pill that sits on the bar instead
     of inverting it. color-mix against the live tokens so every theme keeps
     the same mix ratios. */
  .update-btn {
    height: 1.5rem;
    border: 1px solid color-mix(in srgb, var(--color-foreground) 25%, var(--color-border));
    border-radius: 999px;
    background: color-mix(in srgb, var(--color-surface-2) 92%, var(--color-foreground) 8%);
    color: var(--color-foreground);
    font-size: var(--text-xs);
    font-weight: 600;
    line-height: 1;
    padding: 0 0.625rem;
    cursor: pointer;
    transition: background 120ms ease-out, opacity 120ms ease-out;
  }

  .update-btn:hover:not(:disabled) {
    background: color-mix(in srgb, var(--color-surface-2) 70%, var(--color-foreground) 30%);
  }

  .update-btn:disabled {
    opacity: 0.6;
    cursor: default;
  }
</style>
