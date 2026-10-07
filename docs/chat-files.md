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
referenced files. The reference scan runs in a worker so large journals do not
block the core's event loop. A pass that overlaps journal writes skips deletion
to avoid acting on stale references. User uploads still have their separate 5 MB limit.
Relative and absolute paths must
stay inside that directory, including resolved symlinks. A missing file,
directory, oversized file or archived thread is refused. The thread must have
at least one turn. Every provider can use this CLI command.

Published files remain downloadable after the source is edited or deleted,
after a core restart, and with the switch below turned off. Paired phones can
download the published snapshot. They cannot publish or browse arbitrary host
files through the file APIs.

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

With the switch on, or the `open-chat-links` experiment, answers recognize
Markdown links, bare URLs, absolute paths, `file:///` links and inline-code file
paths. Use angle brackets for spaces, such as `<reports/review one.pdf>`, and
`:line` or `#Lline` for source locations. Files resolve through the message's
owning thread and machine; preview paths stay inside its working directory.
The local desktop's explicit open action follows the rules in
[Open chat links](experiments.md#open-chat-links).

Captures: [chat media on desktop](images/chat-media-desktop.png) · [chat media on a phone](images/chat-media-phone.png)
Remote images are links, so reading an answer does not fetch a tracking image.
Executable URL schemes are not rendered, and HTML in an answer's text stays
text. A page runs only as an inline view, below.

## Inline views

An agent that wants to show something writes one HTML file and runs
`boite view .boite/views/orbit.html`: a diagram, a chart, an animated SVG, a
simulator with its own sliders. The page is drawn in the conversation at the
end of the agent's answer, with no card around it, on the conversation's own
background, in the app's theme and faces. Every provider can use the command.
No setting turns it on, and the switch above does not turn it off.

Captures: [a view on desktop](images/inline-view-desktop.png) · [the same on a phone](images/inline-view-phone.png)

### What the agent is told

The guide every session starts with (`packages/core/src/agent-guide.ts`) has
one line: the command, and that a request for a visual or a schema calls for
it. `boite view help` prints the rest, read only by an agent about to write a
page: the layout rules, the theme variables, how to animate and what the
publish checks. Both texts are `VIEW_GUIDE_LINE` and `VIEW_HELP` in
`packages/contracts/src/view.ts`, beside the code they describe.

One file is one visual. Several visuals are several files, each published
with its own command; they stack under the answer in the order they were
published. Publishing the same file again in the same turn replaces that
visual on screen, so an agent fixes a page in place. In a later turn the same
file is a new view, and the earlier answer keeps the page it had.

### What publishing does

`artifacts.view` (`packages/core/src/views.ts`) reads the file, which must be
an `.html` file inside the thread's working directory, and then:

1. Embeds every local file the page names by a relative path: pictures,
   fonts, audio and video become `data:` addresses, a script and a stylesheet
   become the element's own text. They must stay inside the working
   directory. The page with its files is at most 4 MB.
2. Refuses a remote address in anything the page would load (`<script src>`,
   `<link href>`, `<img src>`, a CSS `url()`, an `@import`), a local file that
   is missing, and an `<iframe>`. A link in an `<a>` is left alone.
3. Puts a bootstrap at the start of the head, on the line the head opens on,
   so a script error still names the line of the agent's own file. It carries
   the content policy, the app's look for bare elements and the bridge to the
   client.
4. Stores the result as an artifact snapshot, as `boite attach` does, and
   loads it once in a headless browser of this machine
   ([the agent's browser](browser.md), in a process of its own that no
   conversation lists). An uncaught error, a `console.error` or a request the
   policy refused fails the publish. The page's height is measured at 816 px
   and at 330 px, the answer column on a desktop and on a phone.

A refusal is the command's error, with each problem and its line, and nothing
is stored or shown: the agent fixes the file and runs the command again. A
page reaches the user only once it loaded cleanly. On a machine with no
Chromium-based browser, or when it does not answer within 20 seconds, the
page is published unchecked and the command says so. A checked publish of
`tests/e2e/fixtures/views/pendulum.html` took 1.06 to 1.14 s over five calls
of `artifacts.view` in a `bun test` loop, on Linux with Chrome, on 2026-10-07.

The message is an `artifact` part with a `view` field: the title, the two
heights and the file it came from. A client that does not know the field
shows the file card and still downloads the page. Retention, forks and
`artifacts.read` treat the snapshot as any other.

### Where it is drawn

The message is journalled when the command runs. The timeline draws a turn's
views after everything else the turn wrote (`placeViews` in
`packages/ui/src/lib/inline-view.ts`), and draws none while the turn is still
running: the answer being written stays the last thing in the thread, and the
page arrives with the finished answer. Publishing does not cut the running
answer in two, as a published file does.

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
render.

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
headless check), `packages/ui/src/lib/inline-view.test.ts` and
`components/InlineView.test.ts` (order, frame, fallback),
`tests/e2e/inline-views.test.ts` (a real core and browser on desktop and
phone, and the shell's content policy).
