import { EditorView } from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import type { ResolvedTheme } from "$lib/theme/appearance";

// The editor palette IS the terminal palette. It used to be a hardcoded Tokyo
// Night set, so a diff and the shell that produced it agreed on no colour at
// all, and its foreground was blue-tinted against the app's own.
//
// Every entry is a token reference rather than a resolved value: CodeMirror
// emits real stylesheets (both EditorView.theme and HighlightStyle go through
// style-mod), so var() resolves at paint and editing app.css moves the editor
// with no rebuild. xterm cannot do this: it measures glyphs on a canvas and
// needs literal strings, which is why features/terminal/theme.ts resolves the
// same tokens through getComputedStyle instead.
const palette = {
  bg: "var(--color-background)",
  surface: "var(--color-surface)",
  surface2: "var(--color-surface-2)",
  border: "var(--color-border)",
  fg: "var(--color-term-foreground)",
  // Gutter and fold placeholder: the terminal's own dim colour, which is what
  // "present but not the content" already means one pane over.
  dim: "var(--color-term-bright-black)",
  cursor: "var(--color-term-cursor)",
  selection: "var(--color-selection)",
  activeLine: "color-mix(in srgb, var(--color-term-foreground) 4%, transparent)",
  selectionMatch:
    "color-mix(in srgb, var(--color-term-foreground) 10%, transparent)",
  search: "color-mix(in srgb, var(--color-term-yellow) 25%, transparent)",
  searchOutline: "color-mix(in srgb, var(--color-term-yellow) 55%, transparent)",
  bracket: "color-mix(in srgb, var(--color-term-cyan) 18%, transparent)",
  bracketOutline: "color-mix(in srgb, var(--color-term-cyan) 40%, transparent)",
  invalid: "var(--color-danger)",

  comment: "var(--color-syntax-comment)",
  string: "var(--color-term-green)",
  stringEscape: "var(--color-term-bright-cyan)",
  regexp: "var(--color-term-bright-cyan)",
  number: "var(--color-syntax-number)",
  keyword: "var(--color-term-magenta)",
  operator: "var(--color-term-cyan)",
  type: "var(--color-term-yellow)",
  namespace: "var(--color-term-yellow)",
  variable: "var(--color-term-foreground)",
  property: "var(--color-term-bright-blue)",
  function: "var(--color-term-blue)",
  tag: "var(--color-term-red)",
  attribute: "var(--color-term-bright-magenta)",
  punctuation: "var(--color-term-cyan)",
  meta: "var(--color-term-cyan)",
  heading: "var(--color-term-blue)",
  link: "var(--color-term-bright-blue)",
  emphasis: "var(--color-term-magenta)",
  strong: "var(--color-term-yellow)",
};

const spec =
  {
    "&": {
      color: palette.fg,
      backgroundColor: palette.bg,
      height: "100%",
    },
    ".cm-scroller": {
      // Both from the design system: code in the editor was a third mono stack
      // with no JetBrains Mono in it, and its size was an absolute 12.5px that
      // the UI scale slider could not reach (the scale is a root font-size, so
      // only rem moves).
      fontFamily: "var(--font-mono)",
      fontSize: "var(--text-base)",
      lineHeight: "1.5",
    },
    ".cm-content": {
      caretColor: palette.cursor,
    },
    ".cm-cursor, .cm-dropCursor": {
      borderLeftColor: palette.cursor,
    },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
      {
        backgroundColor: palette.selection,
      },
    ".cm-gutters": {
      backgroundColor: palette.bg,
      color: palette.dim,
      borderRight: `1px solid ${palette.border}`,
    },
    ".cm-activeLineGutter": {
      backgroundColor: palette.surface,
      color: palette.fg,
    },
    ".cm-activeLine": {
      backgroundColor: palette.activeLine,
    },
    ".cm-lineNumbers .cm-gutterElement": {
      padding: "0 8px 0 6px",
      minWidth: "28px",
    },
    ".cm-foldPlaceholder": {
      backgroundColor: palette.surface2,
      borderColor: palette.border,
      color: palette.dim,
    },
    ".cm-tooltip": {
      backgroundColor: palette.surface2,
      border: `1px solid ${palette.border}`,
      borderRadius: "var(--radius-md)",
      boxShadow: "var(--shadow-e3)",
      color: palette.fg,
    },
    ".cm-panels": {
      backgroundColor: palette.surface,
      color: palette.fg,
    },
    ".cm-searchMatch": {
      backgroundColor: palette.search,
      outline: `1px solid ${palette.searchOutline}`,
    },
    ".cm-matchingBracket, &.cm-focused .cm-matchingBracket": {
      backgroundColor: palette.bracket,
      outline: `1px solid ${palette.bracketOutline}`,
    },
    ".cm-selectionMatch": {
      backgroundColor: palette.selectionMatch,
    },
  };

/**
 * The same spec twice, differing only in what CodeMirror is told about it.
 *
 * Every colour above is a `var()`, so a palette swap needs no rebuild here,
 * except for this one flag, which is not a colour. CodeMirror hands `dark` to
 * its own base theme, and that is what decides the chrome nothing above
 * overrides: tooltip and autocomplete surfaces, the scroller, the default
 * selection layer. Left at `true` under the light palette, an editor drawn in
 * light colours pops a dark completion list over it.
 *
 * Built once each, at module load: `EditorView.theme` mints a class name and a
 * stylesheet per call, so building one per reconfigure would leak a rule set
 * into the document every time the user toggled the theme.
 */
const themes = {
  dark: EditorView.theme(spec, { dark: true }),
  light: EditorView.theme(spec, { dark: false }),
};

export function boiteTheme(theme: ResolvedTheme): Extension {
  return themes[theme];
}

const highlight = HighlightStyle.define([
  { tag: t.comment, color: palette.comment, fontStyle: "italic" },
  { tag: t.lineComment, color: palette.comment, fontStyle: "italic" },
  { tag: t.blockComment, color: palette.comment, fontStyle: "italic" },
  { tag: t.docComment, color: palette.comment, fontStyle: "italic" },

  { tag: t.string, color: palette.string },
  { tag: t.special(t.string), color: palette.stringEscape },
  { tag: t.escape, color: palette.stringEscape },
  { tag: t.regexp, color: palette.regexp },

  { tag: t.number, color: palette.number },
  { tag: t.integer, color: palette.number },
  { tag: t.float, color: palette.number },
  { tag: t.bool, color: palette.number },
  { tag: t.null, color: palette.number },
  { tag: t.atom, color: palette.number },

  { tag: t.keyword, color: palette.keyword },
  { tag: t.controlKeyword, color: palette.keyword },
  { tag: t.moduleKeyword, color: palette.keyword },
  { tag: t.modifier, color: palette.keyword },
  { tag: t.self, color: palette.tag },
  { tag: t.operatorKeyword, color: palette.operator },
  { tag: t.operator, color: palette.operator },

  { tag: t.typeName, color: palette.type },
  { tag: t.className, color: palette.type },
  { tag: t.namespace, color: palette.namespace },

  { tag: t.variableName, color: palette.variable },
  { tag: t.propertyName, color: palette.property },
  { tag: t.function(t.variableName), color: palette.function },
  { tag: t.function(t.propertyName), color: palette.function },
  { tag: t.definition(t.variableName), color: palette.function },
  { tag: t.definition(t.propertyName), color: palette.function },
  { tag: t.labelName, color: palette.function },
  { tag: t.constant(t.variableName), color: palette.number },

  { tag: t.tagName, color: palette.tag },
  { tag: t.attributeName, color: palette.attribute },
  { tag: t.attributeValue, color: palette.string },

  { tag: t.punctuation, color: palette.punctuation },
  { tag: t.bracket, color: palette.fg },
  { tag: t.squareBracket, color: palette.fg },
  { tag: t.paren, color: palette.fg },
  { tag: t.brace, color: palette.fg },
  { tag: t.separator, color: palette.fg },

  { tag: t.meta, color: palette.meta },
  { tag: t.annotation, color: palette.meta },
  { tag: t.processingInstruction, color: palette.meta },

  { tag: t.heading, color: palette.heading, fontWeight: "700" },
  { tag: t.heading1, color: palette.heading, fontWeight: "700" },
  { tag: t.heading2, color: palette.heading, fontWeight: "700" },
  { tag: t.heading3, color: palette.heading, fontWeight: "700" },
  { tag: t.emphasis, color: palette.emphasis, fontStyle: "italic" },
  { tag: t.strong, color: palette.strong, fontWeight: "700" },
  { tag: t.link, color: palette.link, textDecoration: "underline" },
  { tag: t.url, color: palette.link, textDecoration: "underline" },
  { tag: t.quote, color: palette.string, fontStyle: "italic" },
  { tag: t.list, color: palette.tag },
  { tag: t.monospace, color: palette.fg },

  { tag: t.invalid, color: palette.invalid },
]);

export const boiteHighlight = syntaxHighlighting(highlight);
