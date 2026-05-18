import { EditorView } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

const palette = {
  bg: "var(--color-background)",
  surface: "var(--color-surface)",
  surface2: "var(--color-surface-2)",
  surface3: "var(--color-surface-3)",
  border: "var(--color-border)",
  fg: "#c0caf5",
  muted: "#565f89",
  cursor: "#c0caf5",
  selection: "rgba(125, 207, 255, 0.18)",
  activeLine: "rgba(192, 202, 245, 0.04)",
  search: "rgba(125, 207, 255, 0.30)",
  invalid: "#f7768e",

  comment: "#565f89",
  string: "#9ece6a",
  stringEscape: "#b4f9f8",
  regexp: "#b4f9f8",
  number: "#ff9e64",
  bool: "#ff9e64",
  keyword: "#bb9af7",
  controlKeyword: "#bb9af7",
  operator: "#89ddff",
  type: "#2ac3de",
  className: "#2ac3de",
  namespace: "#73daca",
  variable: "#c0caf5",
  property: "#73daca",
  function: "#7aa2f7",
  definition: "#7aa2f7",
  tag: "#f7768e",
  attribute: "#bb9af7",
  punctuation: "#89ddff",
  meta: "#7dcfff",
  heading: "#7aa2f7",
  link: "#7dcfff",
  emphasis: "#bb9af7",
  strong: "#ff9e64",
};

export const boiteTheme = EditorView.theme(
  {
    "&": {
      color: palette.fg,
      backgroundColor: palette.bg,
      height: "100%",
    },
    ".cm-scroller": {
      fontFamily:
        'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
      fontSize: "12.5px",
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
      color: palette.muted,
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
      color: palette.muted,
    },
    ".cm-tooltip": {
      backgroundColor: palette.surface,
      border: `1px solid ${palette.border}`,
      color: palette.fg,
    },
    ".cm-panels": {
      backgroundColor: palette.surface,
      color: palette.fg,
    },
    ".cm-searchMatch": {
      backgroundColor: palette.search,
      outline: "1px solid rgba(125, 207, 255, 0.55)",
    },
    ".cm-matchingBracket, &.cm-focused .cm-matchingBracket": {
      backgroundColor: "rgba(125, 207, 255, 0.15)",
      outline: "1px solid rgba(125, 207, 255, 0.40)",
    },
    ".cm-selectionMatch": {
      backgroundColor: "rgba(192, 202, 245, 0.10)",
    },
  },
  { dark: true },
);

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
  { tag: t.controlKeyword, color: palette.controlKeyword },
  { tag: t.moduleKeyword, color: palette.keyword },
  { tag: t.modifier, color: palette.keyword },
  { tag: t.self, color: palette.tag },
  { tag: t.operatorKeyword, color: palette.operator },
  { tag: t.operator, color: palette.operator },

  { tag: t.typeName, color: palette.type },
  { tag: t.className, color: palette.className },
  { tag: t.namespace, color: palette.namespace },

  { tag: t.variableName, color: palette.variable },
  { tag: t.propertyName, color: palette.property },
  { tag: t.function(t.variableName), color: palette.function },
  { tag: t.function(t.propertyName), color: palette.function },
  { tag: t.definition(t.variableName), color: palette.definition },
  { tag: t.definition(t.propertyName), color: palette.definition },
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
