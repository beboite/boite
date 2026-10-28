# Chat files and previews

On by default. Settings > General > Conversations has the **Chat files and
previews** switch, and the phone's settings show the same row; each device
keeps its own choice under `boite.features` in local storage
(`packages/ui/src/lib/features.ts`). Off, file links stay plain text and PDFs
lose their inline preview; published files stay downloadable.

An agent can run `boite attach "reports/review.pdf"` to deliver a file in its
conversation. The core snapshots up to 512 MB from the thread's working directory.
Files up to 5 MB remain inline; larger files live in the core's `artifacts`
directory and the message stores a reference. Downloads support HTTP ranges,
so videos can seek without loading the entire file. The UI renews download
tickets while the card is mounted. Unreferenced snapshots and interrupted
copies older than a day are removed by daily maintenance; forks retain their
referenced files. A pass skips the reference scan when no file is a day old.
The scan runs in a worker so large journals do not block the core's event loop.
A file is never deleted on a scan older than the last journal write: when a
write lands during the scan, the pass scans again once, and when that scan is
overtaken too, it tries again in 15 minutes, up to 8 times before waiting a
day. User uploads still have their separate 5 MB limit.
Relative and absolute paths must
stay inside that directory, including resolved symlinks. A missing file,
directory, oversized file or archived thread is refused. The thread must have
at least one turn. Every provider can use this CLI command.

Published files remain downloadable after the source is edited or deleted,
after a core restart, and with the switch below turned off. Paired phones can
download the published snapshot. They cannot publish or browse arbitrary host
files through the file APIs.

A published file shows where it was sent while its turn runs, so it can be
seen at once. Once the turn ends, the turn's files move under the last thing
the agent wrote, in the order they were published, and any inline views come
after them (`filesLast` in `packages/ui/src/lib/message-order.ts`). The
journal keeps the publish order; only the drawing changes, so older threads
are shown the same way. A file whose turn has nothing else on the loaded page
keeps its place.

Published images, videos and audio appear directly in the conversation
whatever the switch says. Media keeps its aspect ratio in a bounded card; videos have
playback, seeking and fullscreen controls and never autoplay. Images open in a
keyboard-accessible viewer with zoom, fit and download controls. Images larger
than 5 MB show their name, size and download first. Click Load image or the
filename to load them; opening a conversation does not fetch them automatically.
If decoding fails, the card keeps its download and offers a retry. Published PDFs
have an inline preview while the switch is on; other types remain
downloadable. Mutable file editing and viewing belong to the
[right panel](panel.md).

With the switch on, or Open chat links in their apps, answers recognize
Markdown links, bare URLs, absolute paths, `file:///` links and inline-code file
paths. Use angle brackets for spaces, such as `<reports/review one.pdf>`, and
`:line` or `#Lline` for source locations. Files resolve through the message's
owning thread and machine; preview paths stay inside its working directory.
To deliver media across machines, publish it with `boite attach` using a path
on the conversation's machine. A mapped NAS drive on the viewing desktop does
not give a remote core access to that path.
A relative path that is not there as written is looked up by its tail
(`files.locate`, owner only): `core.md` opens `.local/core.md`, the shallowest
match wins, ignored folders count but `.git`, `.boite` and `node_modules` do
not, and two matches at the same depth are reported instead of guessed.
The local desktop's explicit open action follows the rules in
[Open chat links in their apps](#open-chat-links-in-their-apps).

Captures: [chat media on desktop](images/chat-media-desktop.png) · [chat media on a phone](images/chat-media-phone.png)
Remote images are links, so reading an answer does not fetch a tracking image.
Executable URL schemes are not rendered, and HTML in an answer's text stays
text. A page runs only as an inline view, below.

## Open chat links in their apps

Settings, General, **Open chat links in their apps** is off by default and
shown only in the desktop app. A device that had turned on the
`open-chat-links` experiment keeps it on. It enables the same link parsing as
Chat files and previews: Markdown file links, bare web URLs, absolute paths,
`file:///` links and paths inside inline code. Either switch enables this
parsing; enabling both adds no further link types.

On the owning local desktop, this switch also makes an explicit click open a
file or folder in its associated application, including Windows shortcuts and
absolute paths outside the checkout, instead of Boite's preview. On a remote
machine or phone, links still use the inline preview and its existing owner
and working-directory checks. They never open a file on the device displaying
the conversation.

Pages in the integrated browser and agent RPCs cannot invoke the native action.
Network and device paths are refused before and after path resolution.

## Inline views

An agent that wants to show something writes one HTML file and runs
`boite view .boite/views/orbit.html`: a diagram, a chart, an animated SVG, a
simulator with its own sliders. The page is drawn in the conversation, inside
the agent's answer where a line of it places the page, else at the end of the
answer, with no card around it, on the conversation's own background, in the
app's theme and faces. Every provider can use the command. No setting turns
it on, and the switch above does not turn it off.

Captures: [a view on desktop](images/inline-view-desktop.png) · [the same on a phone](images/inline-view-phone.png) · [a view placed between two paragraphs](images/inline-view-placed-desktop.png) · [the same on a phone](images/inline-view-placed-phone.png)

### The app's look

A page looks like the app without the agent styling it. The bootstrap stored
with each page carries a kit (`baseCss` in `packages/contracts/src/view.ts`)
drawn from the app's own stylesheet:

- Bare elements are the app's: text at the answer's size and face, `button`
  with its `primary`, `ghost` and `small` variants, text fields, the slider
  (`input[type=range]`, filled with the accent up to a round thumb), the switch
  (`input[type=checkbox][role=switch]`), `progress`, tables with small caps
  headers, `code`, `pre` and `kbd`.
- A few classes give the pieces a visual is made of: `.row`, `.stack`, `.grid`
  and `.card` for layout, `.controls` and `.field` for a row of controls under
  a drawing, `.segmented`, `.stat`, `.chip`, `.legend` with `.key`, `.bar`,
  and in SVG `.stroke`, `.fill`, `.node`, `.gridline`, `.baseline` and
  `.guide`, which draw in the color set by `.accent`, `.muted` or `.series-1`
  to `.series-8`.
- The client hands the page the tokens of `VIEW_TOKENS` as this device
  computes them: colors, the accent the reader picked, the series palette,
  radii, text sizes, control heights, shadows, durations and the easing. A
  theme, an accent or a motion setting changed in the app reaches a page
  already on screen.

Every rule of the kit is under `:where()`, so it weighs nothing: whatever a
page says about the same element wins. The kit is a start and never a limit;
a mock of somebody else's screen can ignore all of it.

Three things push an agent toward it. `boite view help` explains the look in
a few rules (quiet and flat, one accent, calm type, steps of 4, 2 px strokes)
and lists the kit. `boite view example` prints a complete page that uses
nothing else (`packages/core/src/view-example.ts`, the page in the captures
above, published by the end-to-end test). And a publish answers with advice,
which never refuses it: a color written as a value, which will not follow the
reader's theme or accent, and a font of the page's own (`viewAdvice` in
`packages/core/src/views.ts`).

### What the agent is told

The guide every session starts with (`packages/core/src/agent-guide.ts`) sends
a diagram, a chart or a formula to the chat first: `CHAT_VISUALS` names the
Mermaid headers chat draws and the TeX delimiters, and says when a picture is
called for ([diagrams and formulas](diagrams-and-formulas.md)). That costs the
agent no command and no help to read. The next line, `VIEW_GUIDE_LINE` in
`packages/contracts/src/view.ts`, keeps a page for what Mermaid cannot draw (a
simulator, an animation, a custom page) and sends the agent to `boite view
help` before its first one. `VIEW_HELP`, beside it, prints the rest: the layout
rules, the app's look and its kit, the theme variables, how to animate and what
the publish checks. The built-in skill `boite-visual` is listed for the same
richer case only.

One file is one visual. Several visuals are several files, each published
with its own command. The help and the command's output tell the agent to
place each one right after the paragraph it explains, with a line of its own
that names the file as a Markdown image; the output prints that line with the
page's title and stored path:

```text
![Orbit](.boite/views/orbit.html)
```

Pages no line places stack under the answer in the order they were published.
Publishing the same file again in the same turn replaces that visual on
screen, so an agent fixes a page in place. In a later turn the same file is a
new view, and the earlier answer keeps the page it had.

### Check before publishing

`boite view check <file.html> [--script checks.js] [--scheme dark|light]`
loads a draft without publishing it. It embeds the same local assets and uses
the same kit, sandbox and layout checks as publication, with content widths
of 816 px and 330 px. It creates no message, artifact, browser tab or panel.
Its temporary page and ticket are removed when the check ends, including on
errors or timeout. The CLI saves the returned PNGs with unique names inside
its current directory and never overwrites an existing file. Open both
captures, fix the page and rerun before publishing.

The check uses the app's fallback palettes and fonts, rather than a connected
client's custom theme or selected fonts. Dark is the default;
`--scheme light` uses the light palette and `prefers-color-scheme`.

For a page with controls, `--script checks.js` reads a local JavaScript file
whose contents are the body of an async function, without a function wrapper.
It runs in the page after a fresh load at each width, so desktop interactions
cannot carry state into the phone check. Use the DOM, click buttons, dispatch
input/change events, await updates, throw when an assertion fails and return
JSON values that describe the resulting state. Captures show the page after
the script ran, including when it throws. Check every control and open the
captures to inspect the resulting layout.

The command prints captures, script results, errors and advice. Any error,
or a browser unavailable or unable to answer, returns a nonzero exit code
after available captures are saved. `--json` returns `checked`, `errors`,
`advice` and `captures`; each capture has `width`, `height`, a local `path`
and an optional script `value`, with no PNG bytes. A result exceeding the
16 MB RPC response limit returns an error without captures; return smaller
values or reduce the image detail. After fixing errors and advice and opening
the new captures, run `boite view <file.html>` to publish as usual.

### What publishing does

`artifacts.view` (`packages/core/src/views.ts`) reads the file, which must be
an `.html` file inside the thread's working directory, and then:

1. Embeds every local file the page names by a relative path: pictures,
   fonts, audio and video become `data:` addresses, a script and a stylesheet
   become the element's own text, and what a linked stylesheet names in a
   `url()` is embedded from that stylesheet's folder. A `url()` or an
   `@import` counts only in a `<style>` element or a CSS attribute (`style`,
   SVG's `fill`, `stroke`, `mask`, `clip-path`, `filter`, `marker-*`,
   `cursor`); in script text, prose, a `<textarea>`, a `<title>` or another
   attribute (`title`, `data-*`, `onclick`) it is left as written. A
   `>` inside a quoted attribute value does not end its tag, a tag spelled
   inside one starts nothing, and `<title-card>` is not a `<title>`. They must stay inside
   the working directory, and each is read through the descriptor of the file
   that was checked. The page with its files is at most 4 MB.
2. Refuses a remote address in anything the page would load (`<script src>`,
   `<link href>`, `<img src>`, a CSS `url()`, an `@import`), a local file that
   is missing, and an `<iframe>`. A link in an `<a>` is left alone.
3. Puts a bootstrap at the start of the head, on the line the head opens on,
   so a script error still names the line of the agent's own file. It carries
   the content policy, the kit above and the bridge to the client. A file with no doctype is given one: in quirks mode the root is as
   tall as its frame and the page could not report its own height.
4. Stores the result as an artifact snapshot, as `boite attach` does, and
   loads it once in a headless browser of this machine
   ([the agent's browser](browser.md), in a process of its own that no
   conversation lists). An uncaught error, a `console.error` or a request the
   policy refused fails the publish. The page's height is measured with its
   content 816 px and 330 px wide, the answer column on a desktop and on a
   phone. A page wider than its frame at either width also fails, naming the
   outermost element that sticks out and its container: the frame hides its
   scrollbars, so the reader would see it cut with no way to scroll to the
   rest. What a scrolling or clipping box of the page holds does not count.

A refusal is the command's error, with each problem and its line, and nothing
is stored or shown: the agent fixes the file and runs the command again. A
page reaches the user only once it loaded cleanly. On a machine with no
Chromium-based browser, or when it does not answer within 20 seconds, the
page is published unchecked and the command says so; the browser started for
the check is closed when that wait runs out. A checked publish of the
page `boite view example` prints took 1.5 to 2.2 s over five calls of
`artifacts.view` in a `bun test` loop, on Linux with Chrome, on 2026-10-07.

The message is an `artifact` part with a `view` field: the title, the two
heights and the file it came from. A client that does not know the field
shows the file card and still downloads the page. Retention, forks and
`artifacts.read` treat the snapshot as any other.

### Where it is drawn

The message is journalled when the command runs. Where it is drawn depends on
the answer of the same turn (`packages/ui/src/lib/inline-view.ts`):

- A line of the answer that holds only such an image, its path naming a
  page the turn published, places that page (`answerPieces`, `viewAt`). The
  path is the one the command printed, relative to the working directory; an
  absolute path or a bare file name finds the same page, the exact path first.
  A line in a fenced block places nothing, and a line naming no page of the
  turn stays text. The answer's bubble is cut there: the text above in one
  bubble, the page across the whole column, the text under it in another
  bubble. A page is drawn as soon as its line is complete, while the turn still
  runs, and the line is never shown as a link while it is being written. An
  answer of a turn that published a page is drawn this way from its first
  word, so the line, once written, adds the page and the bubble under it
  without drawing again the paragraphs above. Each text part reads its lines
  again only when its text changed (a streamed delta grows it in place).
- Every other page goes after everything else the turn wrote (`placeViews`),
  and none of them is drawn while the turn is still running: the answer being
  written stays the last thing in the thread, and the page arrives with the
  finished answer.

Publishing does not cut the running answer in two where the command ran, as a
published file does: only the answer's own line places a page. A client
without this placement shows the line as a link to the file and the page at
the end of the answer.

The frame reaches 4 px (`VIEW_BLEED`) past the answer column on each side,
into the conversation's margin, and the kit pads the page's root by as much,
so the content keeps the column's width. A border, a card's shadow or a focus
ring on the page's edge is drawn in that room instead of being cut by the
frame, whatever a fractional display scale (125 % with the app zoomed, for
instance) rounds the frame's edge to.

`InlineView.svelte` frames the page at the measured height for its width, so
nothing below it moves when it loads, then at the height the page reports.
The frame is fetched when it nears the screen. It appears once the bootstrap
says the page is up. A page that cannot be loaded, that never comes up or
that navigates away from its own address is replaced by the plain file card;
no error is written in the thread.

The pointer on a view shows three actions over its corner, and a phone shows
them in a row under it: play again, which loads the page afresh; full size,
which lifts the same running page over the app; and download.

### What a page can reach

`artifacts.read` with `view: true` answers a ticketed address under `/view/`
on the core's own port, so a phone and a proxied core need nothing more than
they already reach. Only a ticket minted for a view opens there; a file
ticket still only downloads, and a view's download address still does not
render. Publication also writes the snapshot gzipped beside it
(`<id>.gz`), and the route sends that copy with `content-encoding: gzip` to a
client that reads gzip; a view published before that copy existed is sent as
it is. Retention removes the copy with its snapshot.

The route sends `content-security-policy: sandbox allow-scripts` and the
frame carries the same sandbox. The page runs on an opaque origin: it has no
storage, no cookie, and no reach into the app or the core's socket. The rest
of the policy lets it load and call nothing: its scripts and styles are its
own, and pictures, media and fonts are embedded. Reading an answer therefore
contacts nobody. The policy is also written in the document, so a downloaded
copy keeps it.

What crosses the frame is small and one-way in each direction. The client
gives the page the app's theme as CSS variables (in its address for the first
paint, then by message when the theme, the accent or the motion setting
changes) and the bytes of the two faces the reader picked, since the page
cannot fetch them. The page gives its content height, and asks for a link to
be opened: the client opens it in the system browser, and only from the frame
the reader just clicked in.

A page can still navigate its own frame. The client notices the second load
and closes the frame.

Tests: `packages/core/test/views.test.ts` (embedding, refusals, the route, the
headless check), `packages/ui/src/lib/inline-view.test.ts`, `components/InlineView.test.ts`
and `components/AssistantMessage.test.ts` (order, placement, frame, fallback),
`tests/e2e/inline-views.test.ts` (a real core and browser on desktop and
phone, and the shell's content policy).
