# Diagnostics

Boite keeps a log of its own problems on each machine, so a user who hits one
can send a file a developer can solve it from. Everything that leaves the
owner, an export, an issue or an agent's read, is anonymized first.

## Where the logs are

`<dataDir>/logs/` on the machine that runs the core:

| File | Written by |
| --- | --- |
| `core.0.ndjson` to `core.7.ndjson` | the core, including the records clients send about themselves |
| `shell.0.ndjson` to `shell.3.ndjson` | the desktop shell |
| `exports/boite-diagnostics-<UTC date>-<time>.txt` | an export; the newest ten are kept |

Each line is one JSON record: `at` (Unix ms), `level` (`debug`, `info`,
`warn`, `error`), `origin` (`core`, `shell` or `ui`), `source`, `event`, a
readable English `message`, optional thread, turn and request ids, the
thread's agent (`providerId`, `model`, `parentThreadId`), `durationMs`, and
`data`, at most 16 scalar values. Credentials and sensitive fields are removed
before a record is written. The shared helpers are in
[`packages/contracts/src/diagnostics.ts`](../packages/contracts/src/diagnostics.ts).

## Anonymization

`createLogAnonymizer` replaces project paths and names with `<project:xxxx>`,
the data directory with `<data>`, the home with `~`, the account name with
`<user>`, the host name with `<host>`, e-mails, private addresses and private
URL hosts. `xxxx` is a hash salted per installation, so one project keeps the
same placeholder across exports of a machine. Thread, turn and run ids stay,
so one conversation can be followed through the whole timeline.

## Settings > Diagnostics

The page is for the owner, on the desktop and on a phone connected as owner
([`DiagnosticsPage.svelte`](../packages/ui/src/components/DiagnosticsPage.svelte)).

- Status: Boite's version and channel, the system, how long the core has run,
  the records of the last 24 hours by level, and the log files with their
  sizes (`diagnostics.summary`).
- Problems: warnings and errors of the last 24 hours grouped by origin, source
  and event, errors first. A row opens on its latest message and the threads it
  touched; a thread that exists on this machine opens from there.
- Log: newest at the bottom, filtered by minimum level (info by default),
  origin, thread, text and period (15 minutes, 1 hour, 24 hours, 7 days). A row
  opens on its ids, its duration and its `data`. While the page is open, new
  core records that pass the filters arrive at the bottom. "Load older" pages
  backwards with `until`.
- Export anonymized logs: `diagnostics.export` writes the file in
  `logs/exports/` on the core's machine and returns its text. The desktop app
  saves a copy in Downloads; a phone offers the share sheet when it can, and a
  browser downloads it.
- Report a problem: a title, a description and the "include anonymized logs"
  switch. The preview is the body `diagnostics.issue` drafts with `submit:
  false`. When the core's machine has `gh` signed in, the issue is created on
  `beboite/boite` and its link shown. Otherwise GitHub's form opens in the
  system browser, prefilled with a shorter body, and the page names the export
  file to drag into it.
- Agents can read anonymized logs: the `agentLogAccess` setting, on unless the
  owner turns it off. Agents then read through `boite logs` and draft through
  `boite issue`. They get the anonymized view only, and each call names the
  agent's own thread: it sees the records about no thread and those of its own
  thread and the threads it started, never another conversation's.

## What a client reports

Each window reports to every machine it is connected to
([`diagnostics-report.ts`](../packages/ui/src/lib/diagnostics-report.ts)),
through `diagnostics.report`, which the owner and paired devices may call:

- a call the core answered with an internal error, or that got no answer
  within the client's timeout: method and error code, never the parameters;
- the socket dropping and coming back, with the time offline;
- for the first machine of the window only: uncaught errors and rejected
  promises nobody handled, with a stack cut to 300 characters and the page's
  address removed, and an interface that stopped responding for more than
  2 seconds while visible.

Records wait in a queue of at most 200, and the same event with the same
message counts a repeat instead of a new line. A batch of at most 50 leaves
every 5 seconds while connected. A batch lost with the socket is sent again; any
other failure drops it and is never itself reported. A core that does not know
the method, or refuses it, turns reporting off for that client. The core
keeps at most 300 records a minute per connection and stores them with
`origin: "ui"`, the client's name and whether it was remote.

## RPC methods

| Method | Who | What |
| --- | --- | --- |
| `core.logs` | owner | raw redacted records, newest first, up to 1000, filtered by thread, turn, level, minimum level, origin, source, time, text; `anonymize` on request |
| `diagnostics.logs` | owner, agents | anonymized records about no thread, plus every thread for the owner or the agent's own family |
| `diagnostics.summary` | owner, agents | environment, grouped problems, threads, log files, counts |
| `diagnostics.export` | owner, agents | the anonymized export text and where it was saved |
| `diagnostics.issue` | owner, agents | an issue draft, created through `gh` only with `submit: true` |
| `diagnostics.report` | owner, paired devices | up to 50 records a client sends about itself |

The in-memory core (`packages/ui/src/lib/fake-client/logs.ts`) answers the
same methods with the same validation and access. It never has `gh`, so an
issue there is always a draft with a prefilled link, and it seeds a recent day
of records so the page has something to show. `?fake=1&settings=diagnostics`
opens the page directly in a development build.
