# Telemetry relay

This Cloudflare Worker forwards validated host events to PostHog EU. It is
adapted from Boite Legacy's MIT-licensed telemetry relay. The event vocabulary
and property builder are restricted to this Boite version. No database or
payload logging is enabled.

`POST /track` accepts batches of up to 200 events and 64 KiB. `POST /export`
and `POST /forget` use a random enhanced installation identifier. Rate limits
cover each source IP and the shared ingestion budget. Cloudflare enforces these
per location, not as a monthly billing ceiling.

`POST /consent` accepts only a choice (`basic`, `enhanced` or `off`) and a random
receipt UUID. It records an anonymous `consent_choice` without an installation
ID or a person profile, even for refusals. Distinct `receipt_id` counts prevent
retried requests from inflating the dashboard. Existing preferences are never
reported automatically; the UI must disclose this count before a selection.

## Deployment

```sh
bunx wrangler deploy --config telemetry/wrangler.toml
```

Deploy whenever `telemetry/` or `packages/contracts/src/telemetry.ts` changes:
the relay re-normalizes every field, so a stale relay turns values a current
host sends into `other`. `bunx wrangler deployments list --name
boite-v2-telemetry` shows when it last changed.

Provision `HASH_SECRET`, `POSTHOG_PROJECT_API_KEY` and
`POSTHOG_PERSONAL_API_KEY` with Wrangler secret storage. The personal key needs
`person:read`, `person:write` and `query:read`, restricted to the configured
project. Never put these keys in the app or repository. Forks must set their own
Worker name, project ID, unique rate-limit namespace IDs and secrets.

The relay has separate resources from Boite Legacy. Renaming a PostHog project
does not change its numeric ID or ingestion key, so existing Legacy releases
continue sending to the original project.

See [analytics](../docs/analytics.md) for consent, fields and limitations.
