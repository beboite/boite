<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { EditorState, Compartment } from "@codemirror/state";
  import { EditorView, lineNumbers, highlightSpecialChars } from "@codemirror/view";
  import { MergeView } from "@codemirror/merge";
  import { boiteHighlight, boiteTheme } from "./theme";
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

  function baseExt() {
    return [
      lineNumbers(),
      highlightSpecialChars(),
      boiteTheme,
      boiteHighlight,
      EditorView.editable.of(false),
      EditorState.readOnly.of(true),
      EditorView.lineWrapping,
    ];
  }

  onMount(() => {
    if (!host) return;
    merge = new MergeView({
      a: { doc: leftContent, extensions: [...baseExt(), langA.of([])] },
      b: { doc: rightContent, extensions: [...baseExt(), langB.of([])] },
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

  async function applyLanguage(name: string) {
    const lang = await loadLanguageExtension(name);
    if (!merge) return;
    const ext = lang ? lang.extension : [];
    merge.a.dispatch({ effects: langA.reconfigure(ext) });
    merge.b.dispatch({ effects: langB.reconfigure(ext) });
  }
</script>

<div class="flex h-full min-h-0 w-full flex-col">
  <div
    class="flex h-7 shrink-0 items-center gap-2 border-b border-border bg-[var(--color-titlebar)] px-3 text-[10.5px] uppercase tracking-wider text-muted-foreground"
  >
    <span class="flex-1 truncate">{leftLabel}</span>
    <span class="opacity-40">vs</span>
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
  div :global(.cm-changedLine) {
    background-color: rgba(255, 255, 255, 0.04);
  }
  div :global(.cm-deletedChunk) {
    background-color: rgba(239, 68, 68, 0.12);
  }
  div :global(.cm-insertedLine) {
    background-color: rgba(34, 197, 94, 0.12);
  }
  div :global(.cm-changedText) {
    background-color: rgba(255, 255, 255, 0.10);
  }
</style>
