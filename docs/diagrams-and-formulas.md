# Diagrams and formulas

An answer, a reasoning block, a plan, a side answer, a Markdown file preview
and the Agents page draw three kinds of blocks the Markdown engine
(`packages/ui/src/lib/markdown.ts`) marks: Mermaid diagrams, LaTeX formulas
and view blocks, small pages of HTML. A block holds a placeholder until its
drawing is ready, and shows its source when the drawing fails or never loads.

## What is drawn

| Written | Drawn as |
|---|---|
| ```` ```mermaid ```` fenced block | a diagram |
| `$$…$$`, `\[…\]` or a ```` ```math ```` block | a display formula |
| `\(…\)` | a formula in the line |
| ```` ```view ```` fenced block of HTML, SVG, CSS and script | a page in a sandboxed frame ([view blocks](#view-blocks)) |
| `$…$` | text: a price or `$PATH` stays as written |

`$$` and `\[` open a display formula on a line of their own when the closing
mark ends a later line, or in the line when both marks are in it. Nothing
inside inline code or a fenced code block is read as math. A block without
its closing mark stays text. A ```` ```html ```` block is code, never a page.

A streaming answer only hands a paragraph to the engine once a blank line
closes it outside a fence (`ParagraphScan` in `lib/message-display.ts`), so a
diagram or formula is drawn once, complete, and the text before it does not
flicker. The paragraph still being written stops before a drawn block it has
begun, a ```` ```mermaid ````, ```` ```math ```` or ```` ```view ```` fence or a
`$$` or `\[` at the start of a line, and a placeholder stands in for the rest
(`pendingDrawing` in `lib/message-display.ts`): the reader never sees half a
diagram or the HTML of a page being typed. Once the block closes, the
placeholder stays until it is drawn (`app.css`, under `data-rich-markdown`),
at the height its page last had when the block was drawn before.

The engine only marks: `md-mermaid` with the source in `data-source`,
`md-math` with the TeX in `data-tex` and what was written in `data-source`,
and `md-view` with the HTML in `data-source`.
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
cannot fetch a chunk shows the source with a line saying the diagram or view
could not be drawn there.

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

## View blocks

A ```` ```view ```` block is a page written in the answer, for something too
small to be worth a file: a card with a slider, an animated SVG, a few rows a
script lays out. It is drawn like a page `boite view` publishes
([chat files](chat-files.md#inline-views)): the same sandbox
(`allow-scripts`, an opaque origin), the same content policy (no network,
`default-src 'none'`), the same kit and theme, and a height that follows the
page.

The client asks the machine that owns the conversation for the page
(`Store.viewBlock`, the `artifacts.viewBlock` method). The core wraps the HTML
in the view bootstrap (`viewDocument`), holds it in memory under a ticket and
serves it at `/view/<ticket>` with the headers of a published view
(`viewBlock` in `packages/core/src/views.ts`). Nothing is written to disk and
nothing joins the conversation's files; a block of at most 512 KB is accepted,
the same HTML gets the same address, and a core keeps the last 64 pages. A
phone asks over its pairing (`DEVICE_METHODS`); an agent cannot call the
method. The fake client serves the page from a `blob:` address.

The frame loads at the column's width out of sight, under the placeholder,
and replaces it once the page says it is up, so a script that lays the page
out runs before anything shows. The page is failed and its HTML shown, with
the reason under it, when it does not load within 20 seconds, does not say it
is up 2 seconds after loading, or leaves its own address. Its bar copies the
HTML and switches between the page and its code; copying a selection across
a drawn page gives back its ```` ```view ```` block.

## What the agent is told

One line of the session guide (`CHAT_VISUALS` in
`packages/core/src/agent-guide.ts`) makes these blocks the first choice for a
visual: a diagram, a chart, a formula or a small page needs no command and no
help to read. It names the Mermaid headers worth knowing (`flowchart`,
`sequenceDiagram`, `xychart-beta` for bars and lines, `pie`, `gantt`,
`timeline`, `quadrantChart`, `sankey-beta`, `mindmap`) and the TeX delimiters,
and asks for a picture whenever one explains better than text. It asks for
quoted `xychart-beta` labels: Pele rejects a bare label with an accent, such
as `x-axis [Jan, Fév]`. It offers a ```` ```view ```` block of HTML, SVG, CSS
and script for an interactive or animated piece, and says the page is offline
and takes the app's look, so it writes no fixed color. Only a larger page, or
one to keep as a file, goes to `boite view`
([chat files](chat-files.md#what-the-agent-is-told)).

## Limits

- Mermaid features Pele does not implement are reported as a parse error with
  the code shown.
- Links (`click`) and images in a diagram are never drawn.
- A single `$…$` is never math. Agents are told to write `$$…$$` or `\(…\)`
  (`CHAT_VISUALS`).
- A page larger than a block allows, or one worth keeping as a file, belongs
  to `boite view` ([chat files](chat-files.md#inline-views)).
- A view block that fails is shown as code to the reader; the agent is not
  told yet, and a script error after the page says it is up is not detected.
