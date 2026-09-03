<script lang="ts">
  import { fade, scale } from "svelte/transition";
  import ShortcutIcon from "$lib/shared/icons/ShortcutIcon.svelte";
  import { focusTrap } from "$lib/shared/actions/focusTrap";
  import { palette } from "./store.svelte";
  import { app } from "$lib/app/store.svelte";
  import { projectScripts } from "$lib/features/project/scripts.svelte";
  import { t, type MessageKey } from "$lib/i18n/index.svelte";
  import { scrollIntoViewSmooth } from "$lib/theme/motion";
  import {
    buildContentCommands,
    buildPaletteCommands,
    commandHint,
    commandLabel,
    type PaletteCommand,
  } from "./registry";
  import {
    FILE_SEARCH_MIN,
    modeQueriesBackend,
    parsePaletteQuery,
    type PaletteMode,
  } from "./modes";
  import { searchFileCommands } from "./files";
  import { openBrowserPane } from "./open-url";
  import { rankRows, sectionTitleKeyAt, type PaletteRow } from "./rank";
  import { paletteSearch } from "./search.svelte";
  import Highlight from "./Highlight.svelte";

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
  let fileRows = $state<PaletteCommand[]>([]);
  // Which search the rows in `fileRows` answer. A slow one landing after a
  // newer term was typed is dropped rather than shown, which is the whole
  // difference between a file list and a file list that flickers backwards.
  let fileGeneration = 0;

  const parsed = $derived(parsePaletteQuery(debouncedQuery, palette.mode));
  // The mode as the box is being typed in, which the debounce must not lag:
  // the placeholder and the prompt glyph have to change on the keystroke that
  // switched the mode, not 80ms later.
  const liveMode = $derived(parsePaletteQuery(query, palette.mode).mode);

  const PLACEHOLDER: Record<PaletteMode, MessageKey> = {
    commands: "palette.placeholder",
    files: "palette.placeholderFiles",
    url: "palette.placeholderUrl",
  };

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

  // Read on open, not on boot: it is a readDir plus a file read per project,
  // and the list is only ever looked at from in here. Re-read every time, so a
  // script added while the app was running is offered rather than a cached
  // answer from whenever the project was first selected.
  $effect(() => {
    if (!palette.open) return;
    const folder =
      app.projects.find((p) => p.id === app.currentProjectId)?.cwd ?? null;
    void projectScripts.ensure(folder, true);
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
    // Rebuilds whenever anything it is built from moves, the script list landing
    // included: `forFolder` is read from in here, so no callback is needed.
    // Nothing but `commands` is assigned, and that is the point: the script read
    // above takes tens of milliseconds locally and a full round trip against a
    // remote boite, so anything else this touched would be undone under a user
    // who started typing the moment the palette appeared.
    commands = buildPaletteCommands();
  });

  // Opening is what clears the field, so this reads `palette.open` and nothing
  // else. Kept apart from the rebuild above for that one reason: the rebuild
  // re-runs when the script read lands, and everything below would then be
  // undone under a user who started typing the moment the palette appeared.
  //
  // A palette opened straight into a mode carries no prefix: the mode is
  // already on the store, and a `/` the user did not type would be one more
  // character to delete before searching.
  $effect(() => {
    if (!palette.open) return;
    fileRows = [];
    fileGeneration++;
    query = "";
    debouncedQuery = "";
    activeIndex = 0;
    queueMicrotask(() => inputEl?.focus());
  });

  // The one mode whose answers are on the other side of the backend. Guarded on
  // the palette being open so a search does not land into a closed box, and
  // generation-checked so an older, slower answer never replaces a newer one.
  $effect(() => {
    if (!palette.open || parsed.mode !== "files") return;
    const term = parsed.term.trim();
    const generation = ++fileGeneration;
    if (term.length < FILE_SEARCH_MIN) {
      fileRows = [];
      return;
    }
    void searchFileCommands(term).then((rows) => {
      if (generation !== fileGeneration) return;
      fileRows = rows;
    });
  });

  // Resolved at render, not while the list is built: a fixed command carries a
  // dictionary key, so switching language re-renders instead of going stale.
  const rows = $derived.by<PaletteRow[]>(() => {
    const all = [...commands, ...buildContentCommands(paletteSearch.hits)];
    return all.map((c) => ({ c, label: commandLabel(c), hint: commandHint(c) }));
  });

  const visible = $derived.by<PaletteRow[]>(() => {
    // A mode that asks the backend is never re-scored here: it already decided
    // what matches and in which order, and a second matcher over its answer
    // drops hits it found by a rule this one does not have. Same reasoning
    // `rank.ts` applies to a content hit, one level up.
    if (modeQueriesBackend(parsed.mode)) {
      return fileRows.map((c) => ({ c, label: commandLabel(c), hint: commandHint(c) }));
    }
    if (parsed.mode === "url") return [];
    return rankRows(rows, parsed.term);
  });

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
    // A command that asks for one more piece of typing keeps the box, and puts
    // the caret back in it. The mode is on the store, so the parse below reads
    // the new one on the next keystroke as well as on this render.
    if (c.mode) {
      palette.mode = c.mode;
      query = "";
      debouncedQuery = "";
      activeIndex = 0;
      queueMicrotask(() => inputEl?.focus());
      return;
    }
    palette.hide();
    void c.run?.();
  }

  // Enter in url mode. The address stays in the box when it is refused, which
  // is the one thing the OS prompt this replaces could not do: it closed on
  // every answer, right or wrong, and the retry started from an empty field.
  function submitUrl() {
    if (openBrowserPane(query)) palette.hide();
  }

  function moveActive(delta: number) {
    if (visible.length === 0) return;
    activeIndex = (activeIndex + delta + visible.length) % visible.length;
    const el = listEl?.querySelector(`#palette-item-${activeIndex}`);
    scrollIntoViewSmooth(el);
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
      if (liveMode === "url") {
        submitUrl();
        return;
      }
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
      use:focusTrap
    >
      <input
        bind:this={inputEl}
        bind:value={query}
        type="text"
        placeholder={t(PLACEHOLDER[liveMode])}
        spellcheck="false"
        autocomplete="off"
        class="w-full border-b border-edge bg-transparent px-4 py-3 text-sm text-foreground focus:outline-none focus-visible:focus-ring-inset placeholder:text-muted-2"
        aria-label={t("palette.inputLabel")}
        role="combobox"
        aria-expanded="true"
        aria-controls="palette-list"
        aria-activedescendant={visible.length > 0 ? `palette-item-${activeIndex}` : undefined}
      />
      <div
        bind:this={listEl}
        id="palette-list"
        role="listbox"
        class="scroll-pane overflow-y-auto py-1"
      >
        {#if liveMode === "url"}
          <p class="px-4 py-6 text-center text-xs text-muted-foreground">
            {t("palette.urlHint")}
          </p>
        {:else if visible.length === 0}
          <p class="px-4 py-6 text-center text-xs text-muted-foreground">
            {liveMode === "files" && parsed.term.trim().length < FILE_SEARCH_MIN
              ? t("palette.filesHint")
              : t("palette.noMatch")}
          </p>
        {/if}
        {#each visible as row, i (row.c.id)}
          {@const title = sectionTitleAt(i)}
          {#if title}
            <p class="px-4 pt-2.5 pb-1 text-2xs font-semibold tracking-wider text-muted-2 uppercase">
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
                : 'text-foreground hover:bg-[var(--color-surface-2)]'}"
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
              <span class="shrink-0 text-2xs font-semibold tracking-wider text-muted-2 uppercase">
                {t(row.c.badgeKey)}
              </span>
              <span class="min-w-0 flex-1 truncate text-sm">
                <Highlight text={row.label} ranges={row.matchedField === "label" ? row.ranges : undefined} />
              </span>
              {#if row.hint}
                <span class="max-w-[40%] shrink-0 truncate text-xs text-muted-2">
                  <Highlight text={row.hint} ranges={row.matchedField === "hint" ? row.ranges : undefined} />
                </span>
              {/if}
            {:else}
              <span class="min-w-0 truncate">
                <Highlight text={row.label} ranges={row.matchedField === "label" ? row.ranges : undefined} />
              </span>
              {#if row.hint}
                <span class="min-w-0 flex-1 truncate text-xs text-muted-2">
                  <Highlight text={row.hint} ranges={row.matchedField === "hint" ? row.ranges : undefined} />
                </span>
              {/if}
            {/if}
          </button>
        {/each}
      </div>
    </div>
  </div>
{/if}
