# Usage

Settings > Usage shows what the agents spent through Boite: tokens, the API
equivalent cost and turns, per day, provider, model and thread. Settings >
Limits is its own tab beside it, holding the subscription windows each provider
last reported. Everything on the usage page comes from turns the core already
recorded in its journal. Boite never estimates a token count; it prices the
reported tokens at each model's public API rates ([The API
estimate](#the-api-estimate)).

## The page

- The range is 7, 30 or 90 days, ending today. The measure is tokens, API cost
  or turns, and every card follows it. The provider filter also applies to the
  chart, breakdown and thread ranking, using each turn's execution provider.
- With more than one machine connected, the machine menu reads one machine or
  all of them. It opens on the machine the window is on. All machines asks
  each connected core for `usage.history` over the same days and adds the
  answers; a machine not connected or whose read failed is named above the
  page and left out of the totals. Top threads then name their machine, and a
  thread of another machine opens on it.
- The overview gives the total for the range and one row per provider with its
  share, including providers with no turns and historical providers no longer
  configured. Each row and the total show how many turns reported tokens and
  costs. Missing reports stay unknown; partial totals include only known data.
- Per day is a column chart stacked by provider, one column per local calendar
  day. Hovering or tapping a column opens every provider's value for that day.
  The chart also takes the keyboard focus: the arrow keys, Home and End move
  between days and a screen reader reads the same values.
- Breakdown lists each model with its turns, tokens, input, output, cache and
  cost. A model recorded with its provider's prefix, as a delegated thread
  records `claude/claude-opus-5-5`, shares the row of the same model without
  it. The "i" beside a model gives the public rates its tokens were priced at,
  or says the cost is the one its agent reported. By day is the same table
  with one row per day that had a turn, which doubles as the chart's table
  view.
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
  result, and goes only to the connection that sent that request; the final
  response retains the account order. Both events and calls remain owner-only.
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

### Alerts

A bell in the header of each card, a Douane entry's included, folds out the
account's alerts: for 5 hours and for weekly, the shares left that notify,
as the bars count them. 50 %, 25 % and 10 % toggle on and off, several at
once; Custom adds any whole percentage from 0 to 99 as a chip of its own,
which a click removes. Six at most per period. A period shows only when the
account reports a window of it. The bell lights up in the accent colour once
an alert is set, and its tooltip lists them.

- `quotas.alert { accountId, period, thresholds }` saves one period. `period`
  is `fiveHour` or `weekly`, `thresholds` the shares left (`quotaAlertThresholds`
  keeps them distinct, highest first); an empty list turns the period off.
  Anything else is refused with the field and the expected values. It takes a
  Boite account or a `proxy:` entry the list holds now, or one that still has
  alerts, to turn them off; it answers every row like `quotas.configure` and
  broadcasts `quotas.updated`. Each row carries its `alerts`. A paired phone may
  call it: it decides when a reading the phone already sees notifies.
- `quotaAlertPeriod` in the contracts reads the period from a window's id and
  label: Claude's `five_hour` and `seven_day`, Codex's `5 hours` and `Weekly`,
  OpenCode's `rolling`, Antigravity's `Gemini · 5 hours`, Douane's
  `five-hour`, `seven-day` and `window-18000s`. A window scoped to a model or a
  group (`Weekly · Opus`) counts for its period and names its scope in the
  notification. Daily, monthly and credit windows have none.
- `QuotaAlertStore` (`packages/core/src/quota-alerts.ts`) looks at every fresh
  reading: a successful read, a Codex or Muse observation (even one with no
  full read to merge into), each answer of the gateway. A failed read's stale
  windows, a window whose reset time passed, a read that began before the
  window alerted and a read that lands after monitoring went off never alert.
  Another login on the same account starts its windows over. Each threshold
  of a window alerts once when what the window has left falls to it, and
  again only after its reset time passed or it climbed 10 points back above.
  A reading past several thresholds at once sends one alert, for the lowest.
  The thresholds that alerted are kept in the journal, so a restart does not
  repeat them. Choosing a threshold a window has already fallen to marks it as
  alerted: the user is looking at it.
- While any alert is set, the core reads the watched accounts every five
  minutes, with no client open: one HTTP request per account, a short
  app-server for Codex, one gateway request for Douane entries. The cache and
  the failure backoff still apply. An account with no alert is never read for
  it.
- An alert is the `quotas.alerted` event and a Web Push of kind `limits`
  ([phone](phone.md#choosing-which-notifications)): the account in the title,
  `5-hour limit: 8% left` in the body, labelled `limitFiveHour` or
  `limitWeekly` with `values.percent`, which the phone's words fill in its
  language. A desktop shows a toast whatever is on screen; a click opens
  Settings, Limits, on the machine that sent it. A tapped push, or a page's
  notice through the service worker, opens Limits the same way
  (`?limits=1&member=<core id>` with no window open).

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
  and `subscriptionProxy.quotasUpdated` follows it. A paired device reads both,
  without `refresh: true`. A phone gets the rows from its core and never
  reaches the gateway, so it draws the same native bars as the desktop instead
  of embedding the dashboard.
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

Reset times show a weekday for the next seven local calendar dates. More distant
resets and dates before today show a day and month, adding the year when it
differs from the current one. Every limits view keeps the device's preferred clock format.

Each monitored, signed-in account has its own row or card, with its label and
provider logo, including accounts labelled `Default`. Rename under Tracked
accounts changes the label, including default CLI accounts. Save commits it;
Cancel or Escape keeps the previous name. Open
quota views update the label immediately while retaining their cached windows.

| Source | Read behavior and limits |
| --- | --- |
| Claude | OAuth usage endpoint for file logins; Keychain, Credential Manager or expired-token logins fall back to asking the CLI for usage with `skipBehaviors: true`, no prompt queue, tools or hooks. Fallback can omit resets and paid usage. |
| Codex | `account/rateLimits/read`, without opening a conversation; a running session's `account/rateLimits/updated` refreshes it (below) |
| Muse Code | Last `usage/changed` observation from an existing host supporting that event; no host or prompt starts to refresh limits |
| Grok | Credit percentage or legacy credit amounts from the selected CLI login's billing endpoint |
| OpenCode Go | Rolling, weekly and monthly limits from its Go usage API, using its own saved API login or the default account's `OPENCODE_API_KEY`. OpenCode 2 accounts read the key from their own database |
| Antigravity | The managed server's sign-in under `GEMINI_HOME` (`antigravity-acp/acp_token.json`): its refresh token is traded for an access token, held in memory until a minute before it expires, then the Cloud Code `retrieveUserQuotaSummary` buckets (5 hours, weekly, per model group), or per-model `fetchAvailableModels` quotas for an account with no summary. Both endpoints are asked and their buckets merged, a bucket both report keeping the higher use: the daily one has answered with the Claude and GPT group and no Gemini one. Nothing is spawned |

Quota readers live in `packages/core/src/quotas.ts`, `quota-readers.ts` and
`antigravity-quota.ts`, with Claude's fallback under `drivers/claude/quota.ts`. Successful snapshots cache for
one minute; manual refreshes are at least ten seconds apart and failures back
off for five minutes. A change to one account (a rename, a login check, a
removal) clears that account's cache alone; reads of other accounts in flight
still land in theirs. A provider change clears every account. A failed read
returns the last successful windows as stale with its error and timestamp. Unknown percentages remain unavailable. Failed
reads never advertise old resets or credits as available. Unsupported providers
report unsupported limits rather than using local token totals as quota.

Muse observations stay in memory per account with their original observation
time, including over-quota readings. Before the first observation, after
monitoring is disabled or with an older host, the source is unavailable. Its
schema supplies no paid credit balance or banked resets.

A running Codex session merges each sparse `account/rateLimits/updated`
notification into a full `account/rateLimits/read` of that same process, read
again once it is a minute old, and forwards the result to `QuotaStore.observe`
(`drivers/codex/rate-limits.ts`). The store merges it into the last full read
of that account: the windows it carries replace theirs, the others
and the banked resets stay. The merged row stands as a successful read timed at
its observation, so the next list returns it without starting an app-server
until it is a minute old. Updates stand in for a read only within five minutes
of the last full read and are dropped when no full read is held; the next list
then reads again. A reading older than the one held is ignored, and
`quotas.updated` goes out only when the values changed.

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
Antigravity, pi, Muse Code), so shipped providers keep their
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
- `turns` counts every turn and `reported` the turns that carried a usage
  report. `priced` is every reported turn when the row's model has public
  rates, else the turns whose agent reported a cost. A turn without usage adds
  a turn and no tokens. `usage.costUsdEquivalent` is null when no turn of the
  row was priced, so "no price" and "$0.00" stay different. `price` names the
  model and the rates the row was priced at, null when none matched.
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

A turn stores its tokens as four disjoint buckets (`Usage` in
`packages/contracts/src/usage.ts`): `inputTokens` holds neither cache count,
so input, output, cache reads and cache writes add up to what the model
processed. The driver normalises them before the turn is saved. Codex's
app-server counts both cache counts inside its input, and
`drivers/codex/mapping.ts` takes them out once; Claude, the ACP agents and pi
already report them apart, and Muse's counts are stored as it sends them. `cacheWriteHourTokens` says how many of the
writes went to a one-hour cache: the Claude driver reads it from the result's
`cache_creation` split and counts every write as an hour write when the split
is missing, since Claude Code writes for an hour. Pi passes Anthropic's
`cacheWrite1h` through and records it the same way. The core stamps
`buckets: 1` on each turn's usage as it takes it from the driver.

Every reader, `usage.get`, `usage.history`, a session's fallback total,
delegation and workflow totals, sums the turns through one SQL grouping
(`journal/usage-sums.ts` `usageGroups`) and one reading of each group
(`usage.ts`). Marked buckets are summed as they are and never ask the
provider's descriptor, so editing or removing a provider leaves those turns
unchanged.

A turn an older core recorded has no `buckets` and is never rewritten, since
nothing in it says which protocol counted it. Every reader takes it as its
provider's current descriptor says, with the shipped `codex` and `claude` ids
as the fallback: Codex input loses its cache counts and Claude Code writes
become hour writes. A `usage.history` row's `estimated` counts such turns,
because editing or removing the provider changes how they read.

### The API estimate

The cost of a row is its tokens at the public API rates of the model its turns
ran on. `packages/core/src/pricing/rates.json` lists those rates in USD per
million tokens for the text models Anthropic, OpenAI, Google, xAI, DeepSeek,
Moonshot, Z.ai, MiniMax, Mistral, Alibaba and Meta released since 2025, with
the date it was generated. Each model is four numbers (input, output, cache
read, cache write) because the table ships in the core bundle, whose size CI
checks ([bundle growth](ci.md#bundle-growth)). `bun scripts/model-rates.ts` regenerates it from
[models.dev](https://models.dev), the catalogue OpenCode prices with; a path
argument reads a saved copy instead. `packages/core/src/pricing/index.ts`
matches a model and computes the cost.

- A model id matches without its route or variant: a provider prefix
  (`claude/`, `codex/`, `anthropic/`), Bedrock's `anthropic.`, Vertex's
  `@date`, a `[1m]` context tag, an effort suffix (`-high`, `-xhigh`, `-max`)
  and a release date. A Codex build (`gpt-5.1-codex`, `gpt-5.1-codex-max`) is
  priced as its model; a smaller one (`gpt-5.1-codex-mini`) is not.
- Claude Code writes its prompt cache for an hour, and its transcripts show
  nearly every write at that lifetime. Anthropic bills it at twice the input
  rate, where the list gives the five-minute rate, so a turn's
  `cacheWriteHourTokens` cost twice the input rate and its other writes the
  listed rate. A row's `price` shows the write rate most of its writes paid.
  Pi records the hour writes Anthropic reports to it; OpenCode records none
  and keeps the listed rate.
- A rate the list leaves out is the input rate, which is what a provider
  without a cache discount bills.
- Rates are the base tier. A request past a long-context threshold (Claude
  Haiku 5.5 past 100K tokens, GPT-6 past 272K, Grok past 200K) costs more, and
  the journal keeps one sum per turn, not each request's size, so such usage
  is underestimated.
- Tokens are what the agent reported for the turn. Claude's `usage` leaves out
  a compaction summary and the CLI's own side requests, which its
  `total_cost_usd` includes, so a Claude turn that reported no tokens costs
  nothing here.
- A model the list does not know, including a provider's default model
  recorded as null, keeps the cost its agent reported: the Claude SDK's
  `total_cost_usd`, an ACP `usage_update` priced in USD, or pi's reported cost.
  A row with neither has no price, and the cost measure names its provider
  under the chart instead of counting it as free. Grok reports no tokens, so
  it stays unpriced even with rates.

Rates come before a reported cost because the reported figures were wrong
where they mattered. Codex and Grok report none. Claude's `total_cost_usd` is
a running total the driver takes apart: when a resumed CLI restored less than
the journal held, the turn used to be charged the whole restored total, and
the journal's larger sum made the next resume do the same, so a long thread
grew to several times what its tokens cost.

Claude's `total_cost_usd` is a running total: it grows across the turns of a
warm process, and a process that resumes a session restores the total its
transcript saved when the session's last process ended. That save holds only
what that process counted, so after a process that started from zero it is less
than the sum of the session's turns. Each turn records the CLI's totals as its
result left them (`Turn.agentTotals`: the cost and the tokens of `modelUsage`),
and a cold turn, or a later attempt of the same turn, measures from the last of
them: when the result's `modelUsage` holds those tokens on top of its own, the
turn is charged the difference; when it holds less than half of them, the CLI
started from zero and the turn is charged the whole total. Anything between, or
a total below the saved one, means an older save came back: the turn's share is
unknown, so it records no cost and the usage page prices its tokens. A result
with zeroed totals, as a startup error reports, records none. Turns recorded
before `agentTotals` fall back to the sum of the session's turns.
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

A bot's daily budget and its status's `today.costUsd` use the same rule
(`priceGroup` in `packages/core/src/usage.ts`) over the bot's thread and the
threads below it, subagents included ([bots](bots.md#budget-and-limits)), so
the budget and this page agree on what a turn cost.

## When a provider refuses a turn

Two refusals mean the provider is unavailable, not that the request is wrong.
The driver reports them as `TurnResult.refusal`, only when the agent names
them without doubt; any other failure ends the turn as before.

| Driver | Model at capacity | Usage limit, with its reset |
| --- | --- | --- |
| Codex | `codexErrorInfo` `serverOverloaded`, or "Selected model is at capacity" | `usageLimitExceeded`; the reset is the latest spent window of `account/rateLimits/updated` |
| Claude | assistant error `overloaded` (HTTP 529, after the CLI's own retries) | assistant error `rate_limit`; the reset is the `rate_limit_event` marked `rejected` |
| echo | `[capacity:n]` | `[usage-limit:<ms>]` |

ACP agents, pi, Grok, Antigravity and Muse report neither: their failures
are never retried here.

### Model at capacity

The same turn tries again three times, after 30 s, 2 min and 5 min
(`CAPACITY_RETRY` in `threads/turn-attempts.ts`). The thread stays running and
its row carries `retry` (`kind: 'capacity'`, the try's number and time), which
the conversation shows above the composer with a countdown and Stop retrying.
An attempt that wrote nothing but the error sends the same input again. Once
any attempt of the turn wrote text, reasoning or a tool call, the next try
resumes the same native session with a short continue prompt and no
attachments, so paid work is not redone. Stop ends the wait as a stopped turn;
`turns.cancelRetry` ends it as the failure it was. After the third try the
turn fails with the provider's sentence, as it did before. A core restart
during a wait fails the turn the usual way.

### Usage limit

Settings > Limits has "Resume threads after a usage limit"
(`autoResumeLimitedThreads`, off by default). With it on, a turn that failed
on a usage limit plans one resume a minute after the window resets
(`threads/limit-resume.ts`). The reset is the one the agent reported, else the
latest window at 100 % in a fresh `quotas` read of the turn's account; with
neither, nothing is planned. The plan sits in the journal setting
`resumes` (`threads/resume.ts`), so a restart arms it again, and the row shows it as `retry`
(`kind: 'usage-limit'`, `at`, `resetsAt`) with Do not resume.

Nothing is planned for a failure whose window already reset (no retry loop),
for a window the thread already resumed after, for a sub-thread or persistent
agent, or for a compaction or wake turn. When the plan fires, it is dropped
instead if the setting went off, the thread was archived, answered, stopped or
is busy, its provider, account, model or session generation changed, a card
waits for the user, or the user paused its team. A cache ping in the way
stops and lets it go; it neither cancels the plan nor counts as the turn that
answered. A plan a core caught while dispatching is dropped at the next start,
since its turn may have gone out.
The resume is a `resume` turn with the request id `limit-resume_<turnId>`,
labelled "Resumed after the usage limit reset", whose prompt asks the agent to
continue without repeating work.

Any other failure resumes by itself as an automatic resume
([restart handoff](restart-handoff.md#turns-that-stop-before-their-answer)),
shown as `retry` with `kind: 'auto-continue'`.

`turns.cancelRetry` and `turns.stop` cancel every kind; a paired phone may
call both, since cancelling spends nothing. `?fake=1&retry=capacity`,
`?fake=1&retry=usage-limit` and `?fake=1&retry=auto-continue` put each banner
on a fake thread.

## Paired devices

A phone may call `usage.history`: it returns sums over the same finished turns
a device can already open, and the thread titles it names are the ones
`threads.list` shows it. The reason sits beside the entry in
`packages/core/src/access.ts`. A device also reads `quotas.list` and
`subscriptionProxy.quotas` with the bars the core holds: no refresh button, no
monitoring switch, no reset. A core older than that refuses the read, and the
Limits tab asks to update Boite on that machine. On a phone both pages are under
Settings > Machines, as Usage and Limits.

## The fake client

`?fake=1` draws a believable ledger from `packages/ui/src/lib/fake-usage.ts`:
seven providers with their own models, rhythm and prices. Claude, GPT-6.1 Sol
and pi's Sonnet carry public rates, OpenCode's default model a reported cost,
and Codex's default model, Grok, Antigravity and Muse Code no
price. One Claude model is recorded with its provider prefix, a few turns have
no usage, and the threads match the fake sidebar. Each day's numbers come from a generator seeded with the calendar date,
so a reload shows the same history. Turns finished in the fake session are
added on top, and the uninstalled mode (`?fake=1&uninstalled=1`) starts empty.

## Tests

- `packages/core/test/turn-availability.test.ts`: capacity retries with the
  same input and with the continue prompt, the three-try limit, Stop and
  Cancel during a wait; usage limit resumes off, once per window, never for a
  reset window, cancelled by a message, Stop, Cancel or a changed model, and
  armed again after a restart.
- `packages/core/test/codex.test.ts` and `claude.availability.test.ts`: each
  driver's capacity and usage limit signals end to end.
- `packages/ui/src/components/ThreadRetry.test.ts` and `LimitsPage.test.ts`:
  the banner's countdown and cancel, and the switch.

- `packages/core/test/usage-history.test.ts`: edge boundaries, the provider and
  model split, turns without usage, stored buckets read as they are, pricing at
  public rates over an inflated reported cost, the hour cache write of a
  removed provider and of a mixed turn, the
  reported fallback, legacy turns, the top threads union, provider filtering,
  refused parameters and one real echo turn. Turns an older core recorded are
  read through the provider's current protocol and counted as estimated, and
  `usage.get`, a session, a workflow and a delegation team sum an older and a
  newer Codex turn to the same buckets as the history.
- `packages/core/test/pricing.test.ts`: model id matching, the cache write
  rates, missing rates and the price list's coverage.
- `packages/core/test/claude.session.test.ts`: the warm running total, a
  resumed CLI with and without its totals, one that restored only its last
  process's save, a zeroed startup result, an older save, and one that restored
  less than the journal holds.
- `packages/ui/src/lib/usage.test.ts`: day edges, axis steps, the fixed colour
  order, unused and custom providers, reporting coverage, provider-scoped model
  names, prefixed models sharing a row, the price notes, the summaries and the
  fake ledger.
- `packages/ui/src/components/UsagePage.test.ts`: read failures and retry,
  stale responses after range or machine changes, legacy provider identities,
  and older cores that ignore the provider filter.
- `tests/e2e/usage.test.ts`: the page at 1280x800 and 390x844 in both themes,
  the tooltip staying inside the chart, keyboard reading, the three ranges, the
  phone entry, the limits tab on both widths and the device's Limits note.
  Captures land in `tests/e2e/.artifacts/usage-*.png` and `limits-*.png`.
