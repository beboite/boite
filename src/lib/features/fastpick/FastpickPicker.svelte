<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { scale } from "svelte/transition";
  import { app } from "$lib/app/store.svelte";
  import { settings } from "$lib/features/settings/store.svelte";
  import { t } from "$lib/i18n/index.svelte";
  import { launchFastpick } from "$lib/features/thread/api";
  import ShortcutIcon from "$lib/shared/icons/ShortcutIcon.svelte";
  import { fastpick } from "./store.svelte";
  import { iconKeyForKind, type FastpickCombo } from "./combo";
  import type { FastpickHarness, FastpickModel } from "$lib/backend/types";
  import Plus from "@lucide/svelte/icons/plus";
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import ChevronLeft from "@lucide/svelte/icons/chevron-left";
  import ChevronRight from "@lucide/svelte/icons/chevron-right";
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import Check from "@lucide/svelte/icons/check";
  import KeyRound from "@lucide/svelte/icons/key-round";

  // One pane at a time rather than three columns: the bar is narrow, and each answer
  // narrows the next one anyway, so a pane that is already decided is only in the way.
  type Pane = "harness" | "provider" | "model" | "options";

  let open = $state(false);
  let pane = $state<Pane>("harness");
  let harnessId = $state<string | null>(null);
  let providerId = $state<string | null>(null);
  let model = $state<FastpickModel | null>(null);
  let effort = $state<string | null>(null);
  // Undefined means "let fastpick pick the file matching the model", which is what its own
  // menu starts on. Selecting anything here makes the choice explicit.
  let prompts = $state<string[] | undefined>(undefined);

  let triggerRoot: HTMLDivElement | null = $state(null);
  let menu: HTMLDivElement | null = $state(null);
  let menuPos = $state({ x: 0, y: 0 });

  const harness = $derived<FastpickHarness | null>(
    fastpick.harnesses.find((h) => h.id === harnessId) ?? null,
  );
  const providers = $derived(harnessId ? fastpick.providersFor(harnessId) : []);
  const models = $derived(providerId ? fastpick.models[providerId] ?? null : null);

  function reset() {
    pane = "harness";
    harnessId = null;
    providerId = null;
    model = null;
    effort = null;
    prompts = undefined;
  }

  function toggle(e: MouseEvent) {
    e.stopPropagation();
    if (open) {
      open = false;
      return;
    }
    if (triggerRoot) {
      // Fixed positioning: the shortcut bar scrolls horizontally, which would clip an
      // absolutely-positioned menu inside it.
      const r = triggerRoot.getBoundingClientRect();
      menuPos = { x: r.left, y: r.bottom + 4 };
    }
    reset();
    open = true;
    void fastpick.ensure();
  }

  function pickHarness(id: string) {
    harnessId = id;
    pane = "provider";
  }

  function pickProvider(id: string) {
    providerId = id;
    pane = "model";
    void fastpick.loadModels(id);
  }

  function pickModel(m: FastpickModel) {
    model = m;
    effort = harness?.supportsEffort ? m.effortDefault : null;
    prompts = undefined;
    launch();
  }

  function openOptions(m: FastpickModel, e: MouseEvent) {
    e.stopPropagation();
    model = m;
    effort = harness?.supportsEffort ? m.effortDefault : null;
    prompts = undefined;
    pane = "options";
  }

  function togglePrompt(stem: string) {
    const current = prompts ?? (model?.prompts.length ? [model.prompts[0]] : []);
    prompts = current.includes(stem)
      ? current.filter((p) => p !== stem)
      : [...current, stem];
  }

  function promptChecked(stem: string): boolean {
    // Before the user touches anything, the pre-checked file is the one fastpick would
    // have chosen: the most specific match, which its list already puts first.
    if (prompts === undefined) return model?.prompts[0] === stem;
    return prompts.includes(stem);
  }

  function back() {
    if (pane === "options") pane = "model";
    else if (pane === "model") pane = "provider";
    else if (pane === "provider") pane = "harness";
  }

  function launch() {
    if (!harness || !providerId || !model) return;
    const combo: FastpickCombo = {
      harness: harness.id,
      provider: providerId,
      model: model.id,
      effort,
      prompts,
    };
    open = false;
    void launchFastpick(combo, harness, app.currentProjectId);
  }

  function sourceLabel(source: { kind: string; ageSecs?: number }): string {
    if (source.kind === "live") return t("fastpick.sourceLive");
    if (source.kind === "cache") return t("fastpick.sourceCache");
    if (source.kind === "failed") return t("fastpick.sourceFailed");
    return t("fastpick.sourceConfig");
  }

  function handleDocClick(e: MouseEvent) {
    if (!open) return;
    const target = e.target as Node;
    if (triggerRoot?.contains(target) || menu?.contains(target)) return;
    open = false;
  }

  function handleKeydown(e: KeyboardEvent) {
    if (!open) return;
    if (e.key === "Escape") open = false;
    if (e.key === "ArrowLeft") back();
  }

  onMount(() => {
    document.addEventListener("click", handleDocClick);
    document.addEventListener("keydown", handleKeydown);
    // Probed once so the button can hide itself on a machine with no fastpick, rather
    // than offering a menu whose every entry fails. Turned off in the settings, nothing
    // is asked at all: the answer would only decide how to hide a button already hidden.
    if (settings.state.fastpickEnabled) void fastpick.ensure();
  });

  onDestroy(() => {
    document.removeEventListener("click", handleDocClick);
    document.removeEventListener("keydown", handleKeydown);
  });
</script>

{#if settings.state.fastpickEnabled && fastpick.installed !== false}
  <div bind:this={triggerRoot} class="relative flex shrink-0 items-stretch">
    <button
      type="button"
      class="flex shrink-0 items-center gap-1.5 rounded-md border border-dashed border-border px-2.5 py-1 text-xs text-muted-foreground transition hover:border-foreground/30 hover:bg-[var(--color-surface-2)] hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
      disabled={app.currentProjectId === null}
      onclick={toggle}
      aria-haspopup="menu"
      aria-expanded={open}
      title={t("fastpick.tooltip")}
      aria-label={t("fastpick.tooltip")}
    >
      <!-- Same three parts as the Terminal button beside it: it launches a thread too, and
           a button with no glyph reads as smaller than its neighbours whatever its box says. -->
      <Plus class="size-3.5" />
      <span>{t("fastpick.label")}</span>
      <ChevronDown class="size-3.5" />
    </button>

    {#if open}
      <div
        bind:this={menu}
        role="menu"
        tabindex="-1"
        class="fixed z-[9999] flex max-h-[60vh] min-w-64 flex-col overflow-hidden rounded-md border border-border bg-[var(--color-surface-2)] shadow-xl"
        style:left="{menuPos.x}px"
        style:top="{menuPos.y}px"
        style:transform-origin="top left"
        transition:scale={{ duration: 90, start: 0.96 }}
      >
        <div
          class="flex items-center gap-1.5 border-b border-border px-2 py-1.5 text-[11px] text-muted-foreground"
        >
          {#if pane !== "harness"}
            <button
              type="button"
              class="flex items-center rounded p-0.5 transition hover:bg-accent hover:text-foreground"
              onclick={back}
              aria-label={t("fastpick.back")}
              title={t("fastpick.back")}
            >
              <ChevronLeft class="size-3.5" />
            </button>
          {/if}
          <span class="truncate font-medium">
            {#if pane === "harness"}{t("fastpick.stepHarness")}
            {:else if pane === "provider"}{harness?.name}
            {:else if pane === "model"}{harness?.name} · {providerId}
            {:else}{model?.label ?? model?.id}{/if}
          </span>
          {#if pane === "model" && providerId}
            <button
              type="button"
              class="ml-auto flex items-center rounded p-0.5 transition hover:bg-accent hover:text-foreground"
              onclick={() => providerId && fastpick.loadModels(providerId, true)}
              aria-label={t("fastpick.refresh")}
              title={t("fastpick.refresh")}
            >
              <RefreshCw class="size-3" />
            </button>
          {/if}
        </div>

        <div class="flex flex-col overflow-y-auto p-1">
          {#if fastpick.loading}
            <div class="px-2 py-1.5 text-[11px] text-muted-foreground">{t("common.loading")}</div>
          {:else if fastpick.error}
            <div class="px-2 py-1.5 text-[11px] text-destructive">{fastpick.error}</div>
          {:else if pane === "harness"}
            {#if fastpick.harnesses.length === 0}
              <div class="px-2 py-1.5 text-[11px] text-muted-foreground">
                {t("fastpick.noHarness")}
              </div>
            {/if}
            {#each fastpick.harnesses as h (h.id)}
              <button
                type="button"
                role="menuitem"
                class="flex items-center gap-2 rounded px-2 py-1.5 text-left text-[11.5px] text-foreground/85 transition hover:bg-accent hover:text-foreground"
                onclick={() => pickHarness(h.id)}
              >
                <ShortcutIcon iconKey={iconKeyForKind(h.kind)} size={14} color={null} />
                <span class="font-medium">{h.name}</span>
                <ChevronRight class="ml-auto size-3.5 opacity-50" />
              </button>
            {/each}
          {:else if pane === "provider"}
            {#each providers as p (p.id)}
              <button
                type="button"
                role="menuitem"
                class="flex items-center gap-2 rounded px-2 py-1.5 text-left text-[11.5px] text-foreground/85 transition hover:bg-accent hover:text-foreground"
                onclick={() => pickProvider(p.id)}
              >
                <span class="min-w-0 truncate font-medium">{p.name}</span>
                {#if p.needsKey && !p.keyPresent}
                  <KeyRound class="size-3 text-destructive" aria-label={t("fastpick.noKey")} />
                  <span class="sr-only">{t("fastpick.noKey")}</span>
                {/if}
                <ChevronRight class="ml-auto size-3.5 shrink-0 opacity-50" />
              </button>
            {/each}
          {:else if pane === "model"}
            {#if providerId && fastpick.loadingModels === providerId}
              <div class="px-2 py-1.5 text-[11px] text-muted-foreground">{t("common.loading")}</div>
            {:else if providerId && fastpick.modelsError[providerId]}
              <div class="px-2 py-1.5 text-[11px] text-destructive">
                {fastpick.modelsError[providerId]}
              </div>
            {:else if models}
              <div class="px-2 pb-1 text-[10px] text-muted-foreground/70">
                {sourceLabel(models.source)}
              </div>
              {#each models.items as m (m.id)}
                <div
                  class="group flex items-center rounded transition hover:bg-accent"
                >
                  <button
                    type="button"
                    role="menuitem"
                    class="flex min-w-0 flex-1 items-baseline gap-2 px-2 py-1.5 text-left text-[11.5px] text-foreground/85 transition group-hover:text-foreground"
                    onclick={() => pickModel(m)}
                  >
                    <span class="min-w-0 truncate font-medium">{m.label ?? m.id}</span>
                    {#if m.contextWindow}
                      <span class="shrink-0 font-mono text-[10px] text-muted-foreground/70">
                        {Math.round(m.contextWindow / 1000)}K
                      </span>
                    {/if}
                  </button>
                  {#if harness?.supportsEffort && m.effort.length > 0}
                    <button
                      type="button"
                      class="flex shrink-0 items-center rounded p-1 text-muted-foreground transition hover:text-foreground"
                      onclick={(e) => openOptions(m, e)}
                      aria-label={t("fastpick.options")}
                      title={t("fastpick.options")}
                    >
                      <ChevronRight class="size-3.5" />
                    </button>
                  {:else if harness?.supportsSystemPrompts && m.prompts.length > 0}
                    <button
                      type="button"
                      class="flex shrink-0 items-center rounded p-1 text-muted-foreground transition hover:text-foreground"
                      onclick={(e) => openOptions(m, e)}
                      aria-label={t("fastpick.options")}
                      title={t("fastpick.options")}
                    >
                      <ChevronRight class="size-3.5" />
                    </button>
                  {/if}
                </div>
              {/each}
            {/if}
          {:else if pane === "options" && model}
            {#if harness?.supportsEffort && model.effort.length > 0}
              <div class="px-2 pb-1 pt-1 text-[10px] uppercase tracking-wide text-muted-foreground/70">
                {t("fastpick.effort")}
              </div>
              {#each model.effort as level (level)}
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={effort === level}
                  class="flex items-center gap-2 rounded px-2 py-1.5 text-left text-[11.5px] text-foreground/85 transition hover:bg-accent hover:text-foreground"
                  onclick={() => (effort = level)}
                >
                  <span
                    class="flex size-3.5 shrink-0 items-center justify-center rounded-full border transition"
                    class:border-border={effort !== level}
                    class:border-foreground={effort === level}
                  >
                    {#if effort === level}
                      <span class="size-1.5 rounded-full bg-foreground"></span>
                    {/if}
                  </span>
                  <span>{level}</span>
                </button>
              {/each}
            {/if}
            {#if harness?.supportsSystemPrompts && model.prompts.length > 0}
              <div class="px-2 pb-1 pt-2 text-[10px] uppercase tracking-wide text-muted-foreground/70">
                {t("fastpick.systemPrompt")}
              </div>
              {#each model.prompts as stem (stem)}
                <button
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={promptChecked(stem)}
                  class="flex items-center gap-2 rounded px-2 py-1.5 text-left text-[11.5px] text-foreground/85 transition hover:bg-accent hover:text-foreground"
                  onclick={() => togglePrompt(stem)}
                >
                  <span
                    class="flex size-3.5 shrink-0 items-center justify-center rounded-[3px] border transition"
                    class:border-border={!promptChecked(stem)}
                    class:border-foreground={promptChecked(stem)}
                    class:bg-foreground={promptChecked(stem)}
                  >
                    {#if promptChecked(stem)}
                      <Check class="size-2.5 text-[var(--color-surface-2)]" strokeWidth={3} />
                    {/if}
                  </span>
                  <span class="min-w-0 truncate font-mono text-[10.5px]">{stem}</span>
                </button>
              {/each}
            {/if}
            <button
              type="button"
              class="mt-2 rounded bg-[var(--color-surface-3)] px-2 py-1.5 text-[11.5px] font-medium text-foreground transition hover:bg-accent"
              onclick={launch}
            >
              {t("fastpick.launch")}
            </button>
          {/if}
        </div>
      </div>
    {/if}
  </div>
{/if}
