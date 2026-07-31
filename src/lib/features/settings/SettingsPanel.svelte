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
  let stripEl: HTMLDivElement | null = $state(null);

  function close() {
    app.view = "terminal";
    app.mobileTab = "terminal";
  }

  const tabId = (id: TabId) => `settings-tab-${id}`;
  // One panel element for the five tabs, because that is what the DOM does: the
  // container stays and its contents are swapped. Five ids would mean four
  // aria-controls pointing at nothing.
  const PANEL_ID = "settings-panel";

  // Selection follows focus: every panel is a plain form, so arriving on a tab
  // and showing it are the same act, and Tab then leads straight into the
  // controls rather than back into the strip.
  function moveTo(index: number) {
    const next = TABS[(index + TABS.length) % TABS.length];
    activeTab = next.id;
    stripEl?.querySelector<HTMLElement>(`#${tabId(next.id)}`)?.focus();
  }

  function onStripKeydown(e: KeyboardEvent) {
    const at = TABS.findIndex((tab) => tab.id === activeTab);
    if (e.key === "ArrowRight") {
      e.preventDefault();
      moveTo(at + 1);
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      moveTo(at - 1);
    } else if (e.key === "Home") {
      e.preventDefault();
      moveTo(0);
    } else if (e.key === "End") {
      e.preventDefault();
      moveTo(TABS.length - 1);
    }
  }
</script>

<div class="flex h-full min-h-0 flex-col bg-background">
  <header
    class="flex shrink-0 items-center justify-between border-b border-border bg-[var(--color-surface)] px-4 py-2"
  >
    <h2 class="text-base font-semibold tracking-tight">{t("common.settings")}</h2>
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
    <div
      bind:this={stripEl}
      class="flex gap-0.5"
      role="tablist"
      aria-label={t("common.settings")}
    >
      {#each TABS as tab (tab.id)}
        <button
          type="button"
          role="tab"
          id={tabId(tab.id)}
          aria-selected={activeTab === tab.id}
          aria-controls={PANEL_ID}
          tabindex={activeTab === tab.id ? 0 : -1}
          class="relative -mb-px border-b-2 px-2.5 py-1.5 text-sm font-medium transition {activeTab ===
          tab.id
            ? 'border-foreground text-foreground'
            : 'border-transparent text-muted-foreground hover:text-foreground'}"
          onclick={() => (activeTab = tab.id)}
          onkeydown={onStripKeydown}
        >
          {t(tab.labelKey)}
        </button>
      {/each}
    </div>
  </div>

  <!-- tabindex on a panel that already holds focusable controls, because this one
       is also the scroll container: without it the wheel is the only way down. -->
  <div
    id={PANEL_ID}
    role="tabpanel"
    aria-labelledby={tabId(activeTab)}
    tabindex="0"
    class="flex-1 overflow-y-auto px-4 py-3"
  >
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
    <span class="font-mono text-xs text-muted-foreground/60"
      >{t("settings.version", { version: __APP_VERSION__ })}</span
    >
  </footer>
</div>
