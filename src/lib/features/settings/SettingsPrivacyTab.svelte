<script lang="ts">
  import { onMount } from "svelte";
  import SettingsCard from "$lib/shared/components/SettingsCard.svelte";
  import ToggleSetting from "$lib/shared/components/ToggleSetting.svelte";
  import { t } from "$lib/i18n/index.svelte";
  import { backend } from "$lib/backend";
  import type { TelemetryState } from "$lib/backend/types";
  import { notifications } from "$lib/features/notifications/store.svelte";
  import { writeText } from "$lib/platform/clipboard";
  import { openUrl } from "$lib/platform/opener";

  const DOC_URL = "https://github.com/beboite/boite/blob/master/docs/analytics.md";

  let telemetry = $state<TelemetryState | null>(null);
  let loadFailed = $state(false);
  let modeBBusy = $state(false);
  let exportBusy = $state(false);
  let forgetBusy = $state(false);

  async function refresh() {
    try {
      telemetry = await backend().telemetry.state();
      loadFailed = false;
    } catch {
      loadFailed = true;
    }
  }

  onMount(() => {
    void refresh();
  });

  async function toggleModeA() {
    if (!telemetry) return;
    const next = !telemetry.modeAEnabled;
    telemetry = { ...telemetry, modeAEnabled: next };
    try {
      await backend().telemetry.setModeA(next);
      await refresh();
    } catch (e) {
      await refresh();
      if (next) {
        notifications.error(t("privacy.enableFailed", { error: String(e) }));
      } else {
        notifications.error(t("privacy.disableFailed", { error: String(e) }));
      }
    }
  }

  async function toggleModeB() {
    if (!telemetry || modeBBusy) return;
    const next = !telemetry.modeBEnabled;
    modeBBusy = true;
    try {
      await backend().telemetry.setModeB(next);
      await refresh();
    } catch (e) {
      await refresh();
      if (next) {
        notifications.error(t("privacy.enableFailed", { error: String(e) }));
      } else {
        notifications.error(t("privacy.disableFailed", { error: String(e) }));
      }
    } finally {
      modeBBusy = false;
    }
  }

  async function exportEvents() {
    if (exportBusy) return;
    exportBusy = true;
    try {
      const payload = await backend().telemetry.export();
      await writeText(JSON.stringify(payload, null, 2));
      notifications.success(t("privacy.exportCopied"));
    } catch (e) {
      const message = String(e);
      notifications.error(
        message.includes("mode_b_disabled")
          ? t("privacy.exportNeedB")
          : message.includes("telemetry_inert")
            ? t("privacy.inert")
            : t("privacy.exportFailed", { error: message }),
      );
    } finally {
      exportBusy = false;
    }
  }

  async function retryForget() {
    if (forgetBusy) return;
    forgetBusy = true;
    try {
      await backend().telemetry.retryForget();
      await refresh();
    } catch (e) {
      const message = String(e);
      notifications.error(
        message.includes("telemetry_inert")
          ? t("privacy.inert")
          : t("privacy.forgetFailed", { error: message }),
      );
    } finally {
      forgetBusy = false;
    }
  }
</script>

{#if loadFailed}
  <p class="px-1 text-xs text-muted-foreground">{t("privacy.loadFailed")}</p>
{:else if telemetry}
  <SettingsCard title={t("privacy.stop")} anchor="privacy.stop" description={t("privacy.stopDesc")}>
    <ToggleSetting
      label={t("privacy.modeA")}
      anchor="privacy.modeA"
      description={t("privacy.modeADesc")}
      enabled={telemetry.modeAEnabled}
      onToggle={() => void toggleModeA()}
    />
  </SettingsCard>
  <ToggleSetting
    label={t("privacy.modeB")}
    anchor="privacy.modeB"
    description={t("privacy.modeBDesc")}
    enabled={telemetry.modeBEnabled}
    onToggle={() => void toggleModeB()}
  />
  <SettingsCard title={t("privacy.data")} anchor="privacy.data" description={t("privacy.dataDesc")}>
    <div class="flex flex-wrap gap-2">
      <button
        type="button"
        disabled={exportBusy || (!telemetry.installIdSet && !telemetry.forgetPending)}
        class="rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-foreground transition hover:border-foreground/30 disabled:opacity-50"
        onclick={() => void exportEvents()}
      >
        {t("privacy.exportAction")}
      </button>
      {#if telemetry.forgetPending}
        <button
          type="button"
          disabled={forgetBusy}
          class="rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-foreground transition hover:border-foreground/30 disabled:opacity-50"
          onclick={() => void retryForget()}
        >
          {t("privacy.forgetRetry")}
        </button>
      {/if}
    </div>
    {#if telemetry.forgetPending}
      <p class="mt-2 text-xs text-muted-foreground">{t("privacy.forgetPending")}</p>
    {/if}
  </SettingsCard>
{/if}

<SettingsCard title={t("privacy.doc")} anchor="privacy.doc" description={t("privacy.docDesc")}>
  <button
    type="button"
    class="rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-foreground transition hover:border-foreground/30"
    onclick={() => void openUrl(DOC_URL)}
  >
    {t("privacy.docLink")}
  </button>
</SettingsCard>
