# Experiments

`open-chat-links` adds desktop file opening to chat links. An explicit click in
the main UI opens a local file or folder in its associated application, including
Windows shortcuts and absolute paths outside the checkout. It is off by default
and independent of `chat-artifacts`. It only applies to the owning local core;
remote-machine links keep their preview behavior. Pages in the integrated browser
and agent RPCs cannot invoke this native action. Network and device paths are refused.

Enable these separately in Settings > Experiments. Switches are off by default
and belong to this client device. They do not change another machine's settings.
A phone has its own Experiments row under Settings, This phone.

## Whip

A small Whip icon sits beside the other controls in the sidebar footer and
phone navigation. Throw it to pick up the animated rope from Boite Legacy:
it follows the pointer, cracks on a fast flick, and falls off screen on a click.
On a phone, drag the rope with a finger and release to drop it. Escape also drops it.
The footer control remains available to drop or rethrow while the previous rope falls.
After release, Escape resumes its usual app action.
The opening arc uses unstretched links and fits the available side of the screen.
The physics and canvas load only when the experiment is enabled; the animation
loop and audio context close when it is turned off.

A crack plays one of six recorded cracks from Boite Legacy's sprite, with a
synthesized burst as the fallback, and shakes the native Boite window before
returning it to its original position. Throwing the rope does neither. Maximized and fullscreen windows, browsers, phones and window managers
that ignore positioning shake the interface instead. Hits do not overlap.
Reduced motion disables new throws and stops any visible rope.

## Chat files and previews

An agent can run `boite attach "reports/review.pdf"` to deliver a file in its
conversation. The core snapshots up to 512 MB from the thread's working directory.
Files up to 5 MB remain inline; larger files live in the core's `artifacts`
directory and the message stores a reference. Downloads support HTTP ranges,
so videos can seek without loading the entire file. The UI renews download
tickets while the card is mounted. Unreferenced snapshots and interrupted
copies older than a day are removed by daily maintenance; forks retain their
referenced files. User uploads still have their separate 5 MB limit.
Relative and absolute paths must
stay inside that directory, including resolved symlinks. A missing file,
directory, oversized file or archived thread is refused. The thread must have
at least one turn. Every provider can use this CLI command.

Published files remain downloadable after the source is edited or deleted,
after a core restart, and with this experiment switched off. Paired phones can
download the published snapshot. They cannot publish or browse arbitrary host
files through the file APIs.

Published images, videos and audio appear directly in the conversation without
enabling this experiment. Media keeps its aspect ratio within a bounded card;
videos have playback, seeking and fullscreen controls and never autoplay.
Images open in a keyboard-accessible viewer with zoom, fit and download controls.
If decoding fails, the card keeps its download and offers a retry.

With the experiment enabled, answers also support Markdown file links, bare web
URLs, local absolute paths, `file:///` links, and file paths inside inline code.
Wrap the link destination in angle brackets for paths with spaces, such as
`<reports/review one.pdf>`. Source references
can carry `:line` or `#Lline`. Files resolve against the message's thread and
owning machine. Links outside its working directory are refused. Published
PDFs have an optional inline preview. Other files remain downloadable.
Remote images are links, so reading an answer does not fetch a tracking image.
Executable URL schemes and arbitrary HTML are not rendered.

## Resident agents

The Agents page ([agents](agents.md)) and every button that leads there: the
sidebar icon, the phone tab, the command palette row and the link from an agent's
own thread. Turning
the switch off closes the page if it is open. It hides the page only: agents
already made keep their routines and missions on the core, which knows nothing
of a client's experiments.

## Preview comments

Open a Browser tab in the integrated panel and choose Reference an element.
Clicking an element inserts an `@element` mention at the cursor in the
existing composer. Write around it and send normally. Draft text,
attachments and queued messages stay intact. On a phone-sized window, selection
returns to the composer. There is no separate comment form.

References stay inline with the text, in the accent color, in drafts and sent
messages. Editing a mention removes its element association. Click
one to reopen its thread's browser and highlight the element. A closed tab is
reopened at the captured URL; a surviving tab that changed pages is refused.
Missing elements and inaccessible pages report errors. Open shadow roots are
supported, including sibling elements within them. The highlight follows scroll
and resize for three seconds. Existing references remain clickable with the
experiment switched off.

Each message carries up to eight typed references. The core validates the URL,
mention positions, selector, shadow-root path, selected text and viewport bounds, then supplies
them as labeled untrusted context to every agent. The visible message keeps
only the user's prose and inline mentions. References survive queued sends,
failed sends, idempotent retries and prompt recall. Stashing a referenced draft
or sending it with `/goal` or `/loop` is refused explicitly, preserving the draft.

Escape cancels selection. Switching off the experiment or leaving the surface
cancels the picker. Desktop child webviews support selection across origins.
The iframe test bridge only inspects accessible same-origin documents and
reports inaccessible pages explicitly. Selected page content is untrusted data;
it never grants the page access to host commands. This version does not attach
a screenshot to the reference.

## Verification

`artifacts.test.ts` covers publication, path boundaries and byte preservation in
the core. The end-to-end tests `artifacts.test.ts` and
`preview-comments.test.ts` cover desktop and phone-sized interfaces. Preview
unit tests cover owning-machine boundaries and selection validation.
No live provider login is required.

`whip.test.ts` covers the toggle, persistence, desktop and phone layout, drop and rethrow, whole
interface movement, rope drawing and release, cancellation and reduced motion. `shell.test.ts` verifies
native window movement and restoration, and refusal from a browser child webview.

The opt-in `codex.live.test.ts` attachment case asks a real Codex process to
discover file publication through `boite --help`. It checks the inherited CLI,
delivery during the active turn, and unchanged bytes after deleting the source.
It requires `BOITE_E2E_CODEX=1` and uses the default Codex login.
