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
Executable URL schemes and arbitrary HTML are not rendered.
