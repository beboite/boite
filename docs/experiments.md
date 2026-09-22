# Chat and preview experiments

Enable these separately in Settings > Experiments. Switches are off by default
and belong to this client device. They do not change another machine's settings.

## Chat files and previews

An agent can run `boite attach "reports/review.pdf"` to deliver a file in its
conversation. The core snapshots up to 5 MB from the thread's working directory
and saves the bytes with an assistant message. Relative and absolute paths must
stay inside that directory, including resolved symlinks. A missing file,
directory, oversized file or archived thread is refused. The thread must have
at least one turn. Every provider can use this CLI command.

Published files remain downloadable after the source is edited or deleted,
after a core restart, and with this experiment switched off. Paired phones can
download the published snapshot. They cannot publish or browse arbitrary host
files through the file APIs.

With the experiment enabled, answers support Markdown file links, bare web
URLs, local absolute paths, `file:///` links, and file paths inside inline code.
Wrap the link destination in angle brackets for paths with spaces, such as
`<reports/review one.pdf>`. Source references
can carry `:line` or `#Lline`. Files resolve against the message's thread and
owning machine. Links outside its working directory are refused. Published
PDFs, images, audio and video have inline previews. Other files remain downloadable.
Remote images are links, so reading an answer does not fetch a tracking image.
Executable URL schemes and arbitrary HTML are not rendered.

## Compare proposals

The comparison button in an owner's thread header opens a shared prompt and
two model pickers. Running it creates two independent Git worktrees and starts
one turn in each with Ask permissions. The project must be a Git repository.

Responses, status and working-tree changes appear side by side on desktop and
stack vertically on a phone-sized owner client. Select a changed file to read
its diff. Continue in either thread to answer a permission request, inspect its
other output or carry on with that proposal. Choosing a thread does not merge
its branch or delete the other proposal.

Each start reports its own failure. If creating a thread succeeded but starting
it was not confirmed, open that thread before trying again. Closing the view
leaves both threads running. The pair stays available during the client session;
the underlying threads and worktrees persist independently.

## Preview comments

Open a Browser tab in the integrated panel and choose Reference an element.
Clicking an element adds a compact, removable `@element` reference to the
existing composer. Write the request there and send it normally. Draft text,
attachments and queued messages stay intact. On a phone-sized window, selection
returns to the composer. There is no separate comment form.

References appear in the accent color in the composer and sent messages. Click
one to reopen its thread's browser and highlight the element. A closed tab is
reopened at the captured URL; a surviving tab that changed pages is refused.
Missing elements and inaccessible pages report errors. Open shadow roots are
supported, including sibling elements within them. The highlight follows scroll
and resize for three seconds. Existing references remain clickable with the
experiment switched off.

Each message carries up to eight typed references. The core validates the URL,
selector, shadow-root path, selected text and viewport bounds, then supplies
them as labeled untrusted context to every agent. The visible message keeps
only the user's prose and reference chips. References survive queued sends,
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
the core. The end-to-end tests `artifacts.test.ts`, `proposals.test.ts` and
`preview-comments.test.ts` cover desktop and phone-sized interfaces. The proposal
and preview unit tests cover partial failures, owning-machine boundaries and
selection validation. No live provider login is required.
