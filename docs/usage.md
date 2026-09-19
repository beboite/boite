# Usage

Settings > Usage shows what the agents spent through Boite: tokens, the API
equivalent cost and turns, per day, provider, model and thread, with the
subscription limits each provider last reported. Everything on the page comes
from turns the core already recorded in its journal. Boite never estimates a
token count or prices a turn itself.

## The page

- The range is 7, 30 or 90 days, ending today. The measure is tokens, API cost
  or turns, and every card follows it.
- The overview gives the total for the range and one row per provider with its
  share.
- Per day is a column chart stacked by provider, one column per local calendar
  day. Hovering or tapping a column opens every provider's value for that day.
  The chart also takes the keyboard focus: the arrow keys, Home and End move
  between days and a screen reader reads the same values.
- Breakdown lists each model with its turns, tokens, input, output, cache and
  cost. By day is the same table with one row per day that had a turn, which
  doubles as the chart's table view.
- Top threads are the ten threads that spent the most by the chosen measure.
  A thread still in the sidebar opens on click; an archived one is marked.
- Limits are the windows from `quotas.list`, the same source as the tray popup.
  An account whose provider reports no limit, or whose monitoring is off, is
  named once under "Not monitored".

Provider colours come from `--series-1` to `--series-8` in `app.css`, with a
light and a dark set. The order is fixed (Claude, Codex, OpenCode, Grok,
Antigravity, pi, then two spare slots), so a provider keeps its colour whatever
the range shows. A ninth provider and beyond fold into one grey "Other" series.

## `usage.history`

The UI sends the day boundaries and the core sums the finished turns between
them in SQLite:

```ts
'usage.history': { params: { edges: Timestamp[] }; result: UsageHistory };
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
On a subscription the figure is what the same tokens would cost on the API, not
money spent.

## Paired devices

A phone may call `usage.history`: it returns sums over the same finished turns
a device can already open, and the thread titles it names are the ones
`threads.list` shows it. The reason sits beside the entry in
`packages/core/src/access.ts`. `quotas.list` stays owner-only, so on a device
the Limits card says the limits are read on the computer that runs Boite. On a
phone the page is under Settings > Machines > Usage.

## The fake client

`?fake=1` draws a believable ledger from `packages/ui/src/lib/fake-usage.ts`:
six providers with their own models, rhythm and prices (none for Codex, Grok and
Antigravity), a few turns without usage, and threads that match the fake
sidebar. Each day's numbers come from a generator seeded with the calendar date,
so a reload shows the same history. Turns finished in the fake session are
added on top, and the uninstalled mode (`?fake=1&uninstalled=1`) starts empty.

## Tests

- `packages/core/test/usage-history.test.ts`: edge boundaries, the provider and
  model split, turns without usage, the Codex cache subtraction, legacy turns,
  the top threads union, refused edges and one real echo turn.
- `packages/ui/src/lib/usage.test.ts`: day edges, axis steps, the fixed colour
  order, the summaries and the fake ledger.
- `tests/e2e/usage.test.ts`: the page at 1280x800 and 390x844 in both themes,
  the tooltip staying inside the chart, keyboard reading, the three ranges, the
  phone entry and the device's Limits note. Captures land in
  `tests/e2e/.artifacts/usage-*.png`.
