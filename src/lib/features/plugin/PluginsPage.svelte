<!--
  Plugins, a page rather than a settings tab.

  #197 folded them into settings > agents, next to the CLI list, on the
  reasoning that both answer "what can this machine run". True of the toggle,
  false of everything around it: a plugin is found, installed and pointed at an
  account, and a form three clicks deep behind a gear is where a checkbox goes,
  not where that starts. The CLI list keeps the settings page; what is bolted on
  from outside gets a door of its own.
-->
<script lang="ts">
  import { app } from "$lib/app/store.svelte";
  import Button from "$lib/shared/components/Button.svelte";
  import FastpickSettingsCard from "$lib/features/settings/FastpickSettingsCard.svelte";
  import KebaccSwitcherCard from "./KebaccSwitcherCard.svelte";
  import CodexSwitcherCard from "./CodexSwitcherCard.svelte";
  import FastMcpSshCard from "./FastMcpSshCard.svelte";
  import { t } from "$lib/i18n/index.svelte";

  // The anchors outlive the settings search that named them: the ids they draw
  // are what a deep link into a card still lands on.
  function close() {
    app.view = "terminal";
    app.mobileTab = "terminal";
  }
</script>

<div class="flex h-full min-h-0 flex-col">
  <header class="flex h-9 shrink-0 items-center gap-1.5 border-b border-border px-3">
    <span class="truncate text-xs font-medium text-foreground">{t("plugins.title")}</span>
    <span class="truncate text-sm text-muted-2">{t("plugins.description")}</span>
    <span class="flex-1"></span>
    <Button variant="ghost" onclick={close}>{t("common.close")}</Button>
  </header>

  <div class="min-h-0 flex-1 scroll-pane overflow-y-auto px-4 py-4">
    <div class="mx-auto flex max-w-3xl flex-col gap-2.5">
      <FastpickSettingsCard anchor="fastpick.settingsTitle" enableAnchor="fastpick.enable" />
      <KebaccSwitcherCard
        anchor="plugin.kebaccTitle"
        claudeAnchor="plugin.kebaccClaude"
        codexAnchor="plugin.kebaccCodex"
        antigravityAnchor="plugin.kebaccAntigravity"
      />
      <CodexSwitcherCard anchor="plugin.codexTitle" />
      <FastMcpSshCard anchor="plugin.fastMcpSshTitle" />
    </div>
  </div>
</div>
