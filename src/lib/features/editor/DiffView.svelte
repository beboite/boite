<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { EditorState, Compartment } from "@codemirror/state";
  import { EditorView, lineNumbers, highlightSpecialChars } from "@codemirror/view";
  import { MergeView } from "@codemirror/merge";
  import { boiteHighlight, boiteTheme } from "./theme";
  import { currentTheme } from "$lib/theme/current.svelte";
  import { loadLanguageExtension } from "./languages";

  interface Props {
    leftContent: string;
    rightContent: string;
    leftLabel: string;
    rightLabel: string;
    filename?: string | null;
  }

  let {
    leftContent,
    rightContent,
    leftLabel,
    rightLabel,
    filename = null,
  }: Props = $props();

  let host: HTMLElement | null = $state(null);
  let merge: MergeView | null = null;
  let langA = new Compartment();
  let langB = new Compartment();
  // One per side: a compartment belongs to the state it was configured in, and
  // a MergeView is two states.
  let themeA = new Compartment();
  let themeB = new Compartment();
  // Language loading is async; a second filename change must not be overtaken
  // by the first import resolving late.
  let langGeneration = 0;

  function baseExt(theme: Compartment) {
    return [
      lineNumbers(),
      highlightSpecialChars(),
      theme.of(boiteTheme(currentTheme.name)),
      boiteHighlight,
      EditorView.editable.of(false),
      EditorState.readOnly.of(true),
      EditorView.lineWrapping,
    ];
  }

  onMount(() => {
    if (!host) return;
    merge = new MergeView({
      a: { doc: leftContent, extensions: [...baseExt(themeA), langA.of([])] },
      b: { doc: rightContent, extensions: [...baseExt(themeB), langB.of([])] },
      parent: host,
      revertControls: undefined,
      collapseUnchanged: { margin: 3, minSize: 6 },
      gutter: true,
    });
    if (filename) void applyLanguage(filename);
  });

  onDestroy(() => {
    merge?.destroy();
    merge = null;
  });

  $effect(() => {
    if (!merge) return;
    const a = merge.a;
    const b = merge.b;
    const curA = a.state.doc.toString();
    const curB = b.state.doc.toString();
    if (curA !== leftContent) {
      a.dispatch({
        changes: { from: 0, to: curA.length, insert: leftContent },
      });
    }
    if (curB !== rightContent) {
      b.dispatch({
        changes: { from: 0, to: curB.length, insert: rightContent },
      });
    }
  });

  $effect(() => {
    if (filename && merge) void applyLanguage(filename);
  });

  $effect(() => {
    const next = boiteTheme(currentTheme.name);
    merge?.a.dispatch({ effects: themeA.reconfigure(next) });
    merge?.b.dispatch({ effects: themeB.reconfigure(next) });
  });

  async function applyLanguage(name: string) {
    const generation = ++langGeneration;
    const lang = await loadLanguageExtension(name);
    // A newer filename won the race while this import was in flight; applying
    // now would highlight the diff as the wrong language.
    if (!merge || generation !== langGeneration) return;
    const ext = lang ? lang.extension : [];
    merge.a.dispatch({ effects: langA.reconfigure(ext) });
    merge.b.dispatch({ effects: langB.reconfigure(ext) });
  }
</script>

<div class="flex h-full min-h-0 w-full flex-col">
  <div
    class="flex h-7 shrink-0 items-center gap-2 border-b border-border bg-[var(--color-titlebar)] px-3 text-xs uppercase tracking-wider text-muted-foreground"
  >
    <span class="flex-1 truncate">{leftLabel}</span>
    <span class="opacity-40" aria-hidden="true">vs</span>
    <span class="flex-1 truncate">{rightLabel}</span>
  </div>
  <div bind:this={host} class="min-h-0 flex-1 overflow-hidden"></div>
</div>

<style>
  div :global(.cm-mergeView) {
    height: 100%;
  }
  div :global(.cm-mergeViewEditors) {
    height: 100%;
  }
  div :global(.cm-merge-a),
  div :global(.cm-merge-b) {
    flex: 1 1 0;
    min-width: 0;
  }
  div :global(.cm-editor) {
    height: 100%;
  }
  /* Mixed from the status tokens. These four tints were Tailwind's red-500,
     green-500 and pure white, so a diff's own add/remove colours matched
     nothing else in the app that says "added" or "removed". */
  div :global(.cm-changedLine) {
    background-color: color-mix(in srgb, var(--color-foreground) 4%, transparent);
  }
  div :global(.cm-deletedChunk) {
    background-color: color-mix(in srgb, var(--color-danger) 12%, transparent);
  }
  div :global(.cm-insertedLine) {
    background-color: color-mix(in srgb, var(--color-success) 12%, transparent);
  }
  div :global(.cm-changedText) {
    background-color: color-mix(in srgb, var(--color-foreground) 10%, transparent);
  }
</style>
