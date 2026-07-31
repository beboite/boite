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
  // Mirror of the doc as a string, seeded with the initial doc and kept in step
  // by the update listener below. The parent feeds our own edits straight back
  // in as `value`, so this lets the sync effect recognise the echo without
  // serializing the whole doc on every keypress.
  let lastEmitted = "";
  // Language loading is async; a second filename change must not be overtaken
  // by the first import resolving late.
  let langGeneration = 0;

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
          lastEmitted = next;
          onChange?.(next);
        }
      }),
      langCompartment.of([]),
      readonlyCompartment.of(EditorState.readOnly.of(readonly)),
    ];
  }

  onMount(() => {
    if (!host) return;
    lastEmitted = value;
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
    // Every doc change passes through the update listener, so `lastEmitted`
    // always holds what the view currently contains: matching it means the
    // parent is echoing our keystroke back and there is nothing to apply.
    if (value === lastEmitted) return;
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
    else {
      langGeneration++;
      view.dispatch({ effects: langCompartment.reconfigure([]) });
    }
  });

  async function applyLanguage(name: string) {
    const generation = ++langGeneration;
    const lang = await loadLanguageExtension(name);
    // A newer filename won the race while this import was in flight; applying
    // now would highlight the file as the wrong language.
    if (!view || generation !== langGeneration) return;
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
