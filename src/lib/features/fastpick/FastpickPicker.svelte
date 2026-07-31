<script lang="ts">
  import { onMount, onDestroy, tick } from "svelte";
  import { scale } from "svelte/transition";
  import { settings } from "$lib/features/settings/store.svelte";
  import { t } from "$lib/i18n/index.svelte";
  import { launchFastpick, launchTargetProjectId } from "$lib/features/thread/api";
  import { registerEscape, restoreFocus, viewportHeight } from "$lib/shared/keyboard/overlay";
  import ShortcutIcon from "$lib/shared/icons/ShortcutIcon.svelte";
  import { fastpick } from "./store.svelte";
  import { iconKeyForKind, modelLabels, type FastpickCombo } from "./combo";
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
  // Which provider the picked model came from. It is not always the one being browsed: the
  // selection outlives the pane it was made in, and walking back to pick another provider
  // leaves it standing.
  let modelProviderId = $state<string | null>(null);
  let effort = $state<string | null>(null);
  // Undefined means "let fastpick pick the file matching the model", which is what its own
  // menu starts on. Selecting anything here makes the choice explicit.
  let prompts = $state<string[] | undefined>(undefined);

  let triggerRoot: HTMLDivElement | null = $state(null);
  let menu: HTMLDivElement | null = $state(null);
  let menuPos = $state({ x: 0, y: 0 });
  const EDGE_GAP = 4;

  const harness = $derived<FastpickHarness | null>(
    fastpick.harnesses.find((h) => h.id === harnessId) ?? null,
  );
  const providers = $derived(harnessId ? fastpick.providersFor(harnessId) : []);
  const models = $derived(providerId ? fastpick.models[providerId] ?? null : null);
  // Resolved once per list rather than per row: telling a label apart takes the whole list,
  // so no row can name itself.
  const labels = $derived(modelLabels(models?.items ?? []));
  // The picked model is named from its own provider's list, which the browsed one stops
  // being as soon as the user walks back. Naming it from the browsed list would drop it to
  // the raw label this disambiguation exists to replace, or worse, hand it the name another
  // provider resolved for a model that happens to share its id.
  const selectedModels = $derived(
    modelProviderId ? fastpick.models[modelProviderId] ?? null : null,
  );
  const selectedLabels = $derived(modelLabels(selectedModels?.items ?? []));
  const selectedName = $derived(
    model ? selectedLabels.get(model.id) ?? model.label ?? model.id : "",
  );

  function nameOf(m: FastpickModel): string {
    return labels.get(m.id) ?? m.label ?? m.id;
  }

  function reset() {
    pane = "harness";
    harnessId = null;
    providerId = null;
    model = null;
    modelProviderId = null;
    effort = null;
    prompts = undefined;
  }

  function toggle(e: MouseEvent) {
    e.stopPropagation();
    if (open) {
      open = false;
      return;
    }
    anchor();
    reset();
    open = true;
    void fastpick.ensure();
  }

  // Fixed positioning: the shortcut bar scrolls horizontally, which would clip an
  // absolutely-positioned menu inside it. First guess only, taken before the menu
  // exists; `place` refines it once there is something to measure.
  function anchor() {
    if (!triggerRoot) return;
    const r = triggerRoot.getBoundingClientRect();
    menuPos = { x: r.left, y: r.bottom + 4 };
  }

  async function place() {
    anchor();
    await tick();
    if (!menu || !triggerRoot) return;
    const r = triggerRoot.getBoundingClientRect();
    // Layout box, not the painted one: the open transition scales the menu, and
    // a measurement taken mid-transition is smaller than what has to fit.
    const w = menu.offsetWidth;
    const h = menu.offsetHeight;
    const vw = window.innerWidth;
    const vh = viewportHeight();
    const below = r.bottom + 4;
    menuPos = {
      // The trigger lives in a bar that scrolls sideways, so near the right edge
      // the menu used to run off screen.
      x: Math.max(EDGE_GAP, Math.min(r.left, vw - w - EDGE_GAP)),
      // Flipped above the trigger rather than clamped when the room below is
      // gone: a clamp alone parks the menu over the button that opened it.
      y: below + h + EDGE_GAP <= vh ? below : Math.max(EDGE_GAP, r.top - 4 - h),
    };
  }

  $effect(() => {
    if (!open) return;
    // Every pane is a different height, so the flip decision is re-made on each
    // step rather than once at open.
    void pane;
    void models;
    void place();
    const replace = () => void place();
    window.addEventListener("resize", replace);
    // A soft keyboard shrinks the visual viewport without necessarily resizing
    // the window, and it is the room under the trigger that changed.
    window.visualViewport?.addEventListener("resize", replace);
    return () => {
      window.removeEventListener("resize", replace);
      window.visualViewport?.removeEventListener("resize", replace);
    };
  });

  $effect(() => {
    if (!open) return;
    return registerEscape(() => (open = false));
  });

  $effect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const surface = menu;
    return () => restoreFocus(previous, surface);
  });

  // Picking a harness replaces the whole list, so the row that was clicked is
  // gone by the time the next pane paints and the keyboard would be left on
  // <body>. Re-aimed on every pane, and again when a pane's rows arrive.
  $effect(() => {
    if (!open) return;
    void pane;
    void models;
    void fastpick.harnesses;
    let cancelled = false;
    void tick().then(() => {
      if (cancelled || !open) return;
      (rows()[0] ?? menu)?.focus();
    });
    return () => {
      cancelled = true;
    };
  });

  function rows(): HTMLElement[] {
    return Array.from(
      menu?.querySelectorAll<HTMLElement>('[role^="menuitem"]:not(:disabled)') ?? [],
    );
  }

  function focusables(): HTMLElement[] {
    return Array.from(
      menu?.querySelectorAll<HTMLElement>("button:not(:disabled)") ?? [],
    );
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

  function pickModel(m: FastpickModel, forceScratch: boolean) {
    model = m;
    modelProviderId = providerId;
    effort = harness?.supportsEffort ? m.effortDefault : null;
    prompts = undefined;
    void launch(forceScratch);
  }

  function openOptions(m: FastpickModel, e: MouseEvent) {
    e.stopPropagation();
    model = m;
    modelProviderId = providerId;
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

  // Lands where every other launcher does: the project you are on, or Scratch
  // when you are on none, with shift asking for Scratch outright. No right-click
  // menu though, unlike a shortcut: this button opens a menu of its own, and the
  // two would be fighting over the same gesture.
  async function launch(forceScratch = false) {
    if (!harness || !providerId || !model) return;
    const combo: FastpickCombo = {
      harness: harness.id,
      provider: providerId,
      model: model.id,
      effort,
      prompts,
    };
    open = false;
    const projectId = await launchTargetProjectId(forceScratch);
    if (!projectId) return;
    await launchFastpick(combo, harness, projectId);
  }

  function sourceLabel(source: { kind: string; ageSecs?: number }): string {
    if (source.kind === "live") return t("fastpick.sourceLive");
    if (source.kind === "cache") return t("fastpick.sourceCache");
    if (source.kind === "failed") return t("fastpick.sourceFailed");
    return t("fastpick.sourceConfig");
  }

  // `pointerdown`, not `click`: picking a harness swaps the pane, and the browser
  // runs a microtask checkpoint between listeners, so Svelte has already detached
  // the clicked row by the time a document-level `click` looks at it. The menu
  // would then read its own item as an outside click and close on every step.
  function handleDocPointerDown(e: PointerEvent) {
    if (!open) return;
    const target = e.target as Node;
    if (triggerRoot?.contains(target) || menu?.contains(target)) return;
    open = false;
  }

  // Escape is handled by the shared stack, which runs before the global shortcut
  // dispatcher; everything here needs focus to be inside the menu, which it is.
  function handleMenuKeydown(e: KeyboardEvent) {
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      back();
      return;
    }
    const items = rows();
    const active = document.activeElement as HTMLElement | null;

    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (items.length === 0) return;
      const idx = active ? items.indexOf(active) : -1;
      const last = items.length - 1;
      const down = e.key === "ArrowDown";
      if (idx < 0) items[down ? 0 : last].focus();
      else items[(idx + (down ? 1 : -1) + items.length) % items.length].focus();
      return;
    }
    if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      if (items.length === 0) return;
      items[e.key === "Home" ? 0 : items.length - 1].focus();
      return;
    }
    if (e.key === "Tab") {
      // Trapped, back and refresh included: Tab out of the menu left it open
      // over a bar the keyboard had already left.
      e.preventDefault();
      const all = focusables();
      if (all.length === 0) return;
      const idx = active ? all.indexOf(active) : -1;
      const last = all.length - 1;
      if (idx < 0) all[e.shiftKey ? last : 0].focus();
      else all[(idx + (e.shiftKey ? -1 : 1) + all.length) % all.length].focus();
    }
    // Enter and Space need nothing: every row is a button.
  }

  onMount(() => {
    document.addEventListener("pointerdown", handleDocPointerDown);
    // Probed once so the button can hide itself on a machine with no fastpick, rather
    // than offering a menu whose every entry fails. Turned off in the settings, nothing
    // is asked at all: the answer would only decide how to hide a button already hidden.
    if (settings.state.fastpickEnabled) void fastpick.ensure();
  });

  onDestroy(() => {
    document.removeEventListener("pointerdown", handleDocPointerDown);
  });
</script>

{#if settings.state.fastpickEnabled && fastpick.installed !== false}
  <div bind:this={triggerRoot} class="relative flex shrink-0 items-stretch">
    <button
      type="button"
      class="flex shrink-0 items-center gap-1.5 rounded-md border border-dashed border-border px-2.5 py-1 text-xs text-muted-foreground transition hover:border-foreground/30 hover:bg-[var(--color-surface-2)] hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
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
        class="surface-popover fixed z-[var(--z-popover)] flex max-h-[60vh] min-w-64 flex-col overflow-hidden"
        style:left="{menuPos.x}px"
        style:top="{menuPos.y}px"
        style:transform-origin="top left"
        onkeydown={handleMenuKeydown}
        transition:scale={{ duration: 90, start: 0.96 }}
      >
        <div
          class="flex items-center gap-1.5 border-b border-border px-2 py-1.5 text-xs text-muted-foreground"
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
            {:else}{selectedName}{/if}
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
            <div class="px-2 py-1.5 text-xs text-muted-foreground">{t("common.loading")}</div>
          {:else if fastpick.error}
            <div class="px-2 py-1.5 text-xs text-destructive">{fastpick.error}</div>
          {:else if pane === "harness"}
            {#if fastpick.harnesses.length === 0}
              <div class="px-2 py-1.5 text-xs text-muted-foreground">
                {t("fastpick.noHarness")}
              </div>
            {/if}
            {#each fastpick.harnesses as h (h.id)}
              <button
                type="button"
                role="menuitem"
                class="flex items-center gap-2 rounded px-2 py-1.5 text-left text-sm text-foreground/85 transition hover:bg-accent hover:text-foreground focus-visible:bg-accent focus-visible:text-foreground focus-visible:outline-none"
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
                class="flex items-center gap-2 rounded px-2 py-1.5 text-left text-sm text-foreground/85 transition hover:bg-accent hover:text-foreground focus-visible:bg-accent focus-visible:text-foreground focus-visible:outline-none"
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
              <div class="px-2 py-1.5 text-xs text-muted-foreground">{t("common.loading")}</div>
            {:else if providerId && fastpick.modelsError[providerId]}
              <div class="px-2 py-1.5 text-xs text-destructive">
                {fastpick.modelsError[providerId]}
              </div>
            {:else if models}
              <div class="px-2 pb-1 text-2xs text-muted-foreground/70">
                {sourceLabel(models.source)}
              </div>
              {#each models.items as m (m.id)}
                <div
                  class="group flex items-center rounded transition hover:bg-accent"
                >
                  <button
                    type="button"
                    role="menuitem"
                    class="flex min-w-0 flex-1 items-baseline gap-2 rounded px-2 py-1.5 text-left text-sm text-foreground/85 transition group-hover:text-foreground focus-visible:bg-accent focus-visible:text-foreground focus-visible:outline-none"
                    onclick={(e) => pickModel(m, e.shiftKey)}
                  >
                    <span class="min-w-0 truncate font-medium">{nameOf(m)}</span>
                    {#if m.contextWindow}
                      <span class="shrink-0 font-mono text-2xs text-muted-foreground/70">
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
              <div class="px-2 pb-1 pt-1 text-2xs uppercase tracking-wide text-muted-foreground/70">
                {t("fastpick.effort")}
              </div>
              {#each model.effort as level (level)}
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={effort === level}
                  class="flex items-center gap-2 rounded px-2 py-1.5 text-left text-sm text-foreground/85 transition hover:bg-accent hover:text-foreground focus-visible:bg-accent focus-visible:text-foreground focus-visible:outline-none"
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
              <div class="px-2 pb-1 pt-2 text-2xs uppercase tracking-wide text-muted-foreground/70">
                {t("fastpick.systemPrompt")}
              </div>
              {#each model.prompts as stem (stem)}
                <button
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={promptChecked(stem)}
                  class="flex items-center gap-2 rounded px-2 py-1.5 text-left text-sm text-foreground/85 transition hover:bg-accent hover:text-foreground focus-visible:bg-accent focus-visible:text-foreground focus-visible:outline-none"
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
                  <span class="min-w-0 truncate font-mono text-xs">{stem}</span>
                </button>
              {/each}
            {/if}
            <button
              type="button"
              role="menuitem"
              class="mt-2 rounded bg-[var(--color-surface-3)] px-2 py-1.5 text-sm font-medium text-foreground transition hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
              onclick={(e) => void launch(e.shiftKey)}
            >
              {t("fastpick.launch")}
            </button>
          {/if}
        </div>
      </div>
    {/if}
  </div>
{/if}
