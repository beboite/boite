<script lang="ts">
  import { app } from "$lib/app/store.svelte";
  import SettingsGeneralTab from "./SettingsGeneralTab.svelte";
  import SettingsTerminalTab from "./SettingsTerminalTab.svelte";
  import SettingsAppearanceTab from "./SettingsAppearanceTab.svelte";
  import SettingsFastpickTab from "./SettingsFastpickTab.svelte";
  import SettingsLogsTab from "./SettingsLogsTab.svelte";
  import SettingsAboutTab from "./SettingsAboutTab.svelte";
  import { updater } from "$lib/features/updater/store.svelte";
  import X from "@lucide/svelte/icons/x";
  import SlidersHorizontal from "@lucide/svelte/icons/sliders-horizontal";
  import TerminalIcon from "@lucide/svelte/icons/terminal";
  import Palette from "@lucide/svelte/icons/palette";
  import Zap from "@lucide/svelte/icons/zap";
  import ScrollText from "@lucide/svelte/icons/scroll-text";
  import Info from "@lucide/svelte/icons/info";
  import type { Component } from "svelte";
  import { t, type MessageKey } from "$lib/i18n/index.svelte";

  /**
   * The settings, as a rail and a page rather than a strip and a form.
   *
   * Six tabs across the top of a full-screen panel put the navigation on one
   * line and left the other 900 pixels of width empty, with nothing on any
   * screen saying what it was for. The rail names each section next to an icon,
   * and each page opens with what it is about — the same two facts the strip
   * asked the user to already know.
   *
   * The strip survives under the rail's breakpoint, where a phone has no width
   * to spend on it.
   */
  type TabId = "general" | "terminal" | "appearance" | "fastpick" | "logs" | "about";

  const TABS: {
    id: TabId;
    labelKey: MessageKey;
    hintKey: MessageKey;
    icon: Component;
  }[] = [
    {
      id: "general",
      labelKey: "tabs.general",
      hintKey: "tabs.generalHint",
      icon: SlidersHorizontal,
    },
    {
      id: "terminal",
      labelKey: "tabs.terminal",
      hintKey: "tabs.terminalHint",
      icon: TerminalIcon,
    },
    {
      id: "appearance",
      labelKey: "tabs.appearance",
      hintKey: "tabs.appearanceHint",
      icon: Palette,
    },
    { id: "fastpick", labelKey: "tabs.fastpick", hintKey: "tabs.fastpickHint", icon: Zap },
    { id: "logs", labelKey: "tabs.logs", hintKey: "tabs.logsHint", icon: ScrollText },
    { id: "about", labelKey: "tabs.about", hintKey: "tabs.aboutHint", icon: Info },
  ];

  let activeTab = $state<TabId>("general");
  let railEl: HTMLElement | null = $state(null);
  let stripEl: HTMLElement | null = $state(null);

  const current = $derived(TABS.find((tab) => tab.id === activeTab) ?? TABS[0]);

  // Arriving on About asks whether there is a newer build, the way opening
  // Chrome's about page does. Selection follows focus in this rail, so arrowing
  // down the list lands on About in passing; the floor inside `checkOnOpen` is
  // what keeps that from being a network check per keypress.
  $effect(() => {
    if (activeTab === "about") updater.checkOnOpen();
  });

  function close() {
    app.view = "terminal";
    app.mobileTab = "terminal";
  }

  const tabId = (id: TabId, place: "rail" | "strip") => `settings-tab-${place}-${id}`;
  // One panel element for the six tabs, because that is what the DOM does: the
  // container stays and its contents are swapped. Six ids would mean five
  // aria-controls pointing at nothing.
  const PANEL_ID = "settings-panel";

  // Selection follows focus: every panel is a plain form, so arriving on a tab
  // and showing it are the same act, and Tab then leads straight into the
  // controls rather than back into the navigation.
  function moveTo(index: number, place: "rail" | "strip") {
    const next = TABS[(index + TABS.length) % TABS.length];
    activeTab = next.id;
    const host = place === "rail" ? railEl : stripEl;
    host?.querySelector<HTMLElement>(`#${tabId(next.id, place)}`)?.focus();
  }

  function onKeydown(e: KeyboardEvent, place: "rail" | "strip") {
    const at = TABS.findIndex((tab) => tab.id === activeTab);
    // The rail runs down and the strip runs across, so each one answers the
    // arrows that point along it. Both keep Home and End.
    const forward = place === "rail" ? "ArrowDown" : "ArrowRight";
    const back = place === "rail" ? "ArrowUp" : "ArrowLeft";
    if (e.key === forward) {
      e.preventDefault();
      moveTo(at + 1, place);
    } else if (e.key === back) {
      e.preventDefault();
      moveTo(at - 1, place);
    } else if (e.key === "Home") {
      e.preventDefault();
      moveTo(0, place);
    } else if (e.key === "End") {
      e.preventDefault();
      moveTo(TABS.length - 1, place);
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

  <!-- Under the rail's breakpoint: the same six, across, scrolling. -->
  <div class="shrink-0 border-b border-border bg-[var(--color-surface)] px-3 md:hidden">
    <div
      bind:this={stripEl}
      class="hide-scrollbar flex gap-0.5 overflow-x-auto"
      role="tablist"
      aria-label={t("common.settings")}
    >
      {#each TABS as tab (tab.id)}
        <button
          type="button"
          role="tab"
          id={tabId(tab.id, "strip")}
          aria-selected={activeTab === tab.id}
          aria-controls={PANEL_ID}
          tabindex={activeTab === tab.id ? 0 : -1}
          class="relative -mb-px shrink-0 border-b-2 px-2.5 py-1.5 text-sm font-medium transition {activeTab ===
          tab.id
            ? 'border-foreground text-foreground'
            : 'border-transparent text-muted-foreground hover:text-foreground'}"
          onclick={() => (activeTab = tab.id)}
          onkeydown={(e) => onKeydown(e, "strip")}
        >
          {t(tab.labelKey)}
        </button>
      {/each}
    </div>
  </div>

  <div class="flex min-h-0 flex-1">
    <!-- A div, not a <nav>: `tablist` is the role, and putting it on a landmark
         is the one combination the a11y rules refuse. -->
    <div
      bind:this={railEl}
      class="hidden w-52 shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-border bg-[var(--color-surface)] p-2 md:flex"
      role="tablist"
      aria-orientation="vertical"
      aria-label={t("common.settings")}
    >
      {#each TABS as tab (tab.id)}
        {@const TabIcon = tab.icon}
        <button
          type="button"
          role="tab"
          id={tabId(tab.id, "rail")}
          aria-selected={activeTab === tab.id}
          aria-controls={PANEL_ID}
          tabindex={activeTab === tab.id ? 0 : -1}
          class="flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-sm font-medium transition {activeTab ===
          tab.id
            ? 'bg-[var(--color-surface-3)] text-foreground'
            : 'text-muted-foreground hover:bg-accent hover:text-foreground'}"
          onclick={() => (activeTab = tab.id)}
          onkeydown={(e) => onKeydown(e, "rail")}
        >
          <TabIcon class="size-3.5 shrink-0" />
          <span class="truncate">{t(tab.labelKey)}</span>
        </button>
      {/each}
    </div>

    <!-- tabindex on a panel that already holds focusable controls, because this
         one is also the scroll container: without it the wheel is the only way
         down. -->
    <div
      id={PANEL_ID}
      role="tabpanel"
      aria-labelledby={tabId(activeTab, "rail")}
      tabindex="0"
      class="min-w-0 flex-1 overflow-y-auto px-4 py-4"
    >
      <div class="mx-auto flex max-w-3xl flex-col gap-2.5">
        <div class="mb-1">
          <h3 class="text-md font-semibold tracking-tight text-foreground">
            {t(current.labelKey)}
          </h3>
          <p class="mt-0.5 text-sm text-muted-foreground">{t(current.hintKey)}</p>
        </div>

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
        {:else if activeTab === "about"}
          <SettingsAboutTab />
        {/if}
      </div>
    </div>
  </div>
</div>
