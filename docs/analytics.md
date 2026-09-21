# Analytics

Boite can report usage counts through a Cloudflare Worker to PostHog EU.
Basic counters start on for new hosts. Enhanced analytics start off and are
offered explicitly in the onboarding tour. Skipping the tour does not enable
enhanced mode. An existing saved choice, including Off, is never overwritten.
Settings > General > Privacy and analytics has two
switches. On a phone connected as the owner, they are under App & notifications.
Paired guest devices and agents cannot read or change these settings.

Consent belongs to the host, so opening another desktop or phone does not
create another installation or duplicate a conversation event.

## Modes

- Off: no usage events are queued or sent. Previously requested deletion can
  still contact the relay until it succeeds.
- Anonymous counters: a local random UUID is hashed by the relay for daily
  installation pings. Other events use a daily HMAC of the source IP and
  User-Agent. No PostHog person profile is created. The ping identifier remains
  stable so the dashboard can count installations over a month.
- Enhanced: a separate random UUID identifies events over time, allowing
  retention analysis. Enabling it also enables counters. Disabling it discards
  queued events and requests deletion of the corresponding profile and events.
  Failed deletion remains on disk and retries after restart. Re-enabling enhanced
  mode requires pending deletion to finish and creates a new identifier.

Export downloads up to 10,000 enhanced events as JSON. PostHog processes event
deletion asynchronously after accepting the request. A batch already received
by the relay can still finish during withdrawal; deletion is not instantaneous.

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

Every event has a random event UUID, timestamp, app version, OS and architecture.
The relay adds country and collection mode. Providers and outcomes come from
closed lists; unknown values become `other`. Both the host and relay construct
new payloads from approved fields.

Enhanced `turn_finished` events also carry the selected public `model`, `effort`,
`speed`, `permission_mode`, `operation`, scheduler `queue_ms`, and reported
`input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens` rounded
to 100 tokens and capped at ten million. Missing usage stays absent.
The frozen execution snapshot supplies these values, not a later model choice.
`default` means the provider chose its model; it does not claim a resolved model.
`packages/contracts/src/telemetry.ts` lists public models explicitly. Unknown models, custom
aliases, paths and fine-tuned IDs become `other` on both the host and relay.
Basic mode strips every enhanced field even from modified clients.

These fields support model adoption, retention among consenting installations,
turn success/stop rates, queue delay, duration and token-volume comparisons.
They do not measure answer quality, subscriber spending or all users: enhanced
data comes only from installations whose owners opted in.

No prompt, response, reasoning, tool argument, file content, project name, path,
account identifier, private model name, error message, screenshot or recording is sent.
The relay overwrites the IP field and disables GeoIP enrichment. The PostHog
project also discards IP data. Cloudflare processes the source IP in transit for
country lookup, daily hashing and rate limits; it is not forwarded to PostHog.

The queue holds at most 200 events in memory. Upload starts after 20 seconds and
normally runs every five minutes. Failed batches retry with exponential backoff,
up to an hour, preserving event UUIDs for deduplication. Old events can be lost
when the queue fills or the host exits. Only consent, identifiers and pending
deletion are persisted in `telemetry.json`, outside the application journal.

## Repairing consent state

An unreadable or invalid `telemetry.json` stops host startup. The host does not
replace it with defaults: its `forget` array may contain outstanding deletion
requests, and its `installId` may identify an enhanced profile still to delete.

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

The dedicated relay is configured in `telemetry/wrangler.toml`. Set
`BOITE_TELEMETRY_URL` to override it, or to an empty string to disable networking.
Only HTTPS is accepted, except loopback HTTP for tests. No analytics SDK loads
in the UI or core.

The PostHog project is `boite`, separate from `boite-legacy`. Its dashboard
follows the legacy layout with active installations, launches, countries,
versions, OS, architecture, conversations by provider, enhanced retention,
turn outcomes and mean turn duration. Host architecture replaces the legacy
desktop/mobile chart because execution is measured on the host.

## Verification

```sh
bun test packages/core/test/telemetry.test.ts
bun test tests/e2e/telemetry.test.ts
bun run check
```

These checks use fresh temporary consent files, substituted network responses,
and the in-memory UI. No provider login or production analytics is used.
