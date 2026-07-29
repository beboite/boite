<script lang="ts">
  import { app } from "$lib/app/store.svelte";
  import SettingsGeneralTab from "./SettingsGeneralTab.svelte";
  import SettingsTerminalTab from "./SettingsTerminalTab.svelte";
  import SettingsAppearanceTab from "./SettingsAppearanceTab.svelte";
  import SettingsFastpickTab from "./SettingsFastpickTab.svelte";
  import SettingsLogsTab from "./SettingsLogsTab.svelte";
  import X from "@lucide/svelte/icons/x";
  import { t, type MessageKey } from "$lib/i18n/index.svelte";

  type TabId = "general" | "terminal" | "appearance" | "fastpick" | "logs";

  const TABS: { id: TabId; labelKey: MessageKey }[] = [
    { id: "general", labelKey: "tabs.general" },
    { id: "terminal", labelKey: "tabs.terminal" },
    { id: "appearance", labelKey: "tabs.appearance" },
    { id: "fastpick", labelKey: "tabs.fastpick" },
    { id: "logs", labelKey: "tabs.logs" },
  ];

  let activeTab = $state<TabId>("general");

  function close() {
    app.view = "terminal";
    app.mobileTab = "terminal";
  }
</script>

<div class="flex h-full min-h-0 flex-col bg-background">
  <header
    class="flex shrink-0 items-center justify-between border-b border-border bg-[var(--color-surface)] px-4 py-2"
  >
    <h2 class="text-[13px] font-semibold tracking-tight">{t("common.settings")}</h2>
    <button
      type="button"
      class="rounded-md p-1 text-muted-foreground transition hover:bg-accent hover:text-foreground"
      onclick={close}
      aria-label={t("common.closeSettings")}
      title={t("common.backToTerminal")}
    >
      <X class="size-4" />
    </button>
  </header>

  <div class="border-b border-border bg-[var(--color-surface)] px-4">
    <div class="flex gap-0.5" role="tablist">
      {#each TABS as tab (tab.id)}
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === tab.id}
          class="relative -mb-px border-b-2 px-2.5 py-1.5 text-[12px] font-medium transition {activeTab ===
          tab.id
            ? 'border-foreground text-foreground'
            : 'border-transparent text-muted-foreground hover:text-foreground'}"
          onclick={() => (activeTab = tab.id)}
        >
          {t(tab.labelKey)}
        </button>
      {/each}
    </div>
  </div>

  <div class="flex-1 overflow-y-auto px-4 py-3">
    <div class="mx-auto flex max-w-3xl flex-col gap-2.5">
      {#if activeTab === "general"}
        <SettingsGeneralTab />
      {:else if activeTab === "terminal"}
        <SettingsTerminalTab />
      {:else if activeTab === "appearance"}
        <SettingsAppearanceTab />
      {:else if activeTab === "fastpick"}
        <SettingsFastpickTab />
      {:else if activeTab === "logs"}
        <SettingsLogsTab />
      {/if}
    </div>
  </div>

  <footer
    class="flex shrink-0 items-center justify-end border-t border-border bg-[var(--color-surface)] px-4 py-1.5"
  >
    <span class="font-mono text-[11px] text-muted-foreground/60">Boite v{__APP_VERSION__}</span>
  </footer>
</div>
