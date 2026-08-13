<script lang="ts">
  import { fade, scale } from "svelte/transition";
  import ShortcutIcon from "$lib/shared/icons/ShortcutIcon.svelte";
  import { palette } from "./store.svelte";
  import { app } from "$lib/app/store.svelte";
  import { projectScripts } from "$lib/features/project/scripts.svelte";
  import { fuzzyScore } from "./fuzzy";
  import { t } from "$lib/i18n/index.svelte";
  import {
    buildPaletteCommands,
    commandHint,
    commandLabel,
    SECTION_BIAS,
    SECTION_TITLE_KEYS,
    type PaletteCommand,
    type PaletteSection,
  } from "./registry";

  // Same order as SECTION_BIAS. "panes" has to be listed or the pane commands
  // exist only for a typed query: the empty-query list is built from this array.
  const SECTIONS: PaletteSection[] = ["threads", "actions", "panes", "projects"];
  const SEARCH_DEBOUNCE_MS = 80;

  /** A command with its text resolved: what the row shows and what search matches. */
  type PaletteRow = { c: PaletteCommand; label: string; hint: string | null };

  let query = $state("");
  let debouncedQuery = $state("");
  let activeIndex = $state(0);
  let inputEl: HTMLInputElement | null = $state(null);
  let listEl: HTMLDivElement | null = $state(null);
  let commands = $state<PaletteCommand[]>([]);

  // A fast typist pays the filter once, not per character; clearing is instant.
  $effect(() => {
    const raw = query;
    if (raw.trim() === "") {
      debouncedQuery = "";
      return;
    }
    const timer = setTimeout(() => {
      debouncedQuery = raw;
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  });

  // Read on open, not on boot: it is a readDir plus a file read per project,
  // and the list is only ever looked at from in here. Re-read every time, so a
  // script added while the app was running is offered rather than a cached
  // answer from whenever the project was first selected.
  $effect(() => {
    if (!palette.open) return;
    const folder =
      app.projects.find((p) => p.id === app.currentProjectId)?.cwd ?? null;
    void projectScripts.ensure(folder, true).then(() => {
      if (palette.open) commands = buildPaletteCommands();
    });
  });

  $effect(() => {
    if (!palette.open) return;
    commands = buildPaletteCommands();
    query = "";
    debouncedQuery = "";
    activeIndex = 0;
    queueMicrotask(() => inputEl?.focus());
  });

  // Resolved at render, not while the list is built: a fixed command carries a
  // dictionary key, so switching language re-renders instead of going stale.
  const rows = $derived.by<PaletteRow[]>(() =>
    commands.map((c) => ({ c, label: commandLabel(c), hint: commandHint(c) })),
  );

  const visible = $derived.by(() => {
    const q = debouncedQuery.trim();
    if (!q) {
      return SECTIONS.flatMap((s) => rows.filter((r) => r.c.section === s));
    }
    const scored: { r: PaletteRow; score: number }[] = [];
    for (const r of rows) {
      const target = r.hint ? `${r.label} ${r.hint}` : r.label;
      const score = fuzzyScore(q, target);
      if (score !== null) {
        scored.push({ r, score: score + SECTION_BIAS[r.c.section] });
      }
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.map((x) => x.r);
  });

  $effect(() => {
    void visible;
    activeIndex = 0;
  });

  function sectionTitleAt(index: number): string | null {
    const item = visible[index];
    if (!item) return null;
    if (index === 0 || visible[index - 1].c.section !== item.c.section) {
      return t(SECTION_TITLE_KEYS[item.c.section]);
    }
    return null;
  }

  function runCommand(c: PaletteCommand) {
    palette.hide();
    void c.run();
  }

  function moveActive(delta: number) {
    if (visible.length === 0) return;
    activeIndex = (activeIndex + delta + visible.length) % visible.length;
    const el = listEl?.querySelector(`#palette-item-${activeIndex}`);
    el?.scrollIntoView({ block: "nearest" });
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      palette.hide();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      moveActive(1);
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      moveActive(-1);
      return;
    }
    if (e.key === "Home" && query === "") {
      e.preventDefault();
      activeIndex = 0;
      return;
    }
    if (e.key === "End" && query === "") {
      e.preventDefault();
      activeIndex = Math.max(0, visible.length - 1);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const row = visible[activeIndex];
      if (row) runCommand(row.c);
    }
  }

  function backdropClick(e: MouseEvent) {
    if (e.target === e.currentTarget) palette.hide();
  }
</script>

{#if palette.open}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div
    class="fixed inset-0 z-[var(--z-modal)] flex justify-center bg-[var(--color-scrim)] pt-[12vh] backdrop-blur-[2px]"
    role="dialog"
    aria-modal="true"
    aria-label={t("palette.title")}
    tabindex="-1"
    onclick={backdropClick}
    transition:fade={{ duration: 100 }}
  >
    <div
      class="surface-dialog flex h-fit max-h-[60vh] w-[560px] max-w-[calc(100vw-2rem)] flex-col overflow-hidden"
      transition:scale={{ duration: 120, start: 0.98 }}
      onkeydown={handleKeydown}
      role="presentation"
    >
      <input
        bind:this={inputEl}
        bind:value={query}
        type="text"
        placeholder={t("palette.placeholder")}
        spellcheck="false"
        autocomplete="off"
        class="w-full border-b border-border bg-transparent px-4 py-3 text-sm text-foreground outline-none placeholder:text-muted-foreground/60"
        role="combobox"
        aria-expanded="true"
        aria-controls="palette-list"
        aria-activedescendant={visible.length > 0 ? `palette-item-${activeIndex}` : undefined}
      />
      <div
        bind:this={listEl}
        id="palette-list"
        role="listbox"
        class="overflow-y-auto py-1"
      >
        {#if visible.length === 0}
          <p class="px-4 py-6 text-center text-xs text-muted-foreground">
            {t("palette.noMatch")}
          </p>
        {/if}
        {#each visible as row, i (row.c.id)}
          {@const title = sectionTitleAt(i)}
          {#if title}
            <p class="px-4 pt-2.5 pb-1 text-2xs font-semibold tracking-wider text-muted-foreground/60 uppercase">
              {title}
            </p>
          {/if}
          <button
            type="button"
            id="palette-item-{i}"
            role="option"
            aria-selected={i === activeIndex}
            class="flex w-full items-center gap-2 px-4 py-1.5 text-left text-base
              {i === activeIndex
                ? 'bg-[var(--color-surface-3)] text-foreground'
                : 'text-foreground/85 hover:bg-[var(--color-surface-2)]'}"
            onpointerenter={() => (activeIndex = i)}
            onclick={() => runCommand(row.c)}
          >
            <!-- Held even when empty: an icon on some rows and none on others
                 would step the labels in and out along the list. -->
            <span class="flex size-4 shrink-0 items-center justify-center">
              {#if row.c.icon}
                <ShortcutIcon iconKey={row.c.icon.key} size={14} color={row.c.icon.color} />
              {/if}
            </span>
            <span class="min-w-0 truncate">{row.label}</span>
            {#if row.hint}
              <span class="min-w-0 flex-1 truncate text-xs text-muted-foreground/70">
                {row.hint}
              </span>
            {/if}
          </button>
        {/each}
      </div>
    </div>
  </div>
{/if}
