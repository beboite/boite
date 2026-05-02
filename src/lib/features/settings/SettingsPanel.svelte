<script lang="ts">
  import { app } from "$lib/app/store.svelte";
  import SettingsGeneralTab from "./SettingsGeneralTab.svelte";
  import SettingsTerminalTab from "./SettingsTerminalTab.svelte";
  import X from "@lucide/svelte/icons/x";

  type TabId = "general" | "terminal";

  const TABS: { id: TabId; label: string }[] = [
    { id: "general", label: "General" },
    { id: "terminal", label: "Terminal" },
  ];

  let activeTab = $state<TabId>("general");

  function close() {
    app.view = "terminal";
  }
</script>

<div class="flex h-full min-h-0 flex-col bg-background">
  <header
    class="flex shrink-0 items-center justify-between border-b border-border bg-[var(--color-surface)] px-5 py-3"
  >
    <h2 class="text-sm font-semibold tracking-tight">Settings</h2>
    <button
      type="button"
      class="rounded-md p-1 text-muted-foreground transition hover:bg-accent hover:text-foreground"
      onclick={close}
      aria-label="Close settings"
      title="Back to terminal"
    >
      <X class="size-4" />
    </button>
  </header>

  <div class="border-b border-border bg-[var(--color-surface)] px-5">
    <div class="flex gap-1" role="tablist">
      {#each TABS as tab (tab.id)}
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === tab.id}
          class="relative -mb-px border-b-2 px-3 py-2 text-xs font-medium transition {activeTab ===
          tab.id
            ? 'border-foreground text-foreground'
            : 'border-transparent text-muted-foreground hover:text-foreground'}"
          onclick={() => (activeTab = tab.id)}
        >
          {tab.label}
        </button>
      {/each}
    </div>
  </div>

  <div class="flex-1 overflow-y-auto px-6 py-5">
    <div class="mx-auto flex max-w-3xl flex-col gap-4">
      {#if activeTab === "general"}
        <SettingsGeneralTab />
      {:else if activeTab === "terminal"}
        <SettingsTerminalTab />
      {/if}
    </div>
  </div>
</div>
