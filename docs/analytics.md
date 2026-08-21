# Anonymous analytics

I don't want your data. I want to know whether anyone uses this thing and what
to fix first. Boite counts a few anonymous things and nothing else, and you can
switch even those off.

No feature is gated on it. The app is identical either way. If you would rather
read code than prose, skip to
[verify all of this yourself](#verify-all-of-this-yourself), which is the point
of this page existing in a git repository.

## Turning it off

Settings, Privacy. Two switches, both off means nothing is ever sent again.

Nothing at all is sent before you answer the first-launch screen. After it, the
anonymous counters are on: that screen asks about the enhanced tier, not about
the counters, so turning those off is a separate and deliberate action. The
anonymous tier is opt-out. The enhanced tier is opt-in.

A Boite that already finished setup before this existed sees a blocking screen
once, the same two choices, and nothing is sent until you pick. Skipping the
whole first-launch wizard counts as anonymous counters on, enhanced off.

A phone or a browser talking to a `boite-server` uses the same two switches.
The queue lives in the host process, never in the page.

An agent cannot read or change any of this. The methods are local to Boite's
own window (and to a phone signed into that boite). They are not MCP tools.

## What is never collected

None of the following ever leaves your machine, in any mode:

- Project names, folder names, worktree paths, file paths
- Prompts, transcripts, session ids, pane titles
- Tokens, git remotes, command lines, hostnames, URLs
- Your IP address, which is never stored anywhere
- Log files. Logs stay on your machine and are only ever shared by hand, when
  you choose to attach one to a bug report

An event says "a claude thread was created". It cannot say which project, which
folder, or what the agent was asked, because the app never puts that in the
payload. The Rust code that builds the payload is one function, and it is
linked at the bottom of this page.

Identifiers live in `telemetry.json` next to `boite.db`. They are not in the
settings blob. Agents can read settings. Machine sync would copy an install id
from one PC onto another. That is why they sit in a sidecar instead.

## What is collected

Fifteen events, and that is the complete list.

| Event                  | When                                      | Fields beyond the common ones                          |
| ---------------------- | ----------------------------------------- | ------------------------------------------------------ |
| `ping`                 | Once a day while the app runs             | `dropped_events`, only if any were                     |
| `first_run`            | The first launch of an installation       | none                                                   |
| `app_launched`         | Startup finished                          | `duration_ms`                                          |
| `session_ended`        | The process closed cleanly                | `duration_ms`                                          |
| `thread_spawned`       | A thread row was created                  | `kind`, `provider`                                     |
| `thread_closed`        | A thread row was deleted                  | `kind`                                                 |
| `project_added`        | A project was created                     | none                                                   |
| `pane_opened`          | A pane kind new to that group             | `pane_kind`                                            |
| `operation_failed`     | A named operation failed                  | `operation`, `error_code`                              |
| `update_available`     | An update was found                       | `target_version`                                       |
| `update_downloaded`    | It finished downloading                   | `target_version`                                       |
| `update_applied`       | It was installed                          | `target_version`                                       |
| `update_failed`        | Any of the three above failed             | `target_version`, `error_code`                         |
| `workspace_snapshot`   | Each start, enhanced only                 | `project_count`, `thread_count`, `live_pty_count`      |
| `settings_snapshot`    | Each start, enhanced only                 | the settings listed below                              |

One more event exists and is not in that table because it is not tied to an
installation at all: `consent_choice`, recorded once when you answer the
first-launch screen. It carries the answer and the app version, and lands on a
single shared counter so the three possible answers have a denominator.

Every event also carries seven common fields: the app version, a fixed OS
identifier (`windows`, `macos`, `linux`), the architecture, the OS version,
your locale (for example `fr-FR`), whether it came from the desktop window or a
`boite-server` (`surface`), and the time it happened, to the second. The server
adds one more, the country code, derived from your IP address without storing
the address itself.

`provider` is one of the ten adapters, or `shell`, never a binary name you
typed. So are `pane_kind`, `error_code`, `operation`, `theme` and
`ui_language`: each is matched against a fixed list in the code, and anything
unrecognised is recorded as `other` rather than sent as it was. That is what
makes it impossible for an error message, which routinely contains a file path
with your username in it, to travel inside one of those fields.

`workspace_snapshot` counts how many projects and threads exist, and how many
terminals are actually running. Nothing about their names. `settings_snapshot`
reports your interface language, which shipped palette is on (`acrylic-black`
becomes `acrylic_black`; a custom name becomes `other`), whether thread
worktrees, auto-close, the orchestrator and voice are on, the motion setting,
and whether MCP tools skip confirmation. Both are sent in enhanced mode only:
the app drops them before upload in anonymous mode. Several low-entropy
settings together are a weak fingerprint, and the anonymous tier exists
precisely so that two events cannot be tied to one installation across days.

`first_run` means "first launch that knew how to report one", so for an
installation that predates the release introducing it, it fires on the first
launch after the update rather than on the day it was installed.

This table is checked against the code on every release. Where this page and the
code disagree, the code is right and the page is a bug worth reporting.

## What the payload actually looks like

This is a real batch, exactly as it leaves the machine in anonymous mode:

```json
{
  "mode": "A",
  "anonymous_id": "b3f1c2d4-5a6b-4c7d-8e9f-0a1b2c3d4e5f",
  "events": [
    {
      "name": "ping",
      "app_version": "1.3.0",
      "os": "windows",
      "arch": "x86_64",
      "os_version": "Windows 11 22631",
      "surface": "desktop",
      "client_ts": "2026-08-04T12:34:56Z",
      "locale": "fr-FR"
    },
    {
      "name": "thread_spawned",
      "app_version": "1.3.0",
      "os": "windows",
      "arch": "x86_64",
      "os_version": "Windows 11 22631",
      "surface": "desktop",
      "client_ts": "2026-08-04T12:36:02Z",
      "locale": "fr-FR",
      "kind": "agent",
      "provider": "claude"
    }
  ]
}
```

That is the whole thing.

Batches are sent at most once every five minutes, the first one about twenty
seconds after launch, and are held in memory only: telemetry is never written
to your disk, so an app that never reaches the network simply forgets its
events. A batch that fails to send is kept in memory and retried, with the
delay doubling up to an hour; at most 200 events are held that way, and the
oldest are discarded past that. `ping` reports how many were lost, which is the
only reason that count exists.

A build with no `BOITE_TELEMETRY_URL` (dev, `bun run dev:isolated`, a tag
signed without the secret) points at `https://telemetry.invalid`. Nothing
leaves.

## The two switches

One aggregate counter records which answer the first-launch screen got, so I
know how many people accept the enhanced tier. It carries no identifier.

### Anonymous counters

Events are sent, and they are deliberately made hard to link together.

A random UUID is generated on your machine. The server never stores it: it
stores a keyed hash of it, used only to avoid counting the same installation
twice in the daily active count. Every other event is attributed to a different
hash that changes every night, derived from your IP address and User-Agent. Two
threads you spawn on Monday and Tuesday cannot be tied to the same installation.

No user profile is created on the analytics side. This mode exists so the
project can answer "how many people use this, on what OS, in what country" and
nothing more.

### Enhanced

A second random UUID, the install id, is generated and attached to every event.
It stays the same over time, which is exactly the point: it makes it possible to
see whether people come back after a week, which pane kinds get used together,
and how large a real workspace is.

This is the mode where a profile does exist on the analytics side. It is a
separate opt-in for that reason, and it is the only mode where export and
deletion are possible, because they need an identifier to act on.

Turning enhanced on turns the anonymous counters on with it. Turning the
anonymous counters off opts you out of enhanced as well, and asks the server to
forget the install id.

## Where the data goes

1. Your machine sends the batch to a Cloudflare Worker, which is open source and
   lives in [`telemetry/`](../telemetry) in this repository.
2. The Worker derives the country code from your IP address, computes the
   anonymous-mode hashes, and discards the address. It stores nothing itself:
   it has no database.
3. It forwards the events to PostHog, in their EU region, hosted in Germany.
   Every forwarded event explicitly overrides the IP field and disables location
   lookup, so PostHog stores no address and infers no location beyond the
   country code computed in step 2.

Three companies are involved: Cloudflare processes the traffic in transit,
PostHog Inc. stores the events in the EU, and Resend delivers operational alert
emails to the maintainer. Resend never receives event data.

## Retention

Events older than 12 months are deleted.

## Your controls

Everything below is in Settings, Privacy.

- Change your mind. Both switches can be flipped at any time, in either
  direction. Turning everything off stops all sending immediately.
- Export your data (enhanced mode). Copies everything held against your
  install id to the clipboard as JSON. Anonymous-mode events cannot be exported
  because there is no identifier to look them up by, which is the point of that
  mode.
- Delete your data (enhanced mode). Turning enhanced mode off asks the server
  to delete everything tied to your install id, and the app keeps retrying until
  the server confirms. Your profile and its properties are removed immediately;
  the events themselves are queued for a batch deletion job that the analytics
  provider runs during off-peak hours, so allow up to a week for that part.

The enhanced tier runs on your explicit consent, GDPR article 6(1)(a). Export is
article 20, deletion is article 17. Withdrawing is one click and never degrades
the app.

## Verify all of this yourself

Nothing here has to be taken on trust. The code that decides what is sent is
small and self-contained:

| What                                        | Where                                                                                                     |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| The event list and every field              | [`crates/boite-core/src/telemetry/events.rs`](../crates/boite-core/src/telemetry/events.rs)               |
| The fixed vocabularies codes are matched to | [`crates/boite-core/src/telemetry/events.rs`](../crates/boite-core/src/telemetry/events.rs)               |
| The exact payload built for the network     | [`crates/boite-core/src/telemetry/client.rs`](../crates/boite-core/src/telemetry/client.rs)               |
| The queue, and why it never touches disk    | [`crates/boite-core/src/telemetry/queue.rs`](../crates/boite-core/src/telemetry/queue.rs)                 |
| The consent gate and the sidecar            | [`crates/boite-core/src/telemetry/runtime.rs`](../crates/boite-core/src/telemetry/runtime.rs), [`sidecar.rs`](../crates/boite-core/src/telemetry/sidecar.rs) |
| What the OS fields are read from            | [`crates/boite-core/src/telemetry/platform_info.rs`](../crates/boite-core/src/telemetry/platform_info.rs) |
| The bus methods, local-only                 | [`crates/boite-core/src/command/telemetry.rs`](../crates/boite-core/src/command/telemetry.rs)             |
| The server, in full                         | [`telemetry/src/index.ts`](../telemetry/src/index.ts)                                                     |
| The server's own README                     | [`telemetry/README.md`](../telemetry/README.md)                                                           |

This page is versioned alongside the code it describes, so `git log` on it shows
every change ever made to what gets collected.
