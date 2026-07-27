<script lang="ts">
  import ShortcutEditor from "$lib/features/settings/ShortcutEditor.svelte";
  import SettingsCard from "$lib/shared/components/SettingsCard.svelte";
  import UpdatesCard from "$lib/features/updater/UpdatesCard.svelte";
  import { hasTauri } from "$lib/backend/env";
  import { t } from "$lib/i18n/index.svelte";

  // Nothing to update in a browser tab: the page is whatever the server last
  // served.
  const canUpdate = hasTauri();
</script>

{#if canUpdate}
  <UpdatesCard />
{/if}

<SettingsCard title={t("shortcuts.title")} description={t("shortcuts.description")}>
  <ShortcutEditor />
</SettingsCard>
