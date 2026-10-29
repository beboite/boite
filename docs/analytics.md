# Analytics

Boite can report usage counts through a Cloudflare Worker to PostHog EU.
Basic counters are enabled on new hosts. Enhanced analytics start disabled and
are offered in the onboarding tour. Skipping the tour leaves enhanced mode
disabled. The host preserves any saved choice, including Off.
The tour's privacy step has three answers: the "NO! Just the basic counters"
row keeps the counters, the "DEAL" row turns on enhanced mode, and the "turn
usage analytics off" link under both rows saves Off. Each one closes the tour.
Settings > General > Privacy and analytics has two switches. On a phone connected
as the owner, they are under This phone > Privacy.
Paired guest devices and agents cannot read or change these settings.

The host stores consent. Opening another desktop or phone does not create a
second installation or duplicate conversation events.

## Modes

- Off: no usage events are queued or sent. Previously requested deletion can
  still contact the relay until it succeeds. An explicitly selected choice can
  send the anonymous receipt described below, including a refusal.
- Anonymous counters: a local random UUID is hashed by the relay for daily
  installation pings. Other events use a daily HMAC of the source IP and
  User-Agent. No PostHog person profile is created. The ping identifier remains
  stable so the dashboard can count installations over a month.
- Enhanced: a separate random UUID identifies events over time, allowing
  retention analysis. Enabling it also enables counters. Disabling it discards
  queued events and requests deletion of the corresponding profile and events.
  Failed deletions remain on disk and retry after restart. Re-enabling enhanced
  mode immediately creates a new identifier without cancelling earlier deletion
  requests.
  Pending deletions block usage uploads until accepted; consent switches and onboarding
  navigation remain available. Settings contains export and deletion status;
  the onboarding tour does not.

Export downloads up to 10,000 enhanced events as JSON. PostHog processes event
deletion asynchronously after accepting the request. A batch already received
by the relay can still finish during withdrawal; deletion is not instantaneous.

## Anonymous choice counts

The tour and privacy settings disclose that Basic, Enhanced and Off choices are
counted anonymously, including refusals. Only an explicit selection from a UI
showing this notice sets `countChoice: true` on `telemetry.configure`. Starting
the host, loading saved preferences, skipping the tour and older clients do not
report a choice. A fresh host's default Basic mode is not a response.
Keeping a saved Off mode when replaying the tour's Basic row reports no new
refusal. Builds without a configured relay never create a choice receipt.

The host sends `POST /consent` with only the selected mode and a random receipt
UUID. The relay emits `consent_choice` with `choice` and `receipt_id`, a constant
`anonymous-consent` identity and person profiles disabled. No installation ID,
usage event, version, OS, country, IP or User-Agent identity accompanies it in
PostHog. The source IP is processed only for request rate limits.

The receipt persists in `telemetry.json` until acknowledged and keeps the same
UUID on retry or restart. Re-selecting the last recorded mode creates no new
receipt; a later changed mode does. Changing a choice before upload replaces
the unsent receipt. Deletion failures do not block this independent anonymous
count. Off sends no usage events after its choice is counted.

The dashboard counts distinct receipt IDs for Base, Plus and Refus. These are
choices, not unique people or current installation preferences: a changed mode
can add another choice. Earlier refusals cannot be reconstructed. A separate
Base/Plus chart counts observed active installations over 30 days; a mode change
can place an installation in both groups.

## Events and properties

| Event | Trigger | Additional properties |
|---|---|---|
| `first_run` | First activation on this host | None |
| `ping` | First active queue cycle of a UTC day | None |
| `app_launched` | Host startup or enabling a mode | `duration_ms` |
| `session_ended` | Orderly host shutdown | `duration_ms` |
| `project_added` | A project is added | None |
| `thread_spawned` | A conversation is created | `provider` |
| `turn_finished` | A turn finishes, fails or stops | `provider`, `outcome`, `duration_ms` |
| `subagent_started` | A delegated child turn starts, enhanced mode only | `provider`, selected public `model`, `effort`, `speed` |

Every usage event has a random event UUID, timestamp, app version, OS, OS version and
architecture. The relay adds country and collection mode.

`os_version` names the host's release from fixed system fields, read once at
startup: on Windows the product name and build (`Windows 11 Pro 26200`; the
registry keeps "Windows 10" on Windows 11, so a build from 22000 is renamed),
on macOS `ProductVersion` from `SystemVersion.plist` (`macOS 15.1`), on Linux
`ID` and `VERSION_ID` from `os-release` (`ubuntu 24.04`, `arch` for a rolling
release). `PRETTY_NAME` is not used because a distribution writes it freely.
A server image reports the distribution of its container, not of the machine
under it. The relay keeps a value of at most 48 characters starting with a
letter and made of letters, digits, spaces and `._+()-`, otherwise `other`;
events from hosts older than the field carry no `os_version` at all. Providers and outcomes come from
closed lists; unknown values become `other`. Both the host and relay construct
new payloads from approved fields.

Enhanced `turn_finished` events also carry the selected public `model`, `effort`,
`speed`, `permission_mode`, `operation`, scheduler `queue_ms`, and reported
`input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens` rounded
to 100 tokens and capped at ten million. Missing usage stays absent.
These values come from the frozen execution snapshot, regardless of later model
changes.
`default` means the provider chose its model; it does not claim a resolved model.
`packages/contracts/src/telemetry.ts` matches public model families (Claude,
GPT and o-series, Gemini, Grok, DeepSeek, GLM, Kimi) with closed patterns, so a
new release of a known family needs no Boite update. Only the segment after the
last `/` is checked: `codex/gpt-6.1-sol` reports `gpt-6.1-sol` and the prefix is
dropped.
An effort suffix in the ID (`gemini-3.8-flash-high`, `claude-opus-4-6-thinking`,
as Antigravity names its models) is removed before matching. Unknown models, custom aliases, paths and fine-tuned IDs become `other`
on both the host and relay. Both normalize, so a family added to the patterns
counts only after a host release and a relay deployment. Deploy the relay in
the same change: until 2026-10-15 it still ran the 2026-09-21 build, which
filed every enhanced model and the `yolo` permission mode under `other`, even
from hosts that reported them correctly. Events already stored keep `other`.
Basic mode strips every enhanced field even from modified clients.

`subagent_started` counts Boite delegated agents and workflow steps when their
turn actually starts. Follow-up calls, resumes and workflow retries count again;
queued work cancelled before starting, compactions and cache keepalives do not.
The model and effort come from the frozen execution snapshot, including inherited
defaults. The host sends no such event in basic or off mode, and the relay drops
it from basic batches. Native subagents launched inside a provider are not counted.
No task, parent ID, thread ID or profile name is sent. Existing events cannot
reconstruct these calls, so the ranking starts with hosts carrying this change.

These fields measure model adoption, retention among consenting installations,
turn success/stop rates, queue delay, duration and token volume. They do not
measure answer quality or subscriber spending. Enhanced data represents only
installations whose owners opted in.

No prompt, response, reasoning, tool argument, file content, project name, path,
account identifier, private model name, error message, screenshot or recording is sent.
The relay overwrites the IP field and disables GeoIP enrichment. The PostHog
project also discards IP data. Cloudflare processes the source IP in transit for
country lookup, daily hashing and rate limits; it is not forwarded to PostHog.

The in-memory queue holds at most 200 events. Upload starts after 20 seconds and
normally runs every five minutes. Failed batches retry with exponential backoff,
up to an hour, keeping event UUIDs for deduplication. Old events can be lost when
the queue fills or the host exits. `telemetry.json` stores only consent,
identifiers, pending deletion and the last choice receipt, outside the application journal.

## Repairing consent state

An unreadable or invalid `telemetry.json` stops host startup. The host preserves
the file because its `forget` array may contain pending deletion requests and
its `installId` may identify an enhanced profile still to delete. It does not
replace the file with defaults.

With the host stopped, keep a copy of the damaged file. Check its read permissions
and JSON syntax first. Restore a valid backup only if it retains every pending
deletion ID and the current installation ID. Do not delete the file or clear
these fields to bypass the error. If repairing individual fields, preserve valid
UUIDs in `anonymousId`, `forget` and `installId`; ask the project maintainer for
help if their values cannot be recovered. Replacing `anonymousId` starts a new
anonymous-mode installation count. Never publish the consent file in an issue.

Once the file loads, turning enhanced analytics off moves its installation ID
into the deletion queue. Use "Retry deletion" in settings and wait for the
pending-deletion warning to disappear. Relay URL configuration errors are
separate and require correcting `BOITE_TELEMETRY_URL`, not this file.

## Relay and dashboard

The dedicated relay is configured in `telemetry/wrangler.toml`. Only published
builds default to it: the Windows installer of a nightly or stable release and
the published server image. Their CI sets `BOITE_RELEASE_TELEMETRY=1` and every
core build passes `--env=BOITE_RELEASE_*` to inline the flag. Source runs, local
`build:shell` or `build:shell:dev` builds, pull request installers and tests have
no relay, so a scratch data directory never counts as an installation. Settings
then reports that nothing is sent.

Set `BOITE_TELEMETRY_URL` at runtime to override either default, or to an empty
string to disable networking. Only HTTPS is accepted, except loopback HTTP for
tests. No analytics SDK loads in the UI or core.

The PostHog project is `boite`, separate from `boite-legacy`. Its dashboard
follows the legacy layout with active installations, launches, countries,
versions, OS, architecture, conversations by provider, enhanced retention,
turn outcomes and median turn duration. Host architecture replaces the legacy
desktop/mobile chart because execution is measured on the host.

The enhanced section ranks subagent calls by model and effort together, alongside
the model totals. A shared note and info buttons explain consent, collection dates
and normalization; individual charts hide repeated descriptions. Overview counters
come first, then installation breakdowns, providers, model adoption and subagent
calls, followed by runtime, usage and outcome charts. Phone tiles follow the same
order in one column.

## Verification

```sh
bun test packages/core/test/telemetry.test.ts
bun test tests/e2e/telemetry.test.ts
bun run check
```

These checks use fresh temporary consent files, substituted network responses,
and the in-memory UI. No provider login or production analytics is used.
