<script lang="ts">
  import { onMount } from "svelte";
  import { backend, workspace } from "$lib/backend";
  import { settings } from "$lib/features/settings/store.svelte";
  import { CLI_PRESETS } from "$lib/features/settings/cliPresets";
  import ShortcutIcon from "$lib/shared/icons/ShortcutIcon.svelte";
  import BoiteLogo from "$lib/shared/components/BoiteLogo.svelte";
  import ArrowRight from "@lucide/svelte/icons/arrow-right";
  import ArrowLeft from "@lucide/svelte/icons/arrow-left";
  import Check from "@lucide/svelte/icons/check";
  import ExternalLink from "@lucide/svelte/icons/external-link";
  import Plus from "@lucide/svelte/icons/plus";
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import GripVertical from "@lucide/svelte/icons/grip-vertical";
  import { t, LOCALE_OPTIONS } from "$lib/i18n/index.svelte";
  import type { IconKey } from "$lib/types";

  interface SetupItem {
    id: string;
    label: string;
    command: string;
    iconKey: IconKey;
    executable: string;
    docUrl: string;
    installed: boolean;
    enabled: boolean;
  }

  let step = $state(1);
  let loading = $state(true);
  let refreshingId = $state<string | null>(null);
  let showCustomAgent = $state(false);
  let customLabel = $state("");
  let customCommand = $state("");
  let enabledAgents = $state<SetupItem[]>([]);
  let draggedId = $state<string | null>(null);
  let overId = $state<string | null>(null);
  let dragArmed = $state(false);

  const items = $state<SetupItem[]>(
    CLI_PRESETS.map((cli) => ({ ...cli, installed: false, enabled: false })),
  );

  // Detection runs where the agents will run. On a remote boite that is the
  // server, so naming it beats claiming "this computer".
  const detectionTarget = $derived(
    workspace.mode === "remote"
      ? (workspace.info.name ?? "boite")
      : t("setup.detectionTargetLocal"),
  );

  async function refreshItem(item: SetupItem) {
    refreshingId = item.id;
    try {
      item.installed = await backend().shell.commandExists(item.executable);
      if (item.installed) item.enabled = true;
    } catch (err) {
      console.error("Unable to check command", item.executable, err);
      item.installed = false;
    } finally {
      refreshingId = null;
    }
  }

  async function refreshAll() {
    loading = true;
    await Promise.all(items.map(refreshItem));
    loading = false;
  }

  onMount(() => {
    void refreshAll();
  });

  function addCustomAgent() {
    const label = customLabel.trim();
    const command = customCommand.trim();
    if (!label || !command) return;
    items.push({
      id: `custom-${crypto.randomUUID()}`,
      label,
      command,
      iconKey: null,
      executable: command.split(/\s+/)[0],
      docUrl: "",
      installed: true,
      enabled: true,
    });
    customLabel = "";
    customCommand = "";
    showCustomAgent = false;
  }

  function selectedAgents(): SetupItem[] {
    return items.filter((item) => item.enabled);
  }

  function goToOrder() {
    enabledAgents = selectedAgents();
    if (enabledAgents.length === 0) {
      void finishSetup();
      return;
    }
    step = 3;
  }

  function finishSetup() {
    const source = step === 3 ? enabledAgents : selectedAgents();
    return settings.completeSetup(
      source.map((item) => ({
        id: item.id,
        label: item.label,
        command: item.command,
        iconKey: item.iconKey,
      })),
    );
  }

  function armDrag() {
    dragArmed = true;
  }
  function disarmDrag() {
    dragArmed = false;
  }
  function onDragStart(id: string, event: DragEvent) {
    if (!dragArmed) {
      event.preventDefault();
      return;
    }
    draggedId = id;
    event.dataTransfer?.setData("text/plain", id);
  }
  function onDrop(targetId: string, event: DragEvent) {
    event.preventDefault();
    const fromId = draggedId;
    draggedId = null;
    overId = null;
    dragArmed = false;
    if (!fromId || fromId === targetId) return;
    const from = enabledAgents.findIndex((item) => item.id === fromId);
    const to = enabledAgents.findIndex((item) => item.id === targetId);
    if (from < 0 || to < 0) return;
    const [item] = enabledAgents.splice(from, 1);
    enabledAgents.splice(to, 0, item);
  }
</script>

<div class="setup-container flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-[var(--color-background)] p-4 md:p-6">
  <div class="h-[720px] w-full max-w-4xl max-h-full overflow-hidden rounded-lg border border-border/60 bg-[var(--color-surface)] p-6 shadow-2xl md:p-8">
    {#if step === 1}
      <div class="mx-auto flex h-full min-h-0 max-w-xl flex-col items-center justify-center py-10 text-center">
        <div class="mb-6 flex size-24 items-center justify-center rounded-lg border border-border bg-[var(--color-surface-2)]">
          <BoiteLogo size={64} />
        </div>
        <h1 class="text-3xl font-bold text-foreground">{t("setup.title")}</h1>
        <p class="mt-3 max-w-md text-sm leading-relaxed text-muted-foreground">{t("setup.desc")}</p>

        <div class="mt-6 flex items-center justify-center gap-2">
          <span class="text-xs text-muted-foreground">{t("setup.language")} :</span>
          <div class="flex gap-1.5">
            {#each LOCALE_OPTIONS as lang (lang.id)}
              <button
                type="button"
                class="rounded-md border px-2.5 py-1 text-xs transition
                  {settings.state.locale === lang.id
                    ? 'border-foreground/40 bg-[var(--color-surface-3)] text-foreground'
                    : 'border-border bg-[var(--color-surface-2)] text-muted-foreground hover:border-foreground/30 hover:text-foreground'}"
                onclick={() => settings.setLocale(lang.id)}
              >
                {t(lang.labelKey)}
              </button>
            {/each}
          </div>
        </div>

        <div class="mt-8 flex w-full max-w-sm flex-col gap-3 sm:flex-row">
          <button type="button" onclick={() => step = 2} class="flex flex-1 items-center justify-center gap-2 rounded-md bg-foreground px-5 py-3 text-sm font-semibold text-background transition hover:bg-foreground/90">
            {t("setup.start")} <ArrowRight class="size-4" />
          </button>
          <button type="button" onclick={() => void settings.setSetupCompleted(true)} class="flex flex-1 items-center justify-center rounded-md border border-border bg-[var(--color-surface-2)] px-5 py-3 text-sm font-medium text-muted-foreground transition hover:text-foreground">
            {t("setup.skip")}
          </button>
        </div>
      </div>
    {:else if step === 2}
      <div class="flex h-full min-h-0 flex-col">
        <div class="flex flex-wrap items-start justify-between gap-4 border-b border-border/50 pb-4">
          <div>
            <p class="text-[11px] font-semibold uppercase text-muted-foreground">{t("setup.stepCount", { current: 1, total: 2 })}</p>
            <h2 class="mt-1 text-xl font-bold text-foreground">{t("setup.agentsTitle")}</h2>
            <p class="mt-1 text-xs text-muted-foreground">{t("setup.agentsDesc")}</p>
          </div>
          <button type="button" onclick={() => void refreshAll()} disabled={loading} class="flex items-center gap-1.5 rounded-md border border-border bg-[var(--color-surface-2)] px-3 py-2 text-xs font-medium text-muted-foreground transition hover:text-foreground disabled:cursor-wait disabled:opacity-50">
            <RefreshCw class="size-3.5 {loading ? 'animate-spin' : ''}" /> {t("setup.refresh")}
          </button>
        </div>
        {#if loading}
          <div class="flex flex-1 flex-col items-center justify-center gap-3">
            <div class="size-7 animate-spin rounded-full border-2 border-border border-t-foreground"></div>
            <p class="text-xs text-muted-foreground">{t("setup.checkingTools")}</p>
          </div>
        {:else}
          <div class="mt-5 min-h-0 flex-1 overflow-y-auto px-1 py-1 pb-4">
            <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {#each items as item (item.id)}
                <article class="flex min-h-48 flex-col rounded-lg border border-border bg-[var(--color-surface-2)] p-4">
                  <div class="flex items-start justify-between gap-3">
                    <div class="flex min-w-0 items-center gap-2.5">
                      <ShortcutIcon iconKey={item.iconKey} size={25} />
                      <div class="min-w-0">
                        <p class="truncate text-sm font-semibold text-foreground">{item.label}</p>
                        <p class="mt-1 text-[11px] text-muted-foreground">
                          {item.installed
                            ? t("setup.detected", { target: detectionTarget })
                            : t("setup.notDetected")}
                        </p>
                      </div>
                    </div>
                    <button type="button" role="switch" aria-checked={item.enabled} aria-label={t("setup.addToShortcuts", { label: item.label })} onclick={() => item.enabled = !item.enabled} class="relative inline-flex h-5 w-9 shrink-0 rounded-full transition {item.enabled ? 'bg-[var(--color-success)]' : 'bg-[var(--color-surface-3)]'}">
                      <span class="mt-0.5 size-4 rounded-full bg-foreground shadow transition {item.enabled ? 'translate-x-4' : 'translate-x-0.5'}"></span>
                    </button>
                  </div>
                  <p class="mt-3 truncate font-mono text-[11px] text-muted-foreground/70">{item.command}</p>
                  <div class="mt-auto flex gap-2 pt-4">
                    {#if item.docUrl}
                      <a href={item.docUrl} target="_blank" rel="noopener noreferrer" class="flex flex-1 items-center justify-center gap-1 rounded-md border border-border bg-[var(--color-surface-3)] px-2 py-1.5 text-xs text-muted-foreground transition hover:text-foreground">
                        <ExternalLink class="size-3" /> {t("setup.documentation")}
                      </a>
                    {/if}
                    <button type="button" onclick={() => void refreshItem(item)} disabled={refreshingId === item.id} class="flex size-8 items-center justify-center rounded-md border border-border text-muted-foreground transition hover:bg-[var(--color-surface-3)] hover:text-foreground disabled:opacity-50" title={t("setup.refreshItemTooltip")}>
                      <RefreshCw class="size-3.5 {refreshingId === item.id ? 'animate-spin' : ''}" />
                    </button>
                  </div>
                </article>
              {/each}

              <button type="button" onclick={() => showCustomAgent = !showCustomAgent} class="flex min-h-48 flex-col items-center justify-center rounded-lg border border-dashed border-muted-foreground/40 bg-transparent p-4 text-center transition hover:border-foreground/60 hover:bg-[var(--color-surface-2)]">
                <span class="mb-3 flex size-9 items-center justify-center rounded-md border border-dashed border-muted-foreground/60 text-muted-foreground">
                  <Plus class="size-4" />
                </span>
                <span class="text-sm font-semibold text-foreground">{t("setup.addAgent")}</span>
                <span class="mt-1 text-xs leading-relaxed text-muted-foreground">{t("setup.addAgentDesc")}</span>
              </button>
            </div>

            {#if showCustomAgent}
              <form class="mt-4 grid grid-cols-1 items-end gap-3 rounded-lg border border-border bg-[var(--color-surface-2)] p-4 sm:grid-cols-[1fr_1fr_auto]" onsubmit={(event) => { event.preventDefault(); addCustomAgent(); }}>
                <label class="flex flex-col gap-1.5 text-xs text-muted-foreground">
                  {t("setup.agentName")}
                  <input bind:value={customLabel} required placeholder={t("setup.customAgentPlaceholder")} class="rounded-md border border-border bg-[var(--color-surface)] px-3 py-2 text-sm text-foreground outline-none focus:border-foreground/50" />
                </label>
                <label class="flex flex-col gap-1.5 text-xs text-muted-foreground">
                  {t("setup.command")}
                  <input bind:value={customCommand} required placeholder={t("setup.commandPlaceholder")} class="rounded-md border border-border bg-[var(--color-surface)] px-3 py-2 font-mono text-sm text-foreground outline-none focus:border-foreground/50" />
                </label>
                <button type="submit" class="flex items-center justify-center gap-1.5 rounded-md bg-foreground px-3 py-2 text-sm font-medium text-background transition hover:bg-foreground/90">
                  <Plus class="size-3.5" /> {t("setup.add")}
                </button>
              </form>
            {/if}
          </div>
        {/if}
        <div class="mt-auto flex items-center justify-between border-t border-border/50 pt-5">
          <button type="button" onclick={() => step = 1} class="flex items-center gap-1.5 px-2 py-2 text-sm text-muted-foreground transition hover:text-foreground">
            <ArrowLeft class="size-4" /> {t("setup.back")}
          </button>
          <button type="button" onclick={goToOrder} class="flex items-center gap-1.5 rounded-md bg-foreground px-5 py-2.5 text-sm font-semibold text-background transition hover:bg-foreground/90">
            {t("setup.continue")} <ArrowRight class="size-4" />
          </button>
        </div>
      </div>
    {:else}
      <div class="flex h-full min-h-0 flex-col">
        <div class="border-b border-border/50 pb-4">
          <p class="text-[11px] font-semibold uppercase text-muted-foreground">{t("setup.stepCount", { current: 2, total: 2 })}</p>
          <h2 class="mt-1 text-xl font-bold text-foreground">{t("setup.orderTitle")}</h2>
          <p class="mt-1 text-xs text-muted-foreground">{t("setup.orderDesc")}</p>
        </div>
        <ul class="mt-5 min-h-0 flex-1 overflow-y-auto px-1 py-1 pb-4 flex flex-col gap-2">
          {#each enabledAgents as item (item.id)}
            <li draggable={dragArmed} ondragstart={(event) => onDragStart(item.id, event)} ondragover={(event) => { event.preventDefault(); overId = item.id; }} ondragleave={() => overId = null} ondrop={(event) => onDrop(item.id, event)} ondragend={() => { draggedId = null; overId = null; dragArmed = false; }} class="flex items-center gap-3 rounded-lg border border-border bg-[var(--color-surface-2)] p-3 {draggedId === item.id ? 'opacity-40' : ''} {overId === item.id && draggedId !== item.id ? 'border-t-2 border-t-foreground/60' : ''}">
              <span class="flex size-7 cursor-grab items-center justify-center rounded-md border border-border text-muted-foreground active:cursor-grabbing" role="button" tabindex="-1" onmousedown={armDrag} onmouseup={disarmDrag} onmouseleave={disarmDrag} title={t("setup.dragTooltip")}>
                <GripVertical class="size-4" />
              </span>
              <ShortcutIcon iconKey={item.iconKey} size={21} />
              <div class="min-w-0">
                <p class="truncate text-sm font-medium text-foreground">{item.label}</p>
                <p class="truncate font-mono text-[11px] text-muted-foreground">{item.command}</p>
              </div>
            </li>
          {/each}
        </ul>
        <div class="mt-auto flex items-center justify-between border-t border-border/50 pt-5">
          <button type="button" onclick={() => step = 2} class="flex items-center gap-1.5 px-2 py-2 text-sm text-muted-foreground transition hover:text-foreground">
            <ArrowLeft class="size-4" /> {t("setup.back")}
          </button>
          <button type="button" onclick={() => void finishSetup()} class="flex items-center gap-1.5 rounded-md bg-foreground px-5 py-2.5 text-sm font-semibold text-background transition hover:bg-foreground/90">
            {t("setup.finish")} <Check class="size-4" />
          </button>
        </div>
      </div>
    {/if}
  </div>
</div>
