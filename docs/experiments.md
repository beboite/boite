# Experiments

Enable these separately in Settings > Experiments. Switches are off by default
and belong to this client device. They do not change another machine's settings.
A phone has its own Experiments row under Settings, This phone.

A finished experiment leaves this page: it turns on by default and its switch
moves to the Settings page it belongs to. [Chat files and previews](chat-files.md)
and [agent browser control](panel.md#agent-browser-control) did.

## Open chat links

`open-chat-links` enables the same rich link parsing as
[Chat files and previews](chat-files.md): Markdown file links, bare web URLs,
absolute paths, `file:///` links and paths inside inline code. Either switch
enables this parsing; enabling both adds no further link types.

On the owning local desktop, this switch also makes an explicit click open a
file or folder in its associated application, including Windows shortcuts and
absolute paths outside the checkout. On a remote machine or phone, links still
use the inline preview and its existing owner and working-directory checks.
They never open a file on the device displaying the conversation.

Pages in the integrated browser and agent RPCs cannot invoke the native action.
Network and device paths are refused before and after path resolution.

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

## Device panel

The Device card in the right panel, its launcher key and the panel opening on
the Device tab when a simulator or emulator opens in the conversation. Each
client turns it on for itself; the agent's `boite device` commands work without
it. See [devices](devices.md).

## Resident agents

The Agents page ([agents](agents.md)) and every button that leads there: the
Threads and Agents switch at the top of the sidebar, the phone menu entry, the command palette row and the link from an agent's
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
