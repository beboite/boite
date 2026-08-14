<script lang="ts">
  import { onMount } from "svelte";
  import ShortcutEditor from "$lib/features/settings/ShortcutEditor.svelte";
  import SettingsCard from "$lib/shared/components/SettingsCard.svelte";
  import { enablePush, pushPermission, pushSupported } from "$lib/features/push/api";
  import { t } from "$lib/i18n/index.svelte";

  // Updates moved to About, with the version they are about.

  // Web Push only exists in a browser/PWA; the desktop notifies through the OS.
  const showPush = pushSupported();

  // Notification.permission is a plain property with no change event, so it is
  // mirrored into state and re-read after the prompt settles.
  let permission = $state<NotificationPermission | "unsupported">("unsupported");
  let asking = $state(false);

  onMount(() => {
    permission = pushPermission();
  });

  async function ask() {
    if (asking) return;
    asking = true;
    try {
      permission = await enablePush();
    } finally {
      asking = false;
    }
  }
</script>

{#if showPush}
  <SettingsCard title={t("general.pushTitle")} anchor="general.pushTitle" description={t("general.pushDesc")}>
    {#if permission === "granted"}
      <p class="text-sm text-[var(--color-success)]">{t("general.pushEnabled")}</p>
    {:else if permission === "denied"}
      <!-- A denial cannot be undone from script: only the browser's own site
           settings can, which is why this says so rather than offering a button
           that would do nothing. -->
      <p class="text-sm text-warning">{t("general.pushBlocked")}</p>
    {:else if permission === "unsupported"}
      <p class="text-sm text-muted-foreground/80">{t("general.pushUnsupported")}</p>
    {:else}
      <button
        type="button"
        disabled={asking}
        class="rounded-md border border-border bg-[var(--color-surface-2)] px-3 py-1.5 text-sm text-foreground transition hover:bg-[var(--color-surface-3)] disabled:opacity-50"
        onclick={ask}
      >
        {t("general.pushEnable")}
      </button>
    {/if}
  </SettingsCard>
{/if}

<SettingsCard title={t("shortcuts.title")} anchor="shortcuts.title" description={t("shortcuts.description")}>
  <ShortcutEditor />
</SettingsCard>
