# The agent's browser

An agent that needs a web page opens it in a headless browser on the machine
that runs its conversation. The core of that machine starts the browser and
drives it over the DevTools protocol; the agent reaches it with
`boite browser` ([CLI](cli.md#test-a-page-in-the-agent-browser)). Every client
of the conversation watches the same tabs and can act in them: the desktop on
that machine, the desktop of another machine connected to it, a plain browser,
a phone. Nothing depends on which client is open, and no setting turns it on.

`packages/core/src/browser.ts` owns the tabs, `browser/chromium.ts` finds the
browser and holds its flags, `browser/launch.ts` starts it, `browser/cdp.ts` is the protocol connection,
`browser/recorder.ts` records, `browser/frames.ts` takes a viewer's frames and `browser/scripts.ts` holds what is evaluated
in a page for viewers. `browser/automation.ts` runs agent-browser's commands
with `browser/page-kit.ts`, the script that reads a page into a snapshot with
refs and finds `@eN`, CSS and `text=` targets, and `browser/page-frames.ts`
reaches the frames of other origins.

## Which browser

The core looks for a Chromium-based browser where each installs:

| OS      | Looked at                                                                                     |
| ------- | --------------------------------------------------------------------------------------------- |
| Windows | Chrome, Edge, Chromium and Brave under `Program Files`, `Program Files (x86)` and `LOCALAPPDATA` |
| macOS   | Chrome, Chromium, Edge and Brave in `/Applications`                                           |
| any     | `google-chrome`, `google-chrome-stable`, `chromium`, `chromium-browser`, `microsoft-edge`, `brave-browser` on `PATH` |

`BOITE_BROWSER` names the executable instead, and is then the only place
looked at. Edge ships with Windows 10 and 11, so a Windows machine always has
one. A machine without any says so: `browser.remoteStatus` answers
`available: false` with the reason, the panel shows it, and `browser open`
fails with the same sentence. Nothing is installed or downloaded.

The browser runs with `--headless=new`, muted, without a first-run page, sync
or background downloads, in a 1280 × 800 window whose page measured
1280 × 720 on Chrome 153. WebGL uses the GPU:
`--enable-gpu` with software rendering off, and ANGLE over EGL on Linux, which
a process with no display reaches. A page that needs WebGL on a machine
without a usable GPU gets none rather than SwiftShader on every core. On the
M2 container on 2026-10-05, WebGL reported `ANGLE (AMD, AMD Radeon Graphics
(radeonsi renoir ACO), OpenGL ES 3.2)`.

A Mac in a virtual machine, where the kernel sets `kern.hv_vmm_present` to 1,
starts the browser with `--disable-gpu` instead: pages draw on the CPU and
WebGL is off. On the paravirtual GPU of a macos-15 arm64 CI runner, Chrome's
GPU process lost its Metal device (`[Device] is lost`) and restarted. The
process that exited stayed a zombie with a thread in the kernel's
`IOService::newUserClient`, and the browser's UI thread sat in `wait4` until
it ended, so no DevTools command was answered for 10 to 30 seconds. Over 40
minutes of the browser tests, 1180 browsers had 48 GPU restarts and 20
silences past 3 seconds; with `--disable-gpu`, 3177 browsers had none, and
none took more than 1.6 seconds to answer. A Mac's own hardware keeps the GPU.

### What sites see

Headless Chrome names itself `HeadlessChrome` in its user agent, sets
`navigator.webdriver` and reports an 800 × 600 screen smaller than its own
window. Sites turn that away as a robot: on 2026-10-09 Google answered with
its "unusual traffic" page, leboncoin and Zillow with a captcha, ChatGPT with
Cloudflare's wait page and Indeed with "Blocked". The agent browser says what
the same browser says with a window instead, and all five opened.

`browser/launch.ts` reads that once per build of the executable, in a
throwaway browser started for it: the user agent without `Headless`, and the
client hints (`navigator.userAgentData`, the `Sec-CH-UA-*` headers) from a
`file:` page, the secure context they need. It took about 2 seconds on M2 and
is read again when the executable changes. Every browser then starts with
`--user-agent`, which covers its pages, workers, popups and every request, and
each tab gets the same user agent and the high-entropy client hints through
`Emulation.setUserAgentOverride`: the flag alone empties those. The browser
also runs with `--disable-blink-features=AutomationControlled`, which leaves
`navigator.webdriver` false, `--test-type`, which hides the warning bar that
flag adds and that took 56 pixels of the page, and `--screen-info={1920x1080}`.
A browser whose identity cannot be read starts as it is, with a warning in the
log. A page check of `boite view` skips the read.

Settings > General > Browser profiles has a User-Agent editor on each custom
profile. Leave it empty for the unchanged browser identity, append a suffix
such as a bug bounty program marker, or replace the complete value. The
setting is stored as `browserProfiles[].userAgent` (`mode: suffix | replace`,
`value`) and applies when that profile's agent browser next starts. Close its
agent tabs and wait for the idle process to end, or restart the core, to apply
a change to an already running profile. Default and private profiles keep the
browser identity; create a named profile to customize it.

A profile keeps its current engine until it closes, including when the desktop
app attaches or the User-Agent setting changes. Its next engine starts after
the previous engine finishes saving cookies, so two engines never overwrite
the same profile's saved cookie snapshot. An engine that ended, closed by
the core or lost when its connection dropped, holds its profile until its
process exited: a browser started sooner would find the folder still locked.
A start that fails once its browser was spawned rejects only after that
browser exited, so the profile stays taken until then too.

A customized profile starts a separate Chromium process even while the desktop
app hosts other agent tabs: webviews cannot set per-profile process flags for
workers and popups. The panel displays its remote view. The process receives
the complete value through `--user-agent`; tab overrides use that same value
with the real browser's client hints. Replacing the value does not impersonate
another engine or OS in client hints. If the native identity cannot be read,
a customized profile refuses to start rather than omit its program marker.

This brings it level with the same Chrome running with a window on the same
network, not past it. Etsy, SeLoger and Reddit still asked for a captcha on
2026-10-09, and so did Chrome with a window under Xvfb on that address. The
user solves a captcha in the panel, which takes clicks and drags.

## Processes and profiles

Each [browser profile](panel.md#browser-profiles) of the machine's settings is
one browser process with its own folder, `<data dir>/browser/<profile id>`,
which keeps its cookies and logins across restarts. A private tab gets a
process of its own in a throwaway folder, removed when its last tab closes.
A process starts with the first tab that needs it, and has 60 seconds to
answer: a profile's first start creates it, which took over 20 seconds on a
Windows CI runner. It is started through `procs.spawn` as a
tool process of `system:browser`, so [the trace](trace.md) shows it. It closes
60 seconds after its last tab, and with the core. Deleting a profile in
Settings closes its tabs and removes its folder; a folder whose browser had
already closed goes at the next settings change or the first use of the agent
browser after a restart. A folder that cannot be removed is logged.

The profile entry is removed only after the desktop app confirms that it erased
its local data. Web and phone clients keep the entry and explain that deletion
needs the desktop app. A failed erase also leaves the entry available to retry.

The browser downloads no components (`--disable-component-update`) and keeps
at most 64 MiB of HTTP cache (`--disk-cache-size`). Before a profile's first
start under those flags, the core removes what an older profile collected for
the browser itself (`trimProfile`): `component_crx_cache`, the
`ProvenanceData` folders, `Edge Wallet`, `Edge Entity Extraction`,
`Edge Shopping`, `Default/Cache` and `Default/Code Cache`, then writes
`boite-trimmed` so it happens once. Cookies, logins, preferences and
`Local State` stay.

Logins live on the machine that runs the agent, not on the device that shows
it. The core keeps each profile's cookies itself, in `boite-cookies.json` in
the profile folder, readable by its own account only: saved a second after a
page changes, every 30 seconds while a tab is open, when a tab closes and
before the browser process ends, handed back when it starts. The browser's
own cookie file was not enough: on the Windows and macOS CI runners of
2026-10-05 a cookie set in a tab was gone after the process closed, and a
cookie with no expiry date is never written by a browser at all. A private
tab's cookies are never saved. A core killed outright keeps what was saved
last, so a sign-in whose tab is still open is at most 30 seconds from the
disk.

### Copying a desktop profile's sign-ins

The desktop's own browser keeps its profiles in WebView2, on the PC. The
agent browser cannot read them, so Settings > General > Browser profiles has
**Copy sign-ins to agents** on each profile, in the Windows desktop app. It
lists the connected machines the user owns; picking one reads that profile's
cookies on the PC (`browser_cookies`, through a blank view of the profile
made for the read and destroyed after) and sends them to that machine's core
(`browser.importCookies`, owner only). The core adds the profile to its own
list under the same id and name when it has none, and hands the cookies to its
browser. `boite browser open <url> --profile <name>` then opens signed in.

It is a copy at that moment, not a link: a later sign-in on the PC is copied
again by hand, and a session the site ties to the PC's address or device may
still ask again. A partitioned cookie (one tied to the site that embeds it)
is left out, since the copy cannot carry that scope. The cookies cross the connection to that machine, so the
action is the owner's alone and never automatic. Signing in directly works
too: show the agent's browser and sign in there.

An agent that meets a login page asks with `boite ask --open <url> "<site and
why>" "Signed in" Skip`. The question card gets an Open button: it opens the
page as `boite browse` does, in a new tab of the conversation's browser and
its default profile, and shows the panel on the Browser tab, going to the
thread first from the Bots page or another conversation. It calls
`questions.openPage`, which names the question rather than an address, so a
paired phone subscribed to the conversation opens the page too, and the core
reads and checks the address again. The address must
be http or https and carry no user name or password. Such a question never
goes to a delegated agent's parent: only the user can sign in.

A conversation has at most 8 tabs and a machine 24. A page that opens a
window, a sign-in popup for instance, adds a tab to the same conversation; past
the limit the window is closed. A script's `window.open` without a click opens
one too: neither the core's Chromium (`--disable-popup-blocking`) nor the
desktop app's webviews block popups, so the tab limit is the bound. The tab
shares the opener's profile and cookies and keeps `window.opener`, so the
sign-in can answer the page with `postMessage`; its page calling
`window.close()` closes the tab. A tab still attaching counts toward both
limits, so a burst of windows opened at once stops at the limit too. Nobody can answer a dialog in a headless page.
One raised while an agent command runs follows `dialog accept|dismiss`
(accept until told otherwise) and is listed in that command's output; any
other alert is accepted and a confirm or prompt declined, so a person acting in
the panel never confirms by accident. All are noted in the diagnostics. Downloads go to a
[quarantine](#downloads). Archiving or removing the
conversation closes its tabs.

When a DevTools session detaches, its pending commands fail immediately with
their method and session identity; commands for the browser or another session
keep waiting for their own answers. A native click accepts detachment only
while releasing the mouse on its own tab, as happens when a popup closes itself.
It sends no remaining double-click input or navigation queries to that page.
Detachment identifies the lost session, not why it disappeared. Earlier input
failures, protocol errors and a closed browser connection still fail the click.

### A tab nobody uses sleeps

The browser runs every tab as shown (`--disable-renderer-backgrounding` and
the timer and occlusion flags beside it) and each tab emulates focus, so a
page left open runs at full speed. On 2026-10-17 one renderer of M2's agent
browser had run 16 hours at 38 % of a core with no agent on it. A tab
therefore sleeps (`browser/sleep.ts`): its page is frozen with
`Page.setWebLifecycleState`, which stops its timers, its animation frames and
its tasks. It sleeps once all of these hold for 30 seconds
(`SLEEP_AFTER_MS`): no agent command or viewer request runs on it, no viewer
is shown it, no recording runs in it, and its conversation has no running
turn that used it in the last 5 minutes (`TURN_HOLD_MS`). A viewer is shown it
while a screencast of it runs, a viewer asked for a frame within 3 seconds, or
a client said within 15 seconds that it shows the tab's own page
(`browser.remoteWatch`, `REMOTE_WATCH_MS`). The desktop app says so every 5
seconds while its panel shows a tab it hosts and its window is visible: that
page is the agent's own webview, which asks for no frames. The check runs
again every 30 seconds while something holds the tab. The wait covers the gap
after a turn ends or the last viewer leaves: a follow-up turn or a viewer
coming back within it finds the page as it left it, and an abandoned page runs
at most a minute. A turn that works elsewhere for half an hour lets its tab
sleep about 5 minutes after it last used it, and its next command wakes it.

Focus emulation keeps a page shown, and Chromium does not freeze a shown page:
the call answers but the page keeps running. Focus emulation goes off before
the freeze and back on after the wake. The tab wakes before every agent
command, every frame, input or copy of a viewer, and when its conversation
starts a turn, so the agent's pages run while it works, as they did when it
last looked. Freezing and waking take turns per tab: a command that arrives
while the page is being frozen waits for the freeze, wakes the page and only
then runs, and the page is visible and focused again when it does. The
browser draws one tab in front; the others are drawn only because focus
emulation keeps them shown, and the freeze hides them. A woken tab of the
core's own browser is therefore brought to the front last: before that, a page
that was not in front stayed hidden after its wake, and a screenshot of it
waited 30 seconds for a frame (measured on 2026-10-28 with two tabs in one
profile, of one conversation or two). A tab the desktop app hosts is not
raised, which could show its window. A tab
closed while asleep is woken first, and a freeze that fails is tried again after the wait. A page asleep keeps its state; its timers
resume where they stopped, and a page that reads the clock sees the time pass.
The browser answers the freeze once it has passed it to the renderer, not once
the renderer has applied it: a busy renderer runs the page until it gets to it
(a few hundred milliseconds on a loaded macOS runner on 2026-10-19), so a tab
counted asleep may still run that long. Its page's `freeze` event says when
the freeze landed.

Each call of a freeze or a wake has 5 seconds. A frozen page still answers
DevTools at once (measured on Windows on 2026-10-19), so a call that misses
them met a stalled renderer or browser, not a frozen page: a wake that fails
fails the command that asked for it, the tab stays asleep and the next use
wakes it again. The command fails at those 5 seconds; after it, a
`browser.sleep-stalled` warning says whether the browser itself still
answered (`Target.getTargetInfo` for the tab, within 1 second), and a
`browser.sleep-late` warning says when the page answered, or that it never did
within 30 seconds.

A tab the desktop app hosts gets the same calls through the relay: `Page` and
`Emulation` are among the domains an agent webview takes. The desktop's own
pages, the ones the user browses, are suspended once hidden
([panel](panel.md#surfaces)).

An open tab does not hold back an update of the core: the browser's processes
are not counted as work under way. The update closes them, the cookies are
saved first, and the tabs themselves are not reopened.

The agent's commands of one conversation run one after the other, in order.
The reads that only report state (`status`, `profiles`, `downloads`,
`recipes`, `recipe-get`) answer at once instead of waiting their turn. While a
command runs, `status` names it in `blocking`: its action, its tab, its step and
when the command and the step began (`BrowserBlockingCommand`); the CLI prints
it as a `running:` line.

Each step of a running command has a bound (`BROWSER_STEP_MS` in
`packages/core/src/browser.ts`): `start`, while the profile's browser starts,
90 seconds (the 60 seconds a browser gets to answer its start, then up to 30
to restore its cookies); `attach`, while a new tab is created and attached, 60
seconds; `wake`, while a sleeping tab wakes, 30 seconds; `act`, the action
itself, 60 seconds, twice a DevTools call's own 30 seconds, which covers a
navigation, an evaluate and the 15 seconds an agent may wait. The commands of a
recording get 110 seconds for their `act` step, under the 120 seconds the
agent's CLI waits; the recording itself runs between them and no bound touches
it. A step past its bound fails the command with its action and step named, and
the next command of the conversation runs. The work it waited on is not
stopped: a browser that starts late still serves the next `open`. A
`browser.command-stalled` warning, which `boite logs problems` lists, names the
thread, the tab, the action, the step, how long the step waited and how long the
command had run.

A command given up this way never reaches its next step, since the commands
after it already ran. An `open` given up while its browser started creates no
tab once the browser answers; one given up while its tab attached closes that
tab before the conversation sees it, so the page is never loaded and the active
tab does not change. An action given up in its `act` step may still change its
page: until its work ends, its tab refuses every command but `close` at once,
with a message that names the tab and the action and says to close the tab or
open another. `status` shows that tab's `stuck` field (`BrowserStuckAction`: the
action and when it was given up), and the CLI prints it under the tab. The mark
goes when the work ends, and that late end leaves the dialog handling of the
command after it alone.

A command whose caller closed its connection before the command's turn came
never runs; one already running finishes, since it may be changing the page.

`open` and `navigate` wait up to 10 seconds for the next page's DOM, never for
the load event, which an image or a script that never finishes can hold back;
a page still loading by then is returned with `loading: true` rather than an
error. A click, a key or a fill that starts a navigation waits the same way and
reports where the page went. Clicks, keys and text are native input; an element
something covers is clicked through the DOM, and the agent hears what covered
it.

Before pressing, a native click waits up to two seconds for trusted pointer
movement in the target's document and checks that the target and every enclosing
iframe still receive that point. This also works in popups whose CSS `:hover` state stays unset.
If movement misses the target, the command fails without pressing; it never
retries the click.

## Frames from other origins

The page kit reads a frame of its own origin through the iframe, and measures
an element there in its own document, then moves the point out through each
iframe around it. The browser hides the document of another origin from the
page's script: a payment form, a captcha or an embedded sign-in would show only
its iframe. The kit lists each such iframe that has a size, and the core reads
its document in the frame's own context, then sets the lines under the iframe
and numbers its refs after those read before (`browser/page-frames.ts`):

- A frame of the same site runs in the page's renderer, in an execution context
  of its own on the tab's session; the core keeps each frame's context from the
  `Runtime.executionContextCreated` events.
- A frame of another site runs in a process of its own, a target whose id is
  the frame's. The command attaches to it, enables its runtime, so its own
  frames of the same site are listed too, and leaves it when it ends.
- The iframe's element names its frame through `DOM.describeNode`.

The kit keeps its refs in each frame's own window, and the core keeps, for each
ref the last snapshot read in a frame, the iframe refs that lead to it. A
command on such a ref runs in that frame's document. Native input is sent to
the tab in the top document's coordinates: each iframe around the element is
scrolled into its parent's view, and the point moves out through its content
box, scaled with it. A point outside a parent's view, or where something is
drawn over an iframe, is clicked through the DOM, with a note naming what
covered it. A navigation of the top document forgets the frame refs, so an old
one is refused by name.

A snapshot reads at most 30 frames of other origins, within its 40,000
characters; one past either is a note under its iframe. With `-i`, a frame with
nothing to act on is left out. The desktop app relays no
`Runtime.executionContextDestroyed` and attaches to no frame's process: a hosted
tab reaches a frame of the same site through its context, and a frame of
another site shows as a note.

## The desktop app hosts the tabs

On Windows, the desktop app connected to the core it started hosts new agent
browser sessions once a profile's previous engine has closed. Each hosted
agent tab is a webview of the app (WebView2), in the
same profiles as the user's own Browser tabs, so a site signed in there is
signed in for the agent too. The panel shows that webview itself, parked over
its slot: it scrolls, types and paints natively, and nothing is captured or
streamed. The app attaches with `browser.hostAttach` as soon as it is
connected; only the owner's desktop app on this machine's loopback may.

The core still drives the tab over the DevTools protocol, exactly as it drives
a browser it started (`browser/host.ts`). It sends each message to the app
(`browser.hostMessage`, one connection per profile) and the app answers as a
browser would (`packages/ui/src/lib/browser-host.ts`): a page command goes to
that webview's own DevTools channel, which WebView2 hands to the app without
any port; `Target.createTarget`, `attachToTarget` and `closeTarget` create,
name and close webviews; a page's events, its address and title, and the
windows it opens come back with `browser.hostReply`. Network events are cut
to what the core reads: a request's address, and a response only when it
failed, with its status and address (`compactPageEvent`). A call the page makes
to its servers (`Fetch`, `XHR`, a document, an event stream) also keeps its
method, headers, type and response headers, and its end comes back with the
bytes it took, so [`browser network`](#network-calls) lists hosted tabs too.
The shell lets an agent
webview (an id starting with `agent-`) take the Page, Runtime, Input,
Emulation, Network, Log and DOM domains, never the profile's cookies
(`apps/shell/src-tauri/src/browser_control.rs`). An agent webview out of sight
is moved outside the window rather than hidden, since a hidden WebView2 stops
painting and the agent screenshots and records pages nobody looks at.
An agent webview and every popup its pages open are muted by WebView2 from
creation (`ICoreWebView2_8::IsMuted`), which no page can undo; the user's own
tabs keep their sound.

The core keeps a copy of a hosted profile's cookies in the same
`boite-cookies.json` as for its own browser, with the same saves. The app
answers `Storage.getCookies` and `Storage.setCookies` through two commands of
their own, `browser_cookies` and `browser_set_cookies`, only from the main UI,
through a live agent webview of the profile or a blank one made for the call.
When the first hosted tab of a profile opens, the core hands the app the saved
cookies its profile lacks, compared by name, domain and path: a sign-in made
in the core's own browser while the app was closed, from the phone for
instance, or a session cookie WebView2 dropped when the app quit. A cookie the
app already holds stays as it is. The other way, a sign-in made in a hosted
tab is on the core's disk within a second of its page changing, so the core's
own browser still has it once the app is closed. A cookie deleted in the app
while no agent tab was open is still in the saved copy and comes back with
the next hosted tab.

The agent's `browser status` says `hosted: true` while an app hosts. Tabs
opened before the app attached stay in the core's own browser, and a tab
the app hosts closes with the app: quitting it, reloading its page or losing
the connection ends the relay, and the next tab opens in the core's own
browser again. Other clients of the conversation, a phone or another machine,
still watch a hosted tab as frames, taken through the app. The Linux and
macOS apps do not host; their webviews have no DevTools channel to relay.

## Network calls

`boite browser network` lists the calls a tab's page makes to its servers:
fetch and XHR calls, documents and event streams, never its scripts, styles,
images or fonts. Capture is off until an agent asks: every tab enables the
`Network` domain with no buffer for bodies, and the first `browser network`
in a tab enables it again with 20 MB for responses (4 MB each) and 64 KB of
request body, then lists only what the page does from there; reloading or
acting on the page fills the list. `browser network --filter <text>` keeps
the calls whose method, address or type contains the text. A tab keeps its
last 300 calls (`packages/core/src/browser/network.ts`).

`browser network <id>` shows one call: its headers, without the ones the
browser sets itself, its request and response bodies up to 50,000 characters,
and the `page.fetch` line that sends it again from the page. A binary
response is described, never sent. Credentials are hidden before anything
leaves the core: a header, a query parameter or a JSON or form field named
like a cookie, an authorization, a password, a secret, a key, a session, a
signature or a token reads `<hidden, N characters>`, after an acronym or in
the plural too (`APIToken`, `apiKeys`). A list or an object under such a name
is hidden whole, as is a value nested past 20 levels. The address in a
`Location`, `Content-Location` or `Referer` header has its query masked as a
call's address is. A body is masked whole, then cut. One that does not parse
as JSON (a guard prefix, a stream of values, a page's inline script) has each
`"name": value` pair masked on its own, a list or an object up to its closing
bracket. Only pagination tokens stay readable (`page_token`,
`next_page_token`, `continuation_token`, `next_token` and the like), since an
agent pages through results with them; `page_access_token` is hidden. The
note under a call with hidden values tells the agent to read them from the
page each time. `browser network stop` forgets the calls and gives Chromium's buffers
back.

`page.fetch(url, { method, headers, body })` in a script runs `fetch` in the
page, so the request carries the page's cookies and passes its CORS rules as
the site's own code would. It returns the status, final address, headers and
the body as `json` when the reply is typed JSON or starts with `{` or `[` and
parses, as `text` otherwise (a bare `42` stays text). It reads no further
than 2,000,000 characters and returns them with `truncated: true`. A status of 400 or more fails the step with
the start of the body. The step's label leaves the query and the body out. The
request travels as one page expression, so address, headers and body fit in
32,000 characters; a longer body is built in the page and sent from `page.eval`.

## Recipes

A recipe is a `browser run` script kept on the machine under a name, so the
next agent with the same task on the same site runs it in one call instead of
driving the pages again (`packages/core/src/browser-recipe.ts`).
`boite browser recipe save <name> <file|-> --about "<what it does>"
[--usage "<its args>"] [args...]` runs the script with those words first and
keeps it only if the run passes; its flags come before the script's first
word, and every word from there on is the script's own. It is kept under the sites it asked for, reached after
redirects or fetched, and the site its tab ended on. Saving a name again replaces the script and keeps its
`--about` and `--usage` unless new ones are given. `recipe list` shows each
recipe's command, sites, runs and last result; `recipe show <name>` adds its
script; `recipe delete <name>` removes it. `browser open` and `navigate` name
the recipes kept for the site they reach.

`boite browser recipe run <name> [--tab <id>] [args...]` runs the script as
`browser run` would and records the result on the recipe. A run that fails
names the step and shows the page it stopped on, as any script does, then
says how to repair the recipe: show its script, fix it against that page and
save it again under the same name. The agent that ran it does the repair in
its own turn; `recipe list` marks the recipe broken, with the step and the
reason, until a save or a run passes.

The core only stores recipes: one JSON file each in
`<data>/browser-recipes/`, mode 0600, at most 200 of 64 KB each, outside
`browser/`, whose unknown folders the profile cleanup removes
(`packages/core/src/browser/recipes.ts`). A recipe runs in the agent's CLI
process with the agent's own rights, as any script it wrote would. Recipes
belong to the machine, not to one conversation, and any agent of the machine
may run, replace or delete one. A demo client keeps none.

## Downloads

A page can download a file, for the agent or for the user acting in the
panel. The browser the core starts writes it into `<data dir>/browser-downloads`
under a random name with no extension (`Browser.setDownloadBehavior`
`allowAndName`), never under the name the page offered and never in a
project, so nothing lands where it could be run or opened by accident.
`browser/downloads.ts` keeps the list:

- A download belongs to the conversation whose tab (or one of its frames)
  began it. A frame no conversation owns has its download cancelled.
- The reply of the command that started one lists it, so the agent learns of a
  file it did not expect. A click that downloads ends when the download begins,
  not at the 10 s a navigation is given, and `open` of an address that is a
  file leaves the page where it was instead of failing.
- At most 1 GiB per file and 2 GiB in the whole quarantine of a machine; past
  either, the browser cancels it. The size is checked at each progress event
  Chrome sends, about every 500 ms, so a file can pass the cap by what arrives
  in that time; a finished file over it is removed. A conversation keeps 20, the oldest finished
  one going for a new one.
- When it ends the core reads its sha256 and its first 512 bytes. Its `kind`
  is the riskier of what the bytes and the name say (executable, script,
  archive, document, image, media, text, other), and `warning` tells the agent
  what to check: a program or a script is never run unless the user asked for
  that exact file, an archive is unpacked into its own empty folder, a picture
  whose bytes are a program is flagged as disguised. The address is kept without
  its query and fragment, which can carry tokens.
- `boite browser download save <id> [path]` copies it into the working
  directory or a folder under it, never through a link that leaves it, in 4 MB chunks, with
  mode 644 so never executable, under a cleaned name (no path, no reserved
  character, no leading dot) that never replaces a file, checks the sha256,
  then removes it from the quarantine.
- An unsaved download goes an hour after it ends, when its conversation is
  archived or removed, and with the core: the folder is emptied at the first
  browser start and when the core closes.

A tab the desktop app hosts in a webview keeps that webview's own download
handling: the core sees none of those downloads.

## Recording

`recording-start` records the tab as a silent MP4 without any encoder on the
machine. The tab streams its frames (`Page.startScreencast`, at most
1920 × 1080), and a blank page of the same browser, in a throwaway context of
its own, draws them on a canvas that a `MediaRecorder` encodes. The take gets
every picture the page draws, and frames reach the canvas at most at the
take's rate; a frame that comes early waits its turn and the newest replaces
it. A frame is acknowledged when it leaves, not when it arrives, and one stays
unacknowledged while a frame waits, so Chrome encodes about one picture per
slot of the take: a 30 Hz animation keeps all its pictures, a 60 Hz one costs
about 30 encodes a second. Chrome skips the paints it makes while held back,
so when no picture follows within 150 ms the screencast restarts, which sends
the page as it is. The helper decodes each frame with
`Uint8Array.fromBase64`. A still page sends no frame, so the last one is drawn again each second and the video keeps
its length. H.264 is the default. Chrome 153 on Linux encodes H.264 and AV1 into MP4, not
HEVC; a codec the browser cannot encode is refused with the ones it can. The same 100 MB limit and turn rule
as before apply: a recording still running when the agent's turn ends is
stopped and thrown away.

## Watching it

The panel's **Browser** surface looks like a browser: a strip of the
conversation's tabs, then a toolbar with back, forward, reload, the address
and two buttons, **Display** and pause, then the page. In the desktop app on
its own core, the one it started, the page shows at once: the app trusts the
core it started and the frames stay on that machine, so there is no cover. A
plain browser on the same machine is not told it is local and keeps the cover. Any other client first gets a card that names
the machine, "This agent controls a browser on m2", with the page's title, and
a **Show** button; nothing is captured or sent before that. Show starts the
live view and, while a page shows, the eye in the tab strip covers it again. When the agent opens a
tab in the conversation on screen, the panel opens on that surface on clients
wider than 720 px. A phone stays in the chat or on the surface the user chose.
Its **Browser** button opens the viewer, and **Chat** or Back returns to the
conversation without closing any agent tabs. The
launcher's **B** opens it by hand, and `boite browse <url>` opens a page in a
new tab of it. On a client with a cover, it holds for the
conversation while the app stays open, and a reload covers it again.

The owner opens and closes tabs as in any browser. **+** adds a new tab page
with an address field, and Enter opens the page in the conversation's browser
(`browser.command` `open`, the machine's default profile), live at once when
it opens since the owner asked for it; a refused address stays in the field
with the reason. A tab's **×** closes it (`close`), the agent's tabs
included. With no tab open the owner lands on that new tab page, which is where
to sign in to a site the agent then uses. A paired phone watches and drives the pages
but neither opens nor closes a tab: `browser.command` is not one of its methods.

The page takes the size of the view showing it by default, as a page takes
its window's: on Show, and again once the view stops changing size, the viewer
sends that size (`viewport`). That size is the agent's too. **Display** picks
another by hand, which holds until **Fit this screen**.

The live view asks for one JPEG at a time (`browser.remoteFrame`), the next as
soon as the last has arrived, sized to what the view shows and lighter on a
slow link; [phone](phone.md#the-agents-browser-on-a-phone) has the schedule.
The frames come from a screencast of the tab on a DevTools session of its own,
started by the first viewer and stopped 3 s after the last one asked, when the
tab closes or its viewers disconnect (`browser/frames.ts`). Chrome sends a
picture only when the page draws, so a still page sends nothing. The core keeps
the newest picture and acknowledges it when a viewer takes it, so Chrome draws
no faster than the fastest viewer. Viewers of a tab that ask the same width and
quality share one screencast; each other width or quality gets its own, so a
phone on a slow link never downloads the desktop's wider, heavier frames. A
viewer names the frame it shows (`after`): the core answers with a newer one,
or with `unchanged` once a second passes without one, and the frame it shows
stays valid for input. Chrome sends nothing for the last size of a quick run
of resizes, and skips paints while two pictures wait for an acknowledgement:
when no picture follows within 300 ms, the screencast restarts, which always
sends the page as it is. A tab the desktop app hosts has one DevTools session,
the agent's, so its viewers still get one capture per request, shared within
150 ms. Input names the frame it was aimed at; a tap
on a frame of another page or another viewport size is refused, and the
address bar accepts only http and https.

A computer drives the page itself, with nothing under it; the page's tooltip
says how, and a copy shows a short note over the page. A click on the page gives it the keyboard until a click or a focus lands
elsewhere: characters, Enter, Tab, Escape, the arrows, Home, End, Page Up and
Down, Delete and Backspace leave as native key events (`press`), and the keys
typed while a request is in flight leave together in the next one, in order.
The wheel scrolls under the pointer. A drag with the mouse is a drag in the
page, so it selects text; a second click selects the word, a third the
paragraph, and Shift with a click extends the selection. Control or Command
with A selects all, with Z or Y undoes and redoes.

A `<select>` opens here, not on the agent's machine. Chrome draws a select's
list in a window of its own, which no frame shows, so a plain tap on one only
focuses it and answers its options (`picker`: labels, the selected one, the
disabled, hidden and grouped ones, and the field's box, at most 1,000 options),
and the viewer draws the list under the field, or over it when there is more
room there. The arrows, Home, End, Enter, Space and Escape work in it. A pick
goes back as `choose` at the tap's point with the option's index and label; the
core finds the select there again and sets the option as a person would, so the
page hears `input` and `change`, and refuses an option that is disabled, gone,
or reads another label there: the page changed the list meanwhile. A tap
elsewhere, the wheel or a resized page closes the list without choosing.

The clipboard is the viewer's own. Paste inserts this computer's text in the
focused field of the page. Copy and cut ask the core for the page's selection
(`browser.remoteSelection`) and write it to this computer's clipboard; cut then
erases it in the page. The selection is read in the focused field, else in the
document, through open shadow roots and same-origin frames, at most 100,000
characters. A password field answers nothing, and a selection inside a
cross-origin frame is not read. The other Control and Command chords and the
function keys stay with the app.

A touch screen (`pointer: coarse`) keeps the scroll buttons, the keys and the
text field under the page, with a **Copy** button for the selection: a double
tap selects a word first. Pasting there goes through the text field.
`lib/live-input.ts` holds the keyboard and clipboard rules for this view and
the Device panel.

These are frames, not a video stream: a few a second while the page moves.
A video stream (the screencast encoded as H.264 and decoded by WebCodecs in the
client) would be smoother on a fast link; it is not built.

## Who may do what

`browser.command` is the owner's and the conversation's own agent's, never
another conversation's: its token names one thread. A paired phone has
`browser.remoteStatus`, `browser.remoteFrame` and `browser.remoteInput` for a
conversation it has subscribed to, with `browser.remoteSelection` for the text
selected there, and never `browser.command`, so it cannot run a script in the
page. It can act in the page as a person would, signed-in
sites included: pair only devices you would give that. `browser.remoteChanged`
goes to the clients subscribed to the conversation.

On Linux and macOS the core speaks the DevTools protocol to the browser over
`--remote-debugging-pipe` on the browser's descriptors 3 and 4, which
`procs.spawn` opens with `extraPipes`. Bun makes each a socket pair, and the
core opens both with `Bun.connect({ fd })`: a `Bun.file(fd).stream()` reader
on the replies stopped being polled under load (Bun 1.4.2 and 1.4.3 on Linux,
a one-shot epoll registration never armed again while answers waited in the
socket), and every command after it timed out. No port is open: another process
of the machine, another account included, cannot reach the browser through
it. It can still read the profile folder if its permissions let it, as with
any browser profile.

On Windows Bun cannot open those descriptors (`EBADF`, CI on 2026-10-05), so
the browser listens on a random port of 127.0.0.1 and the core connects to it.
The core reads that socket with its own WebSocket client on `Bun.connect`
(`packages/core/src/ws-client.ts`), as it does every socket it opens to
another core: Bun's client (1.4.2 and 1.4.3) lost frames of sound streams and
closed them with 1002 or 1011. That port has no authentication: a process of
the same PC that finds it can drive the browser, signed-in profiles included.
Do not copy sign-ins into the agent browser of a Windows machine other people
have an account on.

## Verification

`packages/core/test/browser.test.ts` drives a real headless Chromium when the
machine has one: opening, reading, clicking and typing, agent-browser's
refs, fill, select, check, a form submitted with Enter, dialogs inside and
outside a command and a covered element, presets and color scheme, diagnostics without query strings, a token kept to its conversation,
a paired viewer's frames and taps, a popup becoming a tab, the user agent a
page, a worker, a request and a popup send without `Headless`, with
`navigator.webdriver` false and full client hints, cookies kept per
profile across a restart, a profile copied in by the owner, an MP4 recording
read back, a recording discarded at the end of a turn, a page that sleeps
once nobody uses it and meets the next command and viewer awake and focused
(its page busy 400 ms each time it is hidden, so each freeze lands late),
a background tab whose screenshot answers once it wakes, one kept awake by `browser.remoteWatch`, and a machine without a browser. `browser-stuck.test.ts`, with no browser and a desktop app that never answers, checks that `status` answers and names the command stuck at its `start` step, that a step past its bound fails with the step named, logs `browser.command-stalled` and lets the next command run, and that a command whose caller left before its turn never runs. `browser-abandoned.test.ts` checks, with a real browser, that an `open` given up while a held desktop app started its browser leaves no tab, no request for its page and no change of active tab once the browser answers and the next `open` ran, and that an `evaluate` given up in its `act` step marks its tab: a `snapshot` on it is refused at once, `status` shows the mark until the evaluate ends, and `close` works while it runs. `browser-sleep.test.ts` checks, with the page
stubbed, that a command arriving during a freeze runs after the wake, and that
a held or closed tab never sleeps, that a running turn holds an unused
tab only 5 minutes, and that a wake call that misses its time fails at once and then names who stalled. `AgentBrowserSurface.test.ts` checks that the desktop app
reports a hosted tab it shows, only while its window is visible. `browser-cli.test.ts` checks the CLI's files and `browser run` scripts with the browser stubbed,
and recipes kept only after a run passes, a failed run recorded with the way to repair it and a repaired one saved again, against the core's own store.
`browser-network.test.ts` captures a page's API call in a real Chromium, reads its body after capture started, hides its authorization, password,
query token and session field, repeats it with `page.fetch`, and keeps and runs a recipe built on it. `browser-host.test.ts` checks the fields a
hosted tab relays for a call; the Windows app's relay of them runs only on Windows.
`browser-frames.test.ts` reads and drives a payment form in a frame of the
page's origin, one of another site, one of another origin of the same site
below the fold, and a frame of another site nested in the second: native clicks land in each (`isTrusted`),
fill and get reach them, and a frame ref is refused after the page moves on.
It also clicks into a frame nested in an offset frame and into a scaled one,
and through the DOM when a button is drawn over the frame. The desktop app's
relay of frames is not covered.
`tests/e2e/agent-browser-core.test.ts` runs the whole path on a real core: the
owner's desktop at 1280 × 900 and a paired phone at 390 × 844 see the cover,
show the page and tap it, and the tap reaches the page. `browser-remote.test.ts`
covers the same views on the fake client.
The same tests pass on the Linux, Windows and macOS CI jobs. Reading a
WebView2 profile's cookies in the Windows shell is covered by unit tests of
the bridge with the shell stubbed, not by a run on Windows.
