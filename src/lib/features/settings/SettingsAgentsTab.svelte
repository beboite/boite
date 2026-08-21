<!--
  The agents page: the CLIs on the machine.

  It held the plugin cards too until they moved to `PluginsPage.svelte`. What
  stays is the install list, and one row saying where the rest went, because a
  user who learned the toggles were here would otherwise read the shorter page
  as a removal.
-->
<script lang="ts">
  import { app } from "$lib/app/store.svelte";
  import CliManagerSection from "./CliManagerSection.svelte";
  import SettingsCard from "$lib/shared/components/SettingsCard.svelte";
  import Button from "$lib/shared/components/Button.svelte";
  import { t } from "$lib/i18n/index.svelte";

  function openPlugins() {
    app.view = "plugins";
  }
</script>

<CliManagerSection />

<SettingsCard
  title={t("plugins.title")}
  anchor="plugins.title"
  description={t("plugins.movedDesc")}
>
  <div class="flex">
    <Button onclick={openPlugins}>{t("plugins.open")}</Button>
  </div>
</SettingsCard>
