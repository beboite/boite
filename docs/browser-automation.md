# Browser automation

Jev Browser delegates a small browser task from a conversation. Boite runs
the official agent-browser 0.37.1 binary as a persistent native daemon and
sends its accessibility snapshots to TypeSafe's `jev-1.13.0` model. Jev
chooses among observed controls; the native driver performs the action.
The plugin uses no Playwright dependency and requires no upstream fork.

## Setup

1. Set `TYPESAFE_API_KEY` in the environment of the machine's core, then
   restart the core. The Settings page reports whether the variable exists;
   it never returns its value.
2. Open Settings > Plugins and install Jev Browser. The existing plugin
   installer checks the pinned SHA-256 before saving the native executable.
3. Set an absolute browser executable path if agent-browser cannot find
   Chromium on the host. Chrome, Edge and Chromium are supported by the
   driver. No browser download or interactive login runs automatically.
4. Enable browser automation and save. Disabling it cancels active tasks.

These are host settings. A remote owner configures the connected machine,
and paired devices cannot install or configure the plugin. Installing the
plugin alone does not enable agent access.

Every task owns a hidden, muted browser with a temporary profile. It does
not attach to the panel WebView or an existing browser pool. Page content
and supplied form values go to TypeSafe for the task. The browser process
receives neither the API key nor the conversation's agent token.

## Delegate a task

Write a JSON file in the working directory, for example `browser-task.json`:

```json
{
  "pluginId": "jev-browser",
  "url": "https://example.org/preferences",
  "goal": "Set Customer name to Ada, choose Weekly, enable Email updates and save once.",
  "values": { "customer": "Ada", "frequency": "Weekly" },
  "completion": { "text": "Saved preferences", "url": "https://example.org/preferences" },
  "maxSteps": 20,
  "timeoutMs": 120000
}
```

```sh
boite browser run browser-task.json --json
boite browser list --json
boite browser cancel <id>
```

The CLI supplies its thread id. Start returns immediately with a task id.
Settings > Plugins displays recent tasks, progress, input token counts and
Cancel. Agents can list and cancel only tasks from their own conversation.
Archiving a conversation, removing its project or shutting down the core
also cancels its tasks. Installation, update and uninstall wait until that
plugin's active tasks have closed.

`completion.text` is required and matched against rendered body text.
`completion.url`, when present, must match exactly. A model's `done` answer
cannot turn a missing completion condition into success. Choose a condition
that proves the requested result: a generic "Saved" message does not prove
which values were saved. Callers remain responsible for any stronger domain
check, such as reading the saved record through the application's API.

Results are `succeeded`, `needs-agent`, `error` or `cancelled`. A result needing
the agent names the reason. Examples include a step/time limit, missing evidence,
the page leaving the starting origin, uncertain action delivery, or Jev handing
off because it needs another capability, missing text, or human input. The engine does not
replay a failed action. A fresh task starts a new browser, so inspect an
uncertain submission independently before resubmitting it.

## Bounds

The loop supports links, buttons, tabs, menu items, radio buttons, explicit
checkbox states, text fields and selects. Text and select values must appear
in `values`; Jev cannot generate them. At most eight named strings are accepted.
Interactive snapshots expose controls without the full article text. Each
decision receives up to 120 actions and 24,000 characters of control state,
plus 4,000 characters of rendered page text. Jev can inspect subsequent groups
of controls on large pages; these inspections consume the same step budget.
Controls retain document order. A blocked decision advances to any unexamined
group before handing the task back.

An editable ARIA combobox is filled; a native select is selected by its option
value or label. The adapter inspects the focused control to distinguish them,
including controls in open shadow roots. A temporary marker verifies that the
focused element matches the chosen reference and is removed before the field
action. Unsupported widgets return control
to the caller. Every fill or selection reads the field value back; a successful
driver response alone cannot authorize the next submission.

Each decision uses a new snapshot and checks it again before acting. If the
page changed, no action is sent for that decision. The next iteration reads
the page again. Jev's choice confidence is not treated as a calibrated
probability that a browser action is safe or correct.
An empty document during navigation is observed again before asking Jev.
Completion or handoff decisions are checked against a fresh observation, so
content that arrived during the model call is considered before stopping.

Defaults are 20 decisions and two minutes, with maxima of 60 decisions and
five minutes. At most two tasks run on a host and one in a conversation.
The last 100 task summaries stay in memory until the core restarts. The host
does not retain the `values` dictionary or snapshots. Browser process groups appear in the trace as
`browser:<task-id>`.

This version does not automate native desktop applications, reuse login
profiles, manage uploads/downloads or provide multi-tab workflows. It stops
after observing navigation outside the starting origin. This is a task
boundary, not a network filter. Iframes, complex widgets, authentication,
anti-bot behavior and arbitrary real websites are not established capabilities.
The [public-site evaluation](../bench/results/2026-09-24-browser-wide.md) ran
30 workflows on 23 sites, three times each: 38/84 valid trials succeeded.
Six attempts had incorrect test criteria; six separate reruns passed after
correcting those criteria. Unnamed fields, large control lists and premature
completion still cause failures. Live recordings show successes and a failure.
The [Luna max Fast comparison](../bench/results/2026-09-24-browser-luna.md)
adds 120 public-site trials of direct Luna and Jev with Luna fallback, plus
separate live recordings. Both policies pass 43/60 frozen automatic checks;
the report distinguishes verifier defects, blocked sites and driver failures.
These policies are benchmark prototypes and are not plugin settings.
The [large-site controller comparison](../bench/results/2026-09-24-browser-lab.md)
adds eight longer workflows with independent per-requirement review, two
repetitions across four native/Playwright and DOM/vision configurations,
and separate controller, model and memory prototypes. It includes actual
downloads, product comparisons, maps and a round-trip flight selection.
The [integration diagnostics](../bench/results/2026-09-24-browser-diagnostics.md)
separate transport, download and capture failures from server redirects.
These experiments do not expand the installed Jev plugin's capabilities.
Linux and macOS use the driver's Unix socket transport, but their
browser execution and forced cleanup need platform verification. Windows
owns the headless browser tree through the native driver's job object.

## Protocol and verification

The manifest declares `provides.browser.protocol: "agent-browser-0.37"`.
The adapter requires a 0.37.x installed binary. It starts that binary through
Boite's process registry with `AGENT_BROWSER_DAEMON=1`, an isolated socket
directory and a dedicated session. One newline-delimited JSON connection
carries the native commands. Heavy transport code loads on the first task.
The daemon protocol is an upstream internal interface; a version upgrade
must run the native integration test before changing the pinned manifest.

```sh
bun test packages/core/test/browser.test.ts packages/core/test/browser-rpc.test.ts
bun test tests/e2e/plugins.test.ts
```

The paid test is opt-in. Set `BOITE_E2E_JEV=1`, `TYPESAFE_API_KEY` and
`BOITE_BROWSER_TEST_BINARY` to the pinned native executable, then run
`bun test tests/e2e/jev.test.ts`. It creates an isolated core and local form,
asserts the exact backend record and single submission in English and French,
follows a delayed control in an open shadow root, and checks normal and
cancelled process cleanup. An invoice workflow also searches among similar
identifiers, navigates, fills a conditional field, returns from review to
correct a value, and confirms exactly once. Its assertions check both review
records and the final server record. No personal profiles or real accounts are used.

Set `BOITE_E2E_JEV_PROFILE=1` for per-request Jev latency and native command
timings. The measurements include real network calls. Field actions have no
fixed settling delay; clicks retain a 150 ms rendering allowance. Each next
decision still re-observes the page and validates its references before acting.

On 2026-09-23, the invoice case passed in 9.94 seconds over 14 decisions on
Windows, including fresh browser startup and cleanup. Jev requests accounted
for 5.94 seconds. This is one local synthetic workflow, not a website benchmark;
API latency varies. Run it with the live variables above and
`bun test tests/e2e/jev.test.ts --test-name-pattern invoice`.

Upstream references: [agent-browser](https://github.com/vercel-labs/agent-browser),
[daemon protocol at 0.37.1](https://github.com/vercel-labs/agent-browser/blob/v0.37.1/cli/src/native/daemon.rs),
[TypeSafe models](https://docs.typesafe.ai/models).
