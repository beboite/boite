# Usage

Settings > Usage shows what the agents spent through Boite: tokens, the API
equivalent cost and turns, per day, provider, model and thread. Settings >
Limits is its own tab beside it, holding the subscription windows each provider
last reported. Everything on the usage page comes from turns the core already
recorded in its journal. Boite never estimates a token count or prices a turn
itself.

## The page

- The range is 7, 30 or 90 days, ending today. The measure is tokens, API cost
  or turns, and every card follows it. The provider filter also applies to the
  chart, breakdown and thread ranking, using each turn's execution provider.
- The overview gives the total for the range and one row per provider with its
  share, including providers with no turns and historical providers no longer
  configured. Each row and the total show how many turns reported tokens and
  costs. Missing reports stay unknown; partial totals include only known data.
- Per day is a column chart stacked by provider, one column per local calendar
  day. Hovering or tapping a column opens every provider's value for that day.
  The chart also takes the keyboard focus: the arrow keys, Home and End move
  between days and a screen reader reads the same values.
- Breakdown lists each model with its turns, tokens, input, output, cache and
  cost. By day is the same table with one row per day that had a turn, which
  doubles as the chart's table view.
- Top threads are the ten threads that spent the most by the chosen measure.
  A thread still in the sidebar opens on click; an archived one is marked.

## The limits tab

- The windows come from `quotas.list`, the same source as the tray popup, and
  an account whose provider reports no limit, or whose monitoring is off, is
  named once under "Not monitored".
- The tab reads the quotas itself and follows `quotas.updated`, so opening it
  costs one call and no history. It reads once the connection is ready and
  again after a reconnect. Its own refresh button asks the providers again. A
  failed `quotas.list` shows its reason with a retry button.
- A switch in "Tracked accounts" changes that account alone: `quotas.configure`
  answers and broadcasts every other account's reading unchanged, and the tab
  reads again whether the switch went on or off.
- Providers refresh independently, with up to two accounts per provider in
  flight. Each `quotas.progress` event carries the request ID and one account's
  result; the final response retains the account order. Both events and calls
  remain owner-only.
- In the tray and the limits tab, existing bars lose saturation while their
  account is pending. Each answer updates its bars and restores their colour
  with a transition. A slow provider does not hold up the others. Cache and
  failure backoff still apply to refreshes.
- The core keeps each account's last successful reading apart from that cache.
  A read that fails, even after an account or provider change cleared the
  cache, returns those windows with the error: the tab dims them and labels
  them "Last successful reading" with its time. The reading is dropped only
  when it stops belonging to the account: removed, switched off, signed in
  under another identity, or its saved login switched by a plugin.
- An account with nothing read yet says it is being read while a read runs.
  Antigravity adds that it can take up to two minutes, the time `agy` may take
  to answer `/usage`.

### Gateway quotas

With the Douane [subscription proxy](providers.md#subscription-proxy) enabled,
the core reads `GET <api>/v1/quotas` itself. The request sends the proxy key as
a Bearer token, refuses redirects and gives up after 15 seconds. A body over
1 MiB is refused, whatever its `Content-Length` claimed. The body is checked
field by field: strings are bounded and stripped of control characters, and a
row that breaks the contract is dropped. An error names the HTTP status or the
failure. It never quotes the body, which can echo a credential.
`packages/core/src/subscription-proxy-quotas.ts` holds the reader.

- Each entry becomes a `quotas.list` row with the id `proxy:<provider>:<entry>`
  and a `gateway` field: the plan, the entry's status (ready, cooldown, error
  or disabled), the credits, the display mode and its account count. The tray
  popup, the sidebar glance and the quota order therefore show them like any
  account. While Douane is enabled, the list holds only its entries: the
  machine's own logins, whatever their provider, are neither listed nor read.
  The gateway also reports a provider under its own id (`opencode_go`, `xai`),
  which draws that provider's mark.
  `quotas.configure` refuses a `proxy:` id, because the gateway decides what it
  reports.
- The cadence is the native one. A list within a minute of the last read
  reuses it, and the refresh button reads again. `subscriptionProxy.quotas`
  returns the gateway's state (`ready`, `unavailable`, `unsupported` or `off`)
  and `subscriptionProxy.quotasUpdated` follows it. Both are owner-only, like
  `quotas.list`. A phone with full control gets the rows from its core and
  never reaches the gateway.
- Limits shows one heading per provider the gateway reports, then one card per
  entry. Each card has its window bars, reset times, plan, status and credits.
  An `average` entry is named by its provider and account count, such as
  "Antigravity · 10 accounts". Open dashboard opens the gateway's page in the
  system browser.
- A failed read keeps the last good entries, dimmed, under one card naming the
  error. A 404 means an older Douane: the state turns `unsupported` and Limits
  falls back to the embedded dashboard, as it does for CLIProxyAPI. Changing
  the proxy configuration drops the previous gateway's entries.

## Quota sources and freshness

Settings > Limits and the tray show monitored, signed-in accounts. Providers
contains setup and account controls without usage. With no signed-in account,
Limits and the tray offer connection. Monitoring switches are under Tracked
accounts in Limits; the tray has no switch. [Accounts](accounts.md) owns login
and isolation.

Each monitored, signed-in account has its own row or card, with its label and
provider logo, including accounts labelled `Default`. Rename under Tracked
accounts changes the label, including default CLI accounts. Save commits it;
Cancel or Escape keeps the previous name. Open
quota views update the label immediately while retaining their cached windows.

| Source | Read behavior and limits |
| --- | --- |
| Claude | OAuth usage endpoint for file logins; Keychain or expired-token fallback asks the CLI for usage with `skipBehaviors: true`, no prompt queue, tools or hooks. Fallback can omit resets and paid usage. |
| Codex | `account/rateLimits/read`, without opening a conversation |
| Muse Code | Last `usage/changed` observation from an existing host supporting that event; no host or prompt starts to refresh limits |
| Grok | Credit percentage or legacy credit amounts from the selected CLI login's billing endpoint |
| OpenCode Go | Rolling, weekly and monthly limits from its Go usage API, using its own saved API login or the default account's `OPENCODE_API_KEY` |
| Antigravity CLI | Opt-in `agy -p /usage --output-format json` in a temporary directory, with version, output and timeout checks; no model prompt |

Quota readers live in `packages/core/src/quotas.ts` and `quota-readers.ts`, with
Claude's fallback under `drivers/claude/quota.ts`. Successful snapshots cache for
one minute; manual refreshes are at least ten seconds apart and failures back
off for five minutes. A failed read returns the last successful windows as stale
with its error and timestamp. Unknown percentages remain unavailable. Failed
reads never advertise old resets or credits as available. Unsupported providers
report unsupported limits rather than using local token totals as quota.

Muse observations stay in memory per account with their original observation
time, including over-quota readings. Before the first observation, after
monitoring is disabled or with an older host, the source is unavailable. Its
schema supplies no paid credit balance or banked resets.

### Resets and paid allowances

Claude reads banked reset grants through `cedar_ember=1` with the installed CLI
version in its user agent. Unknown versions or an ineligible response supply no
usable resets. Counts include eligible, usable, unpaused, unexpired grants and
show the earliest expiration. Codex retains a reported reset-credit count even
without optional grant details. Only counts and expiration times reach the client.

On Limits, an owner can use a banked Claude or Codex reset after confirmation
names the account and the irreversible consumption of the available reset
closest to expiration. Cancel is focused; Cancel, Escape and outside clicks
send nothing. The action is disabled while pending. Paired devices and agents
cannot call `quotas.reset`.

The core uses the selected account's isolated login and chooses the earliest
usable grant or credit. Codex refuses consumption when credit details are
missing or partial. Concurrent requests for one login share an attempt;
uncertain requests retain their idempotency key and selected credit across
restart. Limits refresh after a provider outcome. An applied reset followed by
a failed refresh is reported and leaves a stale reading. Paid-usage settings
are unaffected.

Once a subscription window is exhausted, Claude's confirmed enabled, positive
monthly spending budget appears as a percentage of its cap. Codex's positive
reported balance stays visible even before exhaustion; it does not establish
that automatic paid usage is enabled. Missing, disabled and zero allowances
remain hidden.

Grok renews an expired login when its file contains the required refresh fields,
saving the result in the same file and preserving other logins. Concurrent
renewals share a request. A billing 401 permits one renewal and retry; 403
retains the access error. Rejected refresh requires `grok login --device-auth`.
A dated credit period with an omitted proto3 percentage means zero usage;
a missing report or malformed percentage stays unavailable. Account failures
remain visible beneath their provider.

Antigravity's source belongs to the CLI login on the core machine, independently
of isolated ACP accounts. It requires agy 1.1.11 or later and an existing sign-in.
Its monitoring preference persists; disabling it launches no CLI process.
The shipped quota adapters and their fixtures define accepted response shapes.
External format references are
[CodexBar's source notes](https://github.com/steipete/CodexBar/tree/main/docs) and
[Grok's billing
schema](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-shell/src/extensions/billing.rs).

### Tray window

The tray and sidebar share a compact popup. Each account row shows its windows
side by side, with a reset icon, full weekday and local time. Expanding shows
each window's allowance and reset time. Exhausted accounts put credits or their
monthly budget first; "Using credits" requires confirmed paid-usage activation.
The browser retains the last reading while refreshing, including after restart.

Drag a row's handle to reorder subscriptions, including on touch screens.
Arrow keys, Home and End work from the focused handle; long lists scroll near
an edge. The core saves and broadcasts the order per machine to the app and
tray. New subscriptions follow ordered ones. The Limits monitoring list keeps
its account order.

The popup opens after 100 ms of continuous hover; leaving cancels and clicking
does not bypass the delay. On Windows it fits the monitor's work area and
reserves an auto-hidden taskbar's full height. Pointer sampling every 150 ms
closes it after two readings outside the icon, popup and connecting gap;
tray moves can restart hover without a leave event. Windows 11 draws rounded
corners and a border; Windows 10 keeps the opaque popup square.

Usage provider colours come from `--series-1` to `--series-8` in `app.css`, with a
light and a dark set. The order is fixed (Claude, Codex, OpenCode, Grok,
Antigravity, pi, Antigravity CLI, Muse Code), so shipped providers keep their
colour whatever the range shows. Custom providers have individual rows and
series, reusing the last two palette colours as needed.

## `usage.history`

The UI sends the day boundaries and the core sums the finished turns between
them in SQLite:

```ts
'usage.history': { params: { edges: Timestamp[]; providerId?: ProviderId }; result: UsageHistory };
```

- `edges` are 2 to 367 strictly ascending timestamps in milliseconds. The UI
  sends the client's local midnights, so a day is the user's day whatever time
  zone the core runs in, and a daylight saving change gives a 23 or 25 hour day
  rather than a shifted one. Anything else is refused with `InvalidParams` on
  the `edges` field.
- Bucket `i` holds every turn with `edges[i] <= finishedAt < edges[i + 1]`. A
  turn finishing exactly on an edge belongs to the later day. Running and
  queued turns have no `finishedAt` and are not counted; errored, stopped and
  compaction turns are.
- `rows` has one entry per bucket, provider and model that had a turn. The
  provider and model are the ones the turn ran on (`turns.execution`), so a
  thread that switched models mid-conversation splits correctly. A turn recorded
  before schema 9 has no execution and falls back to its thread's provider and
  model.
- `turns` counts every turn, `reported` the turns that carried a usage report,
  and `priced` the turns whose report had a cost. A turn without usage adds a
  turn and no tokens. `usage.costUsdEquivalent` is null when no turn of the row
  was priced, so "no price" and "$0.00" stay different.
- `threads` is the union of the top ten threads by tokens, by cost and by
  turns, unordered. The UI ranks them by the chosen measure.
- An optional non-empty `providerId` filters execution providers before the
  thread ranking, including turns in conversations that later switched
  providers. Recorded turns remain available even after their provider is
  removed or no longer configured. History is empty only when no recorded turns
  match the requested provider and range.
  Legacy turns with no provider identity remain in the all-provider totals as
  "Unknown provider"; they have no individual filter option.
  If an older core returns rows or conversations from other providers for a
  filtered request, the page reports the unsupported filter and asks for an
  update instead of showing those totals as filtered usage.

The query reads the `turns_by_finished` index on `turns (finished_at)`, created
on open when the journal lacks it. `EXPLAIN QUERY PLAN` shows
`SEARCH t USING INDEX turns_by_finished (finished_at>? AND finished_at<?)`.

### What each field means across providers

Codex's app-server reports cached input inside `inputTokens`; Claude, the ACP
agents and pi report it apart. `usage.history` subtracts `cacheReadTokens` from
Codex's input, so for every provider `inputTokens` is uncached input and the
four token fields add up to the total the page shows. `usage.get` still
returns the raw reports.

The cost is the provider's own figure: the Claude SDK's `total_cost_usd`, an
ACP `usage_update` priced in USD, or pi's reported cost. Codex never reports
one, and an ACP agent that sends no USD cost has none either. The API cost
measure names those providers under the chart instead of counting them as free.
Claude's `total_cost_usd` is a running total: it grows across the turns of a
warm process, and a process that resumes a session restores it. The driver
charges each turn the difference, reading the earlier turns of the session from
the journal, and takes the total as it stands when the CLI started from zero.
The ACP `usage_update` cost is the session's running total in the same way,
and each turn is charged what it added. The driver measures from the last
total the same process reported, in an earlier turn, between turns or while a
`session/load` replayed the history; a session the process created starts at
zero. A process that loaded the session and has reported nothing yet starts
from the session's earlier turns in the journal, because the protocol defines
the cost as the session's and OpenCode sums it from the session's stored
messages. When such a first total comes in below that sum, the turn is charged
the total, and the driver takes that agent to count every process from zero:
its later cold turns are charged their whole total until the core restarts or
the provider is reloaded. A `usage_update` with no token counts still records
its cost.
On a subscription the figure is what the same tokens would cost on the API, not
money spent.

## Paired devices

A phone may call `usage.history`: it returns sums over the same finished turns
a device can already open, and the thread titles it names are the ones
`threads.list` shows it. The reason sits beside the entry in
`packages/core/src/access.ts`. `quotas.list` stays owner-only, so on a device
the Limits tab says the limits are read on the computer that runs Boite. On a
phone both pages are under Settings > Machines, as Usage and Limits.

## The fake client

`?fake=1` draws a believable ledger from `packages/ui/src/lib/fake-usage.ts`:
eight providers with their own models, rhythm and prices (none for Codex, Grok,
Antigravity, Antigravity CLI and Muse Code), a few turns without usage, and threads that match the fake
sidebar. Each day's numbers come from a generator seeded with the calendar date,
so a reload shows the same history. Turns finished in the fake session are
added on top, and the uninstalled mode (`?fake=1&uninstalled=1`) starts empty.

## Tests

- `packages/core/test/usage-history.test.ts`: edge boundaries, the provider and
  model split, turns without usage, the Codex cache subtraction, legacy turns,
  the top threads union, provider filtering, refused parameters and one real echo turn.
- `packages/ui/src/lib/usage.test.ts`: day edges, axis steps, the fixed colour
  order, unused and custom providers, reporting coverage, provider-scoped model
  names, the summaries and the fake ledger.
- `packages/ui/src/components/UsagePage.test.ts`: read failures and retry,
  stale responses after range or machine changes, legacy provider identities,
  and older cores that ignore the provider filter.
- `tests/e2e/usage.test.ts`: the page at 1280x800 and 390x844 in both themes,
  the tooltip staying inside the chart, keyboard reading, the three ranges, the
  phone entry, the limits tab on both widths and the device's Limits note.
  Captures land in `tests/e2e/.artifacts/usage-*.png` and `limits-*.png`.
