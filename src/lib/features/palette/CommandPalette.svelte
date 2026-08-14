<script lang="ts">
  import { fade, scale } from "svelte/transition";
  import ShortcutIcon from "$lib/shared/icons/ShortcutIcon.svelte";
  import { palette } from "./store.svelte";
  import { t } from "$lib/i18n/index.svelte";
  import {
    buildContentCommands,
    buildPaletteCommands,
    commandHint,
    commandLabel,
    type PaletteCommand,
  } from "./registry";
  import { rankRows, sectionTitleKeyAt, type PaletteRow } from "./rank";
  import { paletteSearch } from "./search.svelte";

  // The local filter alone. The workspace query has its own, longer one in
  // `content.ts`: a fuzzy match over a few hundred strings is a frame, a round
  // trip that reads the tail of every transcript is not.
  const FILTER_DEBOUNCE_MS = 80;

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
    }, FILTER_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  });

  // The backend query is driven by the raw text, not by the filtered one: it
  // carries its own timer, and stacking the two would put a third of a second
  // between the last keystroke and the request.
  $effect(() => {
    if (!palette.open) return;
    paletteSearch.query(query);
  });

  $effect(() => {
    if (!palette.open) {
      // Nothing in flight may land on the next open, and the hits on screen are
      // about a query nobody is typing any more.
      paletteSearch.clear();
      return;
    }
    commands = buildPaletteCommands();
    query = "";
    debouncedQuery = "";
    activeIndex = 0;
    queueMicrotask(() => inputEl?.focus());
  });

  // Resolved at render, not while the list is built: a fixed command carries a
  // dictionary key, so switching language re-renders instead of going stale.
  const rows = $derived.by<PaletteRow[]>(() => {
    const all = [...commands, ...buildContentCommands(paletteSearch.hits)];
    return all.map((c) => ({ c, label: commandLabel(c), hint: commandHint(c) }));
  });

  const visible = $derived.by(() => rankRows(rows, debouncedQuery));

  // A new query starts at the top. Keyed on the text rather than on the list,
  // because content hits land a moment after the commands do and a cursor that
  // jumped back to the top when they arrived would move under the user.
  $effect(() => {
    void debouncedQuery;
    activeIndex = 0;
  });

  // Hits that went away can leave the cursor past the end of the list.
  $effect(() => {
    const last = visible.length - 1;
    if (activeIndex > last) activeIndex = Math.max(0, last);
  });

  function sectionTitleAt(index: number): string | null {
    const key = sectionTitleKeyAt(visible, index);
    return key ? t(key) : null;
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
            <!-- A content hit is a sentence out of the workspace rather than a
                 command's name, so the excerpt takes the room and the badge
                 says which of the three places it came from. -->
            {#if row.c.badgeKey}
              <span class="shrink-0 text-2xs font-semibold tracking-wider text-muted-foreground/60 uppercase">
                {t(row.c.badgeKey)}
              </span>
              <span class="min-w-0 flex-1 truncate text-sm">{row.label}</span>
              {#if row.hint}
                <span class="max-w-[40%] shrink-0 truncate text-xs text-muted-foreground/70">
                  {row.hint}
                </span>
              {/if}
            {:else}
              <span class="min-w-0 truncate">{row.label}</span>
              {#if row.hint}
                <span class="min-w-0 flex-1 truncate text-xs text-muted-foreground/70">
                  {row.hint}
                </span>
              {/if}
            {/if}
          </button>
        {/each}
      </div>
    </div>
  </div>
{/if}
