<script lang="ts">
  import { t } from "$lib/i18n/index.svelte";
  import { openUrl } from "$lib/platform/opener";

  const DOC_URL = "https://github.com/beboite/boite/blob/master/docs/analytics.md";

  type Props = {
    onChoose: (modeB: boolean) => void | Promise<void>;
    busy?: boolean;
  };
  let { onChoose, busy = false }: Props = $props();
</script>

<div class="flex flex-col gap-2">
  <button
    type="button"
    disabled={busy}
    class="rounded-lg border border-border bg-[var(--color-surface-2)] px-4 py-3 text-left transition hover:border-foreground/30 disabled:opacity-60"
    onclick={() => void onChoose(false)}
  >
    <div class="text-sm font-semibold text-foreground">{t("setup.telemetryBasic")}</div>
    <p class="mt-0.5 text-xs leading-relaxed text-muted-foreground">
      {t("setup.telemetryBasicHint")}
    </p>
  </button>
  <button
    type="button"
    disabled={busy}
    class="rounded-lg border border-border bg-[var(--color-surface-2)] px-4 py-3 text-left transition hover:border-foreground/30 disabled:opacity-60"
    onclick={() => void onChoose(true)}
  >
    <div class="text-sm font-semibold text-foreground">{t("setup.telemetryEnhanced")}</div>
    <p class="mt-0.5 text-xs leading-relaxed text-muted-foreground">
      {t("setup.telemetryEnhancedHint")}
    </p>
  </button>
</div>

<button
  type="button"
  class="self-center text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
  onclick={() => void openUrl(DOC_URL)}
>
  {t("setup.telemetryDoc")}
</button>
