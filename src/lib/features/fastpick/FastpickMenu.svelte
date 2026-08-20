<script lang="ts">
  import { onMount, tick } from "svelte";
  import { tip } from "$lib/shared/actions/tooltip";
  import { t } from "$lib/i18n/index.svelte";
  import {
    launchFastpick,
    launchTargetProjectId,
    warmWorktreeFor,
  } from "$lib/features/thread/api";
  import { app } from "$lib/app/store.svelte";
  import ShortcutIcon from "$lib/shared/icons/ShortcutIcon.svelte";
  import { fastpick } from "./store.svelte";
  import { iconKeyForKind, modelLabels, type FastpickCombo } from "./combo";
  import { filterModels } from "./model-search";
  import type { FastpickHarness, FastpickModel } from "$lib/backend/types";
  import ChevronLeft from "@lucide/svelte/icons/chevron-left";
  import ChevronRight from "@lucide/svelte/icons/chevron-right";
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import Check from "@lucide/svelte/icons/check";
  import KeyRound from "@lucide/svelte/icons/key-round";

  // One pane at a time rather than three columns: the menu is narrow, and each answer
  // narrows the next one anyway, so a pane that is already decided is only in the way.
  type Pane = "harness" | "provider" | "model" | "options";

  /**
   * The fastpick walk itself: harness, provider, model, options, and the launch.
   *
   * No surface, no placement, no open state — those belong to whoever shows it.
   * It is here rather than inside `FastpickPicker` because the launcher popover
   * shows the same walk in its own box: when this lived in the picker, reaching
   * fastpick from the launcher opened a second floating menu on top of the first,
   * and picking a model meant crossing two stacked popovers.
   *
   * `onExit` is what the back arrow does on the first pane. Given, the walk has
   * somewhere to return to (the launcher's own list) and says so; left out, the
   * first pane is the top and shows no arrow.
   */
  type Props = {
    projectId?: string | null;
    onLaunched?: () => void;
    onExit?: () => void;
    /** Every pane is a different height, so a host that positions itself re-places here. */
    onResize?: () => void;
  };
  let { projectId = null, onLaunched, onExit, onResize }: Props = $props();

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

  let root: HTMLDivElement | null = $state(null);
  let search: HTMLInputElement | null = $state(null);
  let query = $state("");

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

  const shown = $derived(filterModels(models?.items ?? [], query, nameOf));

  $effect(() => {
    void pane;
    void models;
    onResize?.();
  });

  // Picking a harness replaces the whole list, so the row that was clicked is
  // gone by the time the next pane paints and the keyboard would be left on
  // <body>. Re-aimed on every pane, and again when a pane's rows arrive.
  $effect(() => {
    void pane;
    void models;
    void fastpick.harnesses;
    let cancelled = false;
    void tick().then(() => {
      if (cancelled) return;
      // The model pane opens on its search box, so the first letter typed is already
      // a search and never a lost keystroke.
      if (pane === "model" && search) {
        search.focus();
        return;
      }
      (rows()[0] ?? root)?.focus();
    });
    return () => {
      cancelled = true;
    };
  });

  function rows(): HTMLElement[] {
    return Array.from(
      root?.querySelectorAll<HTMLElement>('[role^="menuitem"]:not(:disabled)') ?? [],
    );
  }

  function focusables(): HTMLElement[] {
    return Array.from(root?.querySelectorAll<HTMLElement>("button:not(:disabled)") ?? []);
  }

  function pickHarness(id: string) {
    harnessId = id;
    pane = "provider";
  }

  function pickProvider(id: string) {
    providerId = id;
    pane = "model";
    query = "";
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
    else if (pane === "model") {
      query = "";
      pane = "provider";
    } else if (pane === "provider") pane = "harness";
    else onExit?.();
  }

  // Lands where every other launcher does: the project you are on, or Scratch
  // when you are on none, with shift asking for Scratch outright. No right-click
  // menu though, unlike a shortcut: this walk owns the gesture already.
  async function launch(forceScratch = false) {
    if (!harness || !providerId || !model) return;
    const combo: FastpickCombo = {
      harness: harness.id,
      provider: providerId,
      model: model.id,
      effort,
      prompts,
    };
    // Read before closing, never after: the prop is a getter, and the launcher
    // spells it `launcher.projectId` over state its own `onLaunched` sets to
    // null. Reading it afterwards threw on every launch from the sidebar
    // popover, which is a click that does nothing and says nothing.
    const own = projectId;
    // Before the await, not after it: the combination is picked, so the menu has
    // nothing left to ask, and holding it open through a checkout reads as a
    // click that did nothing.
    onLaunched?.();
    const target = own ?? (await launchTargetProjectId(forceScratch));
    if (!target) return;
    await launchFastpick(combo, harness, target);
  }

  function sourceLabel(source: { kind: string; ageSecs?: number }): string {
    if (source.kind === "live") return t("fastpick.sourceLive");
    if (source.kind === "cache") return t("fastpick.sourceCache");
    if (source.kind === "failed") return t("fastpick.sourceFailed");
    return t("fastpick.sourceConfig");
  }

  // Escape is handled by whoever owns the surface, and it runs before the global
  // shortcut dispatcher; everything here needs focus to be inside the menu.
  function handleKeydown(e: KeyboardEvent) {
    const items = rows();
    const active = document.activeElement as HTMLElement | null;
    // Left, Home and End are caret moves while the box has the keyboard, so the walk
    // only claims them elsewhere.
    const typing = active === search && search !== null;

    if (e.key === "ArrowLeft" && !typing) {
      e.preventDefault();
      back();
      return;
    }
    if (typing && e.key === "Enter") {
      e.preventDefault();
      const first = shown[0];
      if (first) pickModel(first, e.shiftKey);
      return;
    }
    // A letter typed on a row goes to the box rather than nowhere, which is what makes
    // this a search you can start without aiming at anything. Space is left alone: it
    // is how a focused row is pressed.
    if (
      !typing &&
      pane === "model" &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.altKey &&
      (e.key === "Backspace" || (e.key.length === 1 && e.key !== " "))
    ) {
      e.preventDefault();
      query = e.key === "Backspace" ? query.slice(0, -1) : query + e.key;
      search?.focus();
      return;
    }

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
    if ((e.key === "Home" || e.key === "End") && !typing) {
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
    void fastpick.ensure();
    // This menu appearing is a launch that has not picked its combination yet, and
    // walking the panes takes long enough that the checkout is finished before the
    // click lands. The project switch is the other sign, but it never fires for the
    // project the app came up on — reload, open this, launch, and the thread was
    // paying for its own worktree in front of a black terminal.
    warmWorktreeFor(app.projects.find((p) => p.id === app.currentProjectId) ?? null);
  });
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
  bind:this={root}
  role="menu"
  tabindex="-1"
  class="flex min-h-0 flex-1 flex-col focus-visible:outline-none"
  onkeydown={handleKeydown}
>
  <div
    class="flex items-center gap-1.5 border-b border-border px-2 py-1.5 text-xs text-muted-foreground"
  >
    {#if pane !== "harness" || onExit}
      <button
        type="button"
        class="flex items-center rounded p-0.5 transition hover:bg-accent hover:text-foreground"
        onclick={back}
        aria-label={t("fastpick.back")}
        use:tip={t("fastpick.back")}
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
        use:tip={t("fastpick.refresh")}
      >
        <RefreshCw class="size-3" />
      </button>
    {/if}
  </div>

  {#if pane === "model" && models && fastpick.loadingModels !== providerId}
    <div class="border-b border-border px-2 py-1.5">
      <input
        bind:this={search}
        bind:value={query}
        type="text"
        autocomplete="off"
        spellcheck="false"
        class="w-full bg-transparent text-xs text-foreground placeholder:text-muted-foreground/70 focus:outline-none"
        placeholder={t("fastpick.search")}
        aria-label={t("fastpick.search")}
      />
    </div>
  {/if}

  <div class="flex min-h-0 flex-col scroll-pane overflow-y-auto p-1">
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
          {sourceLabel(models.source)}{query
            ? ` · ${shown.length}/${models.items.length}`
            : ""}
        </div>
        {#if shown.length === 0}
          <div class="px-2 py-1.5 text-xs text-muted-foreground">
            {t("fastpick.noMatch")}
          </div>
        {/if}
        {#each shown as m (m.id)}
          {@const hasOptions =
            (harness?.supportsEffort && m.effort.length > 0) ||
            (harness?.supportsSystemPrompts && m.prompts.length > 0)}
          <div class="group flex items-stretch rounded transition hover:bg-accent">
            <button
              type="button"
              role="menuitem"
              class="flex min-w-0 flex-1 items-baseline gap-2 rounded px-2 py-1.5 text-left text-sm text-foreground/85 transition group-hover:text-foreground focus-visible:bg-accent focus-visible:text-foreground focus-visible:outline-none"
              onclick={(e) => pickModel(m, e.shiftKey)}
            >
              <span class="min-w-0 truncate font-medium">{nameOf(m)}</span>
              {#if m.contextWindow}
                <span class="shrink-0 tabular-nums text-2xs font-medium text-muted-foreground/70">
                  {Math.round(m.contextWindow / 1000)}K
                </span>
              {/if}
            </button>
            <!-- A second target, and it has to look like one: clicking the name
                 launches, clicking here opens effort and prompts instead. It was
                 a bare chevron the same colour as the row it sat on, which reads
                 as an ornament, so the pane behind it went unfound. The hairline
                 says where one button ends and the next begins; the surface under
                 it on hover says it is a button at all. -->
            {#if hasOptions}
              <button
                type="button"
                class="flex shrink-0 items-center rounded-r border-l border-border/60 px-1.5 text-muted-foreground/70 transition hover:bg-[var(--color-surface-3)] hover:text-foreground focus-visible:bg-[var(--color-surface-3)] focus-visible:text-foreground focus-visible:outline-none group-hover:text-foreground/70"
                onclick={(e) => openOptions(m, e)}
                aria-label={t("fastpick.options")}
                use:tip={t("fastpick.options")}
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
            <span class="min-w-0 truncate text-xs">{stem}</span>
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
