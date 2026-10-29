# The prompt cache timer

Settings > Experiments > Prompt cache timer adds a countdown to the context
meter and a detail section with its lifetime and source. It appears only while
the thread is idle. The timer uses provider-reported writes or documented
retention defaults; it does not observe the upstream cache or guarantee a hit.
Reuse can reduce input charges, but current rates depend on the provider and model.

[Context](context.md) owns context readings and compaction;
[model switching](model-switching.md#context-transfer) owns transfer and cache
warnings when changing execution settings.

## What the core records

`ThreadSummary.promptCache` is `{ at, ttlSeconds, maxSeconds?, source,
readTokens, model, accountId }` or null, stored in `threads.prompt_cache`.
`packages/core/src/prompt-cache.ts` owns documented mappings and record assembly.

- `at` is the time of the turn's last main-loop API request when the driver
  reports it as `TurnResult.cacheAt`: Claude and pi record the start of each
  assistant message. Otherwise, as with Codex and OpenCode, `at` is the turn's
  completion time. Boite has no upstream cache timestamp. A request time is
  read when its first stream event arrives, so it lands late by that latency;
  a completion time lands late by the whole answer.
- `ttlSeconds` is the reported lifetime or the implementation's documented
  estimate. Optional `maxSeconds` describes a longer retention possibility;
  the UI says "maybe still warm" between those values.
- `source: 'reported'` means usage identified the write lifetime;
  `documented` means the driver selected a published default. Neither means
  Boite checked that the prefix is still cached.
- `model` and `accountId` identify the execution that wrote it. A different
  account or model does not inherit that record as a warm cache.
- A cache-read-only result without a new lifetime refreshes an earlier matching
  record. A stopped turn with no usage leaves the previous reading unchanged.

## Where each lifetime comes from

These are the driver mappings reviewed on 2026-10-01. Provider defaults and
account retention policies can change independently of Boite.

| Agent and endpoint | Timer mapping | Source |
| --- | --- | --- |
| Claude | Five minutes or one hour from main-loop cache-write usage | `reported` |
| Codex on OpenAI | 30 minutes for GPT-5.6 and later; earlier IDs add a possible 24-hour maximum | `documented` |
| pi on Anthropic | Five minutes or one hour from the reported write | `reported` |
| pi on OpenAI | Same OpenAI model mapping as Codex | `documented` |
| OpenCode `anthropic/` | Five-minute default | `documented` |
| OpenCode `openai/` | Same OpenAI model mapping as Codex | `documented` |
| Grok, Antigravity, Muse and unmapped endpoints | No timer supplied by the current driver | None |
| echo | Five-minute deterministic fixture | Fixed |

### Claude

The driver reads `usage.cache_creation.ephemeral_5m_input_tokens` and
`ephemeral_1h_input_tokens`; a request writing both uses the shorter lifetime.
Subagent requests with `parent_tool_use_id` do not move the parent clock.

Claude Code's documentation, checked on 2026-10-01, describes a one-hour default
for the main conversation within subscription plan usage and five minutes for
API, cloud or usage-credit requests. Settings and environment overrides can
change the request lifetime. Boite reads the applied usage fields rather than
those controls. See [Claude Code prompt caching](https://code.claude.com/docs/en/prompt-caching)
and [Anthropic cache
lifetime](https://platform.claude.com/docs/en/build-with-claude/prompt-caching).

Effort, tool definitions and other prefix changes can affect reuse. The first
Claude Fast activation adds a request header and can miss the existing cache.
A warm CLI retains that header across later speed changes; Boite applies them
in place through the SDK. The timer does not predict every invalidation or
this first miss.

### OpenAI

The documented mapping follows [OpenAI prompt
caching](https://developers.openai.com/api/docs/guides/prompt-caching),
checked on 2026-10-01. GPT-5.6 and later default to a 30-minute minimum
lifetime after the latest write or reuse. Earlier supported models use
retention policies: extended retention commonly lasts around 30 minutes and
can last up to 24 hours; in-memory retention commonly lasts five to ten minutes.
For models supporting both, the organization's Zero Data Retention policy
selects the default.

Boite cannot inspect that organization policy, routing or retention overrides.
Its earlier-model 30-minute estimate can therefore overstate a shorter cache.
The mapping applies to OpenAI's own endpoint, not arbitrary Codex model providers.
The request shape used as its source is pinned in
[Codex
`common.rs`](https://github.com/openai/codex/blob/e7bbc79f482acf285e50a09a9f898aeb2ce3881c/codex-rs/codex-api/src/common.rs);
it is a source snapshot, not a claim about every installed Codex version.

### pi

On Anthropic, pi passes the applied write lifetime through `usage.cacheWrite1h`,
which the driver reads. `PI_CACHE_RETENTION` can select short, long or no cache;
Boite does not infer an applied write from that variable. On OpenAI the driver
uses the documented model mapping, so account policies and explicit retention
settings remain outside the timer's visibility.
Source snapshot: [pi Anthropic request
mapping](https://github.com/earendil-works/pi/blob/a8ed497713ee712b2ba5f27c2ec269d68657465b/packages/ai/src/api/anthropic-messages.ts).

### OpenCode

The ACP driver recognizes the vendor prefix in a model ID. Its Anthropic
mapping uses the default ephemeral lifetime; its OpenAI mapping uses the model
family. A gateway or another vendor receives no documented mapping.
Source snapshot: [OpenCode
transforms](https://github.com/anomalyco/opencode/blob/2406400f0aeb07b36d0495af4e05aaca49159832/packages/opencode/src/provider/transform.ts).

## Keeping the cache warm

Settings > Experiments > Keep the prompt cache warm is off by default. Turned on, it
stores `cacheKeepalive: { hours }` in the core settings, `hours` being a whole
number from 1 to 24 (default 12, `CACHE_KEEPALIVE_HOURS` in
`packages/contracts/src/settings-validation.ts`); null turns it off.
`packages/core/src/threads/cache-keepalive.ts` owns the behaviour.

A thread that waits on its agents often idles past its cache lifetime, and the
result that wakes it then writes the whole prefix again. While the setting is
on, a short automatic turn, a ping, reads the cached prefix shortly before it
lapses, which restarts its lifetime.

### When a thread pings

A wait starts when a real turn of the thread ends `done`. Each ping is planned
from the thread's `promptCache` and checked again when its timer fires. A ping
goes when all of these hold:

- the thread is the user's conversation, a bot's included: not
  archived, not a delegated agent, and it has a session to resume;
- no automatic compaction is planned: compaction takes precedence over a ping
  so refreshing the cache cannot postpone it indefinitely;
- one of its delegated agents is queued, running or waiting, or one of its
  workflows runs;
- its `promptCache` was written by the thread's current model and account, and
  its last turn ran with the thread's current effort and speed;
- the time is `at + ttlSeconds - 2 min`. The margin is `CACHE_KEEPALIVE.marginMs`,
  next to `AUTO_COMPACT` in `packages/core/src/threads/auto-compact.ts`;
- the thread is idle, and nothing else is about to open a turn there: no turn
  handle, steering, pending wake, deferred answer, active goal or loop, and no
  letter in its delegation inbox. Otherwise the ping looks again five seconds
  later (`CACHE_KEEPALIVE.retryMs`).

A ping sends `KEEPALIVE_PROMPT`, a fixed request to answer the single word
`ok` without tools. It resumes the thread's session with the same model,
effort, speed, account, permission mode and tools, so the request prefix
matches. The prompt carries no memory, letters or guide, so nothing new comes
before it. The word "ultrathink" stays on Claude prompts, because another thinking
budget would miss the cached messages. The turn has `operation: 'keepalive'`
and `automatic: true`; its opening message is a system message labelled
`Prompt cache kept warm`, shown as one quiet line. A ping does not mark the
thread unread or failed, does not notify, pauses no delegation and plans no
compaction.

### What ends a wait

The core reads the usage after each ping. A hit sets a new `promptCache.at`,
and the next ping is planned from it. A miss ends the wait and is logged. A
ping misses when less than half of the tokens it sent were read from the cache
(`missOf`). On Anthropic a miss writes the prefix again; on OpenAI it bills the
prefix as fresh input. A ping without usage, stopped or failed, also ends the
wait. A ping whose session the agent lost fails without the retry on a fresh
session that a real turn gets: that retry would write the whole history again.

A wait also ends, logged as `cache-keepalive.ended` with its reason, when:

- no agent or workflow is left to wait for;
- a user message, a wake or a result opens a real turn. When that turn ends with
  agents still working, it starts a new wait with a new count;
- the user stops or archives the thread, or turns the setting off;
- the next ping would fall more than `hours` after the end of the last real turn;
- the wait reached its break-even cap. `KEEPALIVE_PING_CAP` in
  `packages/core/src/prompt-cache.ts` keeps it, with sources: 20 pings for a
  one-hour Anthropic cache (2x write, 0.1x read), 12 for a five-minute one
  (1.25x write), and 10 for OpenAI (0.1x cached input). A lifetime outside
  that table is never kept warm.

Each ping is logged as `cache-keepalive.ping`.

A result always wins. When a delegated agent's result or a workflow's result
comes in during a ping, the ping is stopped and the wait ends. The result is
then delivered on the `turn.finished` that follows, as for any busy thread.

### Douane and other routers

A ping helps only if it reaches the cache that the thread's last request
wrote. Boite cannot see how a subscription proxy such as Douane routes a
request, and has not checked that Douane keeps a session on the same
upstream account. If a proxy moves a ping elsewhere, its usage shows a miss,
and the wait ends after that one ping.

### Limits

- The thread shows as running during a ping. A user message sent then waits
  for the ping to finish. Stop during a ping is the usual Stop, which also
  stops the thread's agents.
- Turning the setting on while a thread already waits arms nothing until its
  next real turn ends.
- A ping cancels a compaction armed for the cache's expiry
  ([automatic compaction](context.md)). The next real turn plans one again.
  A ping that a usage limit refuses ends the wait, and the thread does not
  resume by itself.
- The clock comes from Claude and pi request times. Elsewhere it comes from
  the turn's end, which lands later, so the two-minute margin also absorbs
  that delay.
- A ping adds a short exchange to the conversation and costs a cache read of
  the whole prefix.

### Unmapped providers

The absence of a timer describes Boite's current integration; it does not imply
that the vendor has no cache. Vendor mechanisms have separate controls and
limits, including [Gemini context caching](https://ai.google.dev/gemini-api/docs/caching)
and [xAI caching](https://docs.x.ai/developers/advanced-api-usage/prompt-caching/how-it-works).
