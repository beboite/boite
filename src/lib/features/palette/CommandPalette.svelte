<script lang="ts">
  import { fade, scale } from "svelte/transition";
  import { palette } from "./store.svelte";
  import { fuzzyScore } from "./fuzzy";
  import {
    buildPaletteCommands,
    SECTION_BIAS,
    SECTION_TITLES,
    type PaletteCommand,
    type PaletteSection,
  } from "./registry";

  const SECTIONS: PaletteSection[] = ["threads", "actions", "projects"];
  const SEARCH_DEBOUNCE_MS = 80;

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

  $effect(() => {
    if (!palette.open) return;
    commands = buildPaletteCommands();
    query = "";
    debouncedQuery = "";
    activeIndex = 0;
    queueMicrotask(() => inputEl?.focus());
  });

  const visible = $derived.by(() => {
    const q = debouncedQuery.trim();
    if (!q) {
      return SECTIONS.flatMap((s) => commands.filter((c) => c.section === s));
    }
    const scored: { c: PaletteCommand; score: number }[] = [];
    for (const c of commands) {
      const target = c.hint ? `${c.label} ${c.hint}` : c.label;
      const score = fuzzyScore(q, target);
      if (score !== null) {
        scored.push({ c, score: score + SECTION_BIAS[c.section] });
      }
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.map((x) => x.c);
  });

  $effect(() => {
    void visible;
    activeIndex = 0;
  });

  function sectionTitleAt(index: number): string | null {
    const item = visible[index];
    if (!item) return null;
    if (index === 0 || visible[index - 1].section !== item.section) {
      return SECTION_TITLES[item.section];
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
      const c = visible[activeIndex];
      if (c) runCommand(c);
    }
  }

  function backdropClick(e: MouseEvent) {
    if (e.target === e.currentTarget) palette.hide();
  }
</script>

{#if palette.open}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div
    class="fixed inset-0 z-50 flex justify-center bg-black/50 pt-[12vh] backdrop-blur-[2px]"
    role="dialog"
    aria-modal="true"
    aria-label="Command palette"
    tabindex="-1"
    onclick={backdropClick}
    transition:fade={{ duration: 100 }}
  >
    <div
      class="flex h-fit max-h-[60vh] w-[560px] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-xl border border-border bg-[var(--color-surface)] shadow-2xl"
      transition:scale={{ duration: 120, start: 0.98 }}
      onkeydown={handleKeydown}
      role="presentation"
    >
      <input
        bind:this={inputEl}
        bind:value={query}
        type="text"
        placeholder="Search threads, actions, projects…"
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
            No matching command
          </p>
        {/if}
        {#each visible as c, i (c.id)}
          {@const title = sectionTitleAt(i)}
          {#if title}
            <p class="px-4 pt-2.5 pb-1 text-[10px] font-semibold tracking-wider text-muted-foreground/60 uppercase">
              {title}
            </p>
          {/if}
          <button
            type="button"
            id="palette-item-{i}"
            role="option"
            aria-selected={i === activeIndex}
            class="flex w-full items-baseline gap-2 px-4 py-1.5 text-left text-[13px]
              {i === activeIndex
                ? 'bg-[var(--color-surface-3)] text-foreground'
                : 'text-foreground/85 hover:bg-[var(--color-surface-2)]'}"
            onpointerenter={() => (activeIndex = i)}
            onclick={() => runCommand(c)}
          >
            <span class="min-w-0 truncate">{c.label}</span>
            {#if c.hint}
              <span class="min-w-0 flex-1 truncate text-[11px] text-muted-foreground/70">
                {c.hint}
              </span>
            {/if}
          </button>
        {/each}
      </div>
    </div>
  </div>
{/if}
