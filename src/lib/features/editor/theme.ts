import { EditorView } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

const palette = {
  bg: "var(--color-background)",
  surface: "var(--color-surface)",
  surface2: "var(--color-surface-2)",
  surface3: "var(--color-surface-3)",
  fg: "var(--color-foreground)",
  muted: "var(--color-muted-foreground)",
  border: "var(--color-border)",
  accent: "#9ca3af",
  comment: "#6b7280",
  string: "#a3a3a3",
  number: "#cbd5e1",
  keyword: "#e5e7eb",
  type: "#f3f4f6",
  variable: "#d4d4d4",
  invalid: "var(--color-danger)",
  selection: "rgba(255,255,255,0.10)",
  cursor: "#e5e7eb",
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
    },
    ".cm-activeLine": {
      backgroundColor: "rgba(255,255,255,0.025)",
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
      backgroundColor: "rgba(255,255,255,0.10)",
      outline: "1px solid rgba(255,255,255,0.25)",
    },
  },
  { dark: true },
);

const highlight = HighlightStyle.define([
  { tag: t.comment, color: palette.comment, fontStyle: "italic" },
  { tag: t.lineComment, color: palette.comment, fontStyle: "italic" },
  { tag: t.blockComment, color: palette.comment, fontStyle: "italic" },
  { tag: t.string, color: palette.string },
  { tag: t.special(t.string), color: palette.string },
  { tag: t.number, color: palette.number },
  { tag: t.bool, color: palette.number },
  { tag: t.keyword, color: palette.keyword, fontWeight: "600" },
  { tag: t.controlKeyword, color: palette.keyword, fontWeight: "600" },
  { tag: t.operatorKeyword, color: palette.keyword },
  { tag: t.typeName, color: palette.type },
  { tag: t.className, color: palette.type },
  { tag: t.namespace, color: palette.type },
  { tag: t.variableName, color: palette.variable },
  { tag: t.propertyName, color: palette.variable },
  { tag: t.function(t.variableName), color: palette.fg },
  { tag: t.definition(t.variableName), color: palette.fg },
  { tag: t.tagName, color: palette.keyword },
  { tag: t.attributeName, color: palette.variable },
  { tag: t.heading, color: palette.fg, fontWeight: "700" },
  { tag: t.link, color: palette.string, textDecoration: "underline" },
  { tag: t.invalid, color: palette.invalid },
]);

export const boiteHighlight = syntaxHighlighting(highlight);
