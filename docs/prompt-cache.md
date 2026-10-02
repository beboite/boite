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

- `at` is the turn's completion time. Boite has no upstream cache timestamp;
  request and response latency can skew the countdown.
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
| Grok, Antigravity, agy, Muse and unmapped endpoints | No timer supplied by the current driver | None |
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

Effort, speed, tool definitions and other prefix changes can affect reuse;
the timer does not track every invalidation.

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

### Unmapped providers

The absence of a timer describes Boite's current integration; it does not imply
that the vendor has no cache. Vendor mechanisms have separate controls and
limits, including [Gemini context caching](https://ai.google.dev/gemini-api/docs/caching)
and [xAI caching](https://docs.x.ai/developers/advanced-api-usage/prompt-caching/how-it-works).
