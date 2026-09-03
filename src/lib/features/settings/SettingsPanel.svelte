<script lang="ts">
  import { app } from "$lib/app/store.svelte";
  import { workspace } from "$lib/backend";
  import { tip } from "$lib/shared/actions/tooltip";
  import { edgeFade } from "$lib/shared/actions/edgeFade";
  import SettingsGeneralTab from "./SettingsGeneralTab.svelte";
  import SettingsTerminalTab from "./SettingsTerminalTab.svelte";
  import SettingsAppearanceTab from "./SettingsAppearanceTab.svelte";
  import SettingsAgentsTab from "./SettingsAgentsTab.svelte";
  import SettingsKeyboardTab from "./SettingsKeyboardTab.svelte";
  import SettingsMachinesTab from "./SettingsMachinesTab.svelte";
  import SettingsExperimentsTab from "./SettingsExperimentsTab.svelte";
  import SettingsAboutTab from "./SettingsAboutTab.svelte";
  import SettingsPrivacyTab from "./SettingsPrivacyTab.svelte";
  import { updater } from "$lib/features/updater/store.svelte";
  import X from "@lucide/svelte/icons/x";
  import { scrollIntoViewSmooth } from "$lib/theme/motion";
  import SlidersHorizontal from "@lucide/svelte/icons/sliders-horizontal";
  import TerminalIcon from "@lucide/svelte/icons/terminal";
  import Palette from "@lucide/svelte/icons/palette";
  import PackageIcon from "@lucide/svelte/icons/package";
  import Keyboard from "@lucide/svelte/icons/keyboard";
  import Smartphone from "@lucide/svelte/icons/smartphone";
  import FlaskConical from "@lucide/svelte/icons/flask-conical";
  import Info from "@lucide/svelte/icons/info";
  import Server from "@lucide/svelte/icons/server";
  import Shield from "@lucide/svelte/icons/shield";
  import { onDestroy, tick, type Component } from "svelte";
  import { t, type MessageKey } from "$lib/i18n/index.svelte";
  import Search from "@lucide/svelte/icons/search";
  import { fuzzyScore } from "$lib/features/palette/fuzzy";
  import Highlight from "$lib/features/palette/Highlight.svelte";
  import {
    SETTINGS_CATALOGUE,
    SETTINGS_TABS,
    settingAnchorId,
    type SettingsTabId,
  } from "./catalogue";
  import { goToSetting, settingEntryVisible, settingsNav } from "./navigate.svelte";

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
  type TabId = SettingsTabId;

  type Tab = {
    id: TabId;
    labelKey: MessageKey;
    hintKey: MessageKey;
    icon: Component;
  };

  /**
   * Keyed by id and drawn in the catalogue's order, so the rail and the search
   * index cannot disagree about which pages exist: a `Record` over the union is
   * a compile error the day a page is added there and forgotten here.
   */
  const TAB_SPECS: Record<TabId, Omit<Tab, "id">> = {
    general: {
      labelKey: "tabs.general",
      hintKey: "tabs.generalHint",
      icon: SlidersHorizontal,
    },
    terminal: {
      labelKey: "tabs.terminal",
      hintKey: "tabs.terminalHint",
      icon: TerminalIcon,
    },
    appearance: {
      labelKey: "tabs.appearance",
      hintKey: "tabs.appearanceHint",
      icon: Palette,
    },
    agents: { labelKey: "tabs.agents", hintKey: "tabs.agentsHint", icon: PackageIcon },
    keyboard: {
      labelKey: "tabs.keyboard",
      hintKey: "tabs.keyboardHint",
      icon: Keyboard,
    },
    machines: {
      labelKey: "tabs.machines",
      hintKey: "tabs.machinesHint",
      icon: Smartphone,
    },
    privacy: {
      labelKey: "tabs.privacy",
      hintKey: "tabs.privacyHint",
      icon: Shield,
    },
    experiments: {
      labelKey: "tabs.experiments",
      hintKey: "tabs.experimentsHint",
      icon: FlaskConical,
    },
    about: { labelKey: "tabs.about", hintKey: "tabs.aboutHint", icon: Info },
  };

  const ALL_TABS: Tab[] = SETTINGS_TABS.map((id) => ({ id, ...TAB_SPECS[id] }));

  const TABS = ALL_TABS;

  const activeTab = $derived(settingsNav.tab);

  /**
   * The boite these settings belong to, when it is not this device.
   *
   * The panel is a view over `backend()`, so standing on a remote boite means
   * every control here writes over there. Nothing said so, and the two look
   * identical.
   */
  const editingRemote = $derived(
    workspace.mode === "remote"
      ? workspace.info.name ||
          (workspace.remoteUrl ? hostOf(workspace.remoteUrl) : "") ||
          t("workspace.remote")
      : null,
  );

  function hostOf(url: string): string {
    try {
      return new URL(url).host;
    } catch {
      return url;
    }
  }

  // A page that stops applying under the user (a boite switch, a disconnect)
  // must not leave the rail pointing at nothing.
  $effect(() => {
    if (!TABS.some((tab) => tab.id === settingsNav.tab)) settingsNav.tab = "general";
  });
  let railEl: HTMLElement | null = $state(null);
  let stripEl: HTMLElement | null = $state(null);
  let query = $state("");
  let searchEl: HTMLInputElement | null = $state(null);

  /**
   * The box takes the caret as soon as the panel is drawn.
   *
   * Settings is opened to change one thing, and its name is what the user has
   * in mind rather than which of nine pages it sits on. Focused here rather
   * than with `autofocus`, which Svelte flags for a11y and which fires before
   * the element is in the layout the panel mounts into.
   */
  $effect(() => {
    searchEl?.focus();
  });

  // The control a result just jumped to, so it can be pointed at for a second.
  // A page that scrolls to the right place and highlights nothing leaves the
  // user reading four cards to find which one they asked for.
  //
  // A fresh object per landing rather than the id on its own: clicking the same
  // result twice inside the second and a half writes the same string, `$state`
  // sees no change and the effect never re-runs, so the ring the user is
  // chasing never comes back while the timer that hides it restarts anyway.
  let landed = $state.raw<{ id: string } | null>(null);
  let landedTimer: ReturnType<typeof setTimeout> | null = null;

  const TAB_LABELS: Record<TabId, MessageKey> = Object.fromEntries(
    ALL_TABS.map((tab) => [tab.id, tab.labelKey]),
  ) as Record<TabId, MessageKey>;

  /**
   * Matched against the words on screen, in whatever language they are in.
   *
   * The index holds keys rather than strings, so this resolves them here: an
   * index built at module load would be searchable in the language the app
   * happened to start in.
   */
  const results = $derived.by(() => {
    const q = query.trim();
    if (!q) return [];
    const scored: {
      entry: (typeof SETTINGS_CATALOGUE)[number];
      label: string;
      desc: string;
      score: number;
      matchedField: "label" | "desc" | "tab";
      ranges: [number, number][];
    }[] = [];
    for (const entry of SETTINGS_CATALOGUE) {
      // A control this build never draws is not a result: a hit that jumps to a
      // page and points at nothing is worse than one hit fewer.
      if (!settingEntryVisible(entry)) continue;
      const label = t(entry.key);
      const desc = entry.descKey ? t(entry.descKey) : "";
      const tab = t(TAB_LABELS[entry.tab]);

      const labelRes = fuzzyScore(q, label, { fuzzy: true });
      const descRes = desc ? fuzzyScore(q, desc, { fuzzy: false }) : null;
      const tabRes = fuzzyScore(q, tab, { fuzzy: false });

      if (labelRes === null && descRes === null && tabRes === null) continue;

      let bestScore = -Infinity;
      let matchedField: "label" | "desc" | "tab" = "label";
      let ranges: [number, number][] = [];

      if (labelRes !== null && labelRes.score > bestScore) {
        bestScore = labelRes.score;
        matchedField = "label";
        ranges = labelRes.ranges;
      }
      if (descRes !== null && descRes.score > bestScore) {
        bestScore = descRes.score;
        matchedField = "desc";
        ranges = descRes.ranges;
      }
      if (tabRes !== null && tabRes.score > bestScore) {
        bestScore = tabRes.score;
        matchedField = "tab";
        ranges = tabRes.ranges;
      }

      scored.push({ entry, label, desc, score: bestScore, matchedField, ranges });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored;
  });

  /**
   * Picking a page is asking to see it, so the search box lets go of it.
   *
   * The results replace the page rather than sitting over it, so a rail click
   * that only moved the highlight left the content on the result list: the
   * whole rail, and the arrow keys with it, read as dead until the box was
   * emptied by hand.
   */
  function showTab(id: TabId) {
    settingsNav.tab = id;
    settingsNav.land = null;
    query = "";
  }

  $effect(() => {
    const land = settingsNav.land;
    if (!land) return;
    query = "";
    const id = settingAnchorId(land.key);
    landed = { id };
    if (landedTimer) clearTimeout(landedTimer);
    landedTimer = setTimeout(() => (landed = null), 1600);
    // After the tab has rendered: the element does not exist until the page it
    // is on is the page being drawn. `tick()` is the promise that says so; a
    // microtask only ever worked because Svelte happened to have queued its
    // flush first, which is true today and is not a contract.
    void tick().then(() => {
      scrollIntoViewSmooth(document.getElementById(id), { block: "center" });
    });
  });

  // The timer outlives the panel otherwise, and fires into a component that is
  // no longer on screen.
  onDestroy(() => {
    if (landedTimer) clearTimeout(landedTimer);
  });

  $effect(() => {
    const id = landed?.id;
    if (!id) return;
    const el = document.getElementById(id);
    if (!el) return;
    el.dataset.landed = "true";
    return () => {
      delete el.dataset.landed;
    };
  });

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
  // One panel element for all the tabs, because that is what the DOM does: the
  // container stays and its contents are swapped. One id per tab would mean
  // every other aria-controls pointing at nothing.
  const PANEL_ID = "settings-panel";

  // Selection follows focus: every panel is a plain form, so arriving on a tab
  // and showing it are the same act, and Tab then leads straight into the
  // controls rather than back into the navigation.
  function moveTo(index: number, place: "rail" | "strip") {
    const next = TABS[(index + TABS.length) % TABS.length];
    showTab(next.id);
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
    <h2 class="shrink-0 text-base font-semibold tracking-tight">{t("common.settings")}</h2>

    <!-- Next to the title rather than as a banner over the page: it qualifies
         the word "Settings", and a strip above the first card is read once and
         scrolled past. -->
    {#if editingRemote}
      <span
        class="ml-2 flex min-w-0 items-center gap-1.5 rounded-md border border-warning/40 bg-warning/10 px-2 py-0.5 text-xs text-warning"
        use:tip={t("settings.editingRemoteDesc")}
      >
        <Server class="size-3 shrink-0" />
        <span class="truncate">{t("settings.editingRemote", { name: editingRemote })}</span>
      </span>
    {/if}

    <!-- In the header rather than over the rail: it searches every page, and a
         box sitting on top of one page's list reads as filtering that list. -->
    <label class="relative mx-4 min-w-0 max-w-xs flex-1">
      <Search
        class="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-2"
      />
      <input
        bind:this={searchEl}
        bind:value={query}
        type="search"
        spellcheck="false"
        autocomplete="off"
        placeholder={t("settings.searchPlaceholder")}
        aria-label={t("settings.searchPlaceholder")}
        class="w-full rounded-md border border-edge bg-[var(--color-surface-2)] py-1 pl-7 pr-2 text-xs text-foreground outline-none transition placeholder:text-muted-2 focus:border-foreground/30"
        onkeydown={(e) => {
          if (e.key === "Escape" && query) {
            e.stopPropagation();
            query = "";
          }
          if (e.key === "Enter" && results.length > 0) {
            e.preventDefault();
            void goToSetting(results[0].entry.tab, results[0].entry.key);
          }
        }}
      />
    </label>

    <button
      type="button"
      class="rounded-md p-1 text-muted-foreground transition hover:bg-accent hover:text-foreground"
      onclick={close}
      aria-label={t("common.closeSettings")}
      use:tip={t("common.backToTerminal")}
    >
      <X class="size-4" />
    </button>
  </header>

  <!-- Under the rail's breakpoint: the same tabs, across, scrolling. -->
  <div class="shrink-0 border-b border-border bg-[var(--color-surface)] px-3 md:hidden">
    <div
      bind:this={stripEl}
      class="edge-fade hide-scrollbar flex gap-0.5 overflow-x-auto"
      use:edgeFade
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
          onclick={() => showTab(tab.id)}
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
      class="hidden w-52 shrink-0 flex-col gap-0.5 scroll-pane overflow-y-auto border-r border-border bg-[var(--color-surface)] p-2 md:flex"
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
          onclick={() => showTab(tab.id)}
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
      class="min-w-0 flex-1 scroll-pane overflow-y-auto px-4 py-4"
    >
      <div class="mx-auto flex max-w-3xl flex-col gap-2.5">
        {#if query.trim()}
          <!-- The results replace the page rather than sitting over it: what
               was asked for is "where is this setting", and the page behind an
               overlay is not the answer. -->
          <div class="mb-1">
            <h3 class="text-md font-semibold tracking-tight text-foreground">
              {t("settings.searchResults", { count: results.length })}
            </h3>
          </div>
          {#each results as hit (hit.entry.key)}
            <button
              type="button"
              class="flex w-full flex-col items-start gap-0.5 rounded-lg border border-edge bg-[var(--color-surface)] px-3 py-2 text-left transition hover:border-foreground/25"
              onclick={() => void goToSetting(hit.entry.tab, hit.entry.key)}
            >
              <span class="flex w-full items-baseline gap-2">
                <span class="min-w-0 truncate text-xs font-medium text-foreground">
                  <Highlight text={hit.label} ranges={hit.matchedField === "label" ? hit.ranges : undefined} />
                </span>
                <span class="shrink-0 text-xs uppercase tracking-wider text-muted-2">
                  <Highlight text={t(TAB_LABELS[hit.entry.tab])} ranges={hit.matchedField === "tab" ? hit.ranges : undefined} />
                </span>
              </span>
              {#if hit.desc}
                <span class="line-clamp-2 text-xs leading-snug text-muted-foreground">
                  <Highlight text={hit.desc} ranges={hit.matchedField === "desc" ? hit.ranges : undefined} />
                </span>
              {/if}
            </button>
          {:else}
            <p class="px-1 py-6 text-center text-xs text-muted-foreground">
              {t("settings.searchNoMatch")}
            </p>
          {/each}
        {:else}
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
        {:else if activeTab === "agents"}
          <SettingsAgentsTab />
        {:else if activeTab === "keyboard"}
          <SettingsKeyboardTab />
        {:else if activeTab === "machines"}
          <SettingsMachinesTab />
        {:else if activeTab === "privacy"}
          <SettingsPrivacyTab />
        {:else if activeTab === "experiments"}
          <SettingsExperimentsTab />
        {:else if activeTab === "about"}
          <SettingsAboutTab />
        {/if}
        {/if}
      </div>
    </div>
  </div>
</div>

<style>
  /* What a search result lands on, for a second and a half. A page that scrolls
     to the right place and highlights nothing leaves the user reading four
     cards to find the one they asked for. The ring is drawn rather than the
     border replaced, so nothing about the card's own box moves. */
  :global([data-landed="true"]) {
    animation: settings-landed 1.6s var(--ease-out-quint);
  }
  @keyframes settings-landed {
    0%,
    60% {
      box-shadow: 0 0 0 2px color-mix(in srgb, var(--color-foreground) 45%, transparent);
    }
    100% {
      box-shadow: 0 0 0 2px transparent;
    }
  }

  /* The same ring, standing still. `app.css` clamps every animation to 0.01ms
     under the app's own reduced-motion mode, so the keyframes above ran to
     their transparent last frame before anything was on screen: the user was
     scrolled to the right place and shown nothing, which is the exact failure
     this ring exists to prevent. It is removed with `data-landed`, so it lasts
     the same second and a half without a frame of animation. */
  :global(html[data-motion="reduced"] [data-landed="true"]) {
    animation: none;
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--color-foreground) 45%, transparent);
  }
</style>
