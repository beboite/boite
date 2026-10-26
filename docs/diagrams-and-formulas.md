# Diagrams and formulas

An answer, a reasoning block, a plan, a side answer, a Markdown file preview
and the Agents page draw two kinds of blocks the Markdown engine
(`packages/ui/src/lib/markdown.ts`) marks: Mermaid diagrams and LaTeX
formulas. A block keeps its source on screen until the drawing replaces it,
and the source stays when the drawing fails or never loads.

## What is drawn

| Written | Drawn as |
|---|---|
| ```` ```mermaid ```` fenced block | a diagram |
| `$$…$$`, `\[…\]` or a ```` ```math ```` block | a display formula |
| `\(…\)` | a formula in the line |
| `$…$` | text: a price or `$PATH` stays as written |

`$$` and `\[` open a display formula on a line of their own when the closing
mark ends a later line, or in the line when both marks are in it. Nothing
inside inline code or a fenced code block is read as math. A block without
its closing mark stays text.

A streaming answer only hands a paragraph to the engine once a blank line
closes it outside a fence (`ParagraphScan` in `lib/message-display.ts`), so a
diagram or formula is drawn once, complete, and the text before it does not
flicker. A Mermaid fence the stream has not closed yet is a plain code block.

The engine only marks: `md-mermaid` with the source in `data-source`, and
`md-math` with the TeX in `data-tex` and what was written in `data-source`.
The `richMarkdown` action (`lib/rich-markdown.ts`) watches the nodes that show
Markdown and hands each marked element to `lib/rich-markdown-draw.ts` as it
enters the page. Every drawing is cached by source, so a remounted message is
drawn again at once.

## Loading

Neither library is in the startup bundle, nor is the drawing code: the action,
about forty lines, imports `lib/rich-markdown-draw.ts` and its styles for the
first marked block. That module imports `lib/math-render.ts` (Temml and its
small stylesheet) for the first formula and `lib/diagram-render.ts`
(Pele) for the first diagram. Pele is a
dependency-free Mermaid renderer whose layout code is split per diagram type,
so a flowchart loads the flowchart chunk and nothing else. Temml writes
MathML, which the browser lays out with the system's math font; its one
9 KB font, for script capitals a system font may lack, is served from the app
like any asset. Nothing comes from a CDN. A client that
cannot fetch a chunk shows the source with a line saying the diagram could
not be drawn there.

Pele was chosen over the `mermaid` package by measuring both on the nine
types Boite documents (flowchart, sequence, class, state, ER, gantt, pie,
mindmap, timeline): about 133 KB gzipped against 1.08 MB for all nine, and a
diagram only loads its own type.

## Sanitizing

Both libraries' output goes through `lib/sanitize-markup.ts` before it enters
the page. It parses the markup in an inert `<template>`, keeps a list of SVG
and MathML elements and attributes, and inserts those checked nodes
rather than serializing them again. It removes scripts, foreign objects and
images with everything inside them; links give way to their text; `on…`
handlers, ids and references outside the drawing, and styles with an address
or a script scheme are dropped. Pele draws with links and images off, and
Temml runs with `trust: false` and bounded sizes and macro expansion.

## Look and actions

A diagram's colors are CSS variables (`--pele-*`) set from the app's tokens
in `lib/rich-markdown-draw.css`: a theme or accent change recolors a drawn diagram
without drawing it again. A diagram is laid out for the column it sits in.
One wider than the column shrinks to fit, and one that cannot shrink further
scrolls inside its box. A wide display formula scrolls sideways.

A drawn diagram has a bar with three buttons: copy the source, switch between
the diagram and its code, and enlarge it in the image viewer, which opens a
standalone SVG with the current colors. The bar shows over the corner on hover
or focus; a touch screen has no hover, so there it sits above the diagram.

A diagram Pele cannot parse shows its code and one muted line with Pele's
reason and line. A formula Temml cannot read keeps its source, underlined,
with the reason as a tooltip.

Copying a selection that holds a drawn formula or diagram puts the source as
written on the clipboard: `\(E = mc^2\)` rather than the drawn MathML, and a
diagram as its ```` ```mermaid ```` block.

## What the agent is told

One line of the session guide (`CHAT_VISUALS` in
`packages/core/src/agent-guide.ts`) makes these blocks the first choice for a
visual: a diagram, a chart or a formula needs no command and no help
to read. It names the Mermaid headers worth knowing (`flowchart`,
`sequenceDiagram`, `xychart-beta` for bars and lines, `pie`, `gantt`,
`timeline`, `quadrantChart`, `sankey-beta`, `mindmap`) and the TeX delimiters,
and asks for a picture whenever one explains better than text. It asks for
quoted `xychart-beta` labels: Pele rejects a bare label with an accent, such
as `x-axis [Jan, Fév]`. Only a
simulator, an animation or a custom page goes to `boite view`
([chat files](chat-files.md#what-the-agent-is-told)).

## Limits

- Mermaid features Pele does not implement are reported as a parse error with
  the code shown.
- Links (`click`) and images in a diagram are never drawn.
- A single `$…$` is never math. Agents are told to write `$$…$$` or `\(…\)`
  (`CHAT_VISUALS`).
- An interactive or animated picture belongs to `boite view`
  ([chat files](chat-files.md#inline-views)).
