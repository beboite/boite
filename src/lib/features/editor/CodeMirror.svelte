<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { EditorState, Compartment } from "@codemirror/state";
  import {
    EditorView,
    keymap,
    lineNumbers,
    highlightActiveLine,
    highlightActiveLineGutter,
    drawSelection,
    rectangularSelection,
    crosshairCursor,
    highlightSpecialChars,
  } from "@codemirror/view";
  import {
    history,
    historyKeymap,
    defaultKeymap,
    indentWithTab,
  } from "@codemirror/commands";
  import {
    bracketMatching,
    foldGutter,
    foldKeymap,
    indentOnInput,
  } from "@codemirror/language";
  import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
  import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
  import { boiteHighlight, boiteTheme } from "./theme";
  import { loadLanguageExtension } from "./languages";

  interface Props {
    value: string;
    filename?: string | null;
    readonly?: boolean;
    onChange?: (next: string) => void;
    onSave?: () => void;
  }

  let {
    value,
    filename = null,
    readonly = false,
    onChange,
    onSave,
  }: Props = $props();

  let host: HTMLElement | null = $state(null);
  let view: EditorView | null = null;
  let langCompartment = new Compartment();
  let readonlyCompartment = new Compartment();

  function baseExtensions() {
    return [
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightSpecialChars(),
      history(),
      foldGutter(),
      drawSelection(),
      indentOnInput(),
      bracketMatching(),
      closeBrackets(),
      rectangularSelection(),
      crosshairCursor(),
      highlightActiveLine(),
      highlightSelectionMatches(),
      keymap.of([
        ...closeBracketsKeymap,
        ...defaultKeymap,
        ...searchKeymap,
        ...historyKeymap,
        ...foldKeymap,
        indentWithTab,
        {
          key: "Mod-s",
          preventDefault: true,
          run: () => {
            onSave?.();
            return true;
          },
        },
      ]),
      boiteTheme,
      boiteHighlight,
      EditorView.lineWrapping,
      EditorView.updateListener.of((u) => {
        if (u.docChanged) {
          const next = u.state.doc.toString();
          onChange?.(next);
        }
      }),
      langCompartment.of([]),
      readonlyCompartment.of(EditorState.readOnly.of(readonly)),
    ];
  }

  onMount(() => {
    if (!host) return;
    const state = EditorState.create({
      doc: value,
      extensions: baseExtensions(),
    });
    view = new EditorView({ state, parent: host });
    if (filename) void applyLanguage(filename);
  });

  onDestroy(() => {
    view?.destroy();
    view = null;
  });

  $effect(() => {
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === value) return;
    view.dispatch({
      changes: { from: 0, to: current.length, insert: value },
    });
  });

  $effect(() => {
    if (!view) return;
    view.dispatch({
      effects: readonlyCompartment.reconfigure(EditorState.readOnly.of(readonly)),
    });
  });

  $effect(() => {
    if (!view) return;
    if (filename) void applyLanguage(filename);
    else view.dispatch({ effects: langCompartment.reconfigure([]) });
  });

  async function applyLanguage(name: string) {
    const lang = await loadLanguageExtension(name);
    if (!view) return;
    view.dispatch({
      effects: langCompartment.reconfigure(lang ? lang.extension : []),
    });
  }
</script>

<div bind:this={host} class="h-full w-full overflow-hidden"></div>

<style>
  div :global(.cm-editor) {
    height: 100%;
  }
  div :global(.cm-editor.cm-focused) {
    outline: none;
  }
</style>
