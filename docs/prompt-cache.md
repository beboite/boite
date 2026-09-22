# The prompt cache timer

Providers cache the start of a conversation between requests. A request that
arrives while the cache is warm pays for the repeated context at the cached
rate, about a tenth of the input price on Anthropic and OpenAI. After the
cache expires, the provider processes the whole context again, and Anthropic
bills a new cache write on top. The timer shows how long the current thread
has before that happens, so you can decide whether to answer now or later.

It is an experiment: Settings, Experiments, `Prompt cache timer`. When it is
on, the context meter in the thread header gains a clock with the minutes left,
and its popup gets a Prompt cache section with the lifetime and its source.

## What the core records

`ThreadSummary.promptCache` is `{ at, ttlSeconds, maxSeconds?, source,
readTokens, model, accountId }` or null. The core writes it at the end of every
turn whose driver names a lifetime, and keeps it in the journal
(`threads.prompt_cache`, schema 13).

- `at` is when the turn finished. Every provider below restarts the lifetime
  on each hit, so the clock runs from the last request, not the first write.
  Anthropic counts from the start of the request, so a long streamed answer
  starts its countdown a little early; the difference is the length of the
  final response.
- `ttlSeconds` is the lifetime the provider promises. `maxSeconds` is present
  when the provider may keep the prefix longer on a best-effort basis, and the
  timer then says "maybe still warm" between the two.
- `source` is `reported` when the agent's own usage named the lifetime of
  that request, `documented` when it comes from the provider's published
  default for what the agent sends.
- `model` and `accountId` are what the turn ran on. Each model has its own
  cache and caches never cross organizations, so a thread moved to another
  model or account reads cold whatever the clock says.
- A turn that only read from the cache and names no lifetime keeps the earlier
  lifetime with a new `at`, as long as the model and account are the same. A
  turn stopped before its first request, with no usage, changes nothing.

## Where each lifetime comes from

| Agent | Lifetime | Source |
|---|---|---|
| Claude | 5 minutes or 1 hour, per request | `reported`: `usage.cache_creation.ephemeral_5m_input_tokens` and `ephemeral_1h_input_tokens` on each main-loop assistant message |
| Codex on OpenAI | 30 minutes; up to 24 hours before GPT-5.6 | `documented`, from the model `thread/start` answers |
| pi on Anthropic | 5 minutes or 1 hour, per request | `reported`: pi's `usage.cacheWrite1h` |
| pi on OpenAI | as Codex | `documented` |
| OpenCode on `anthropic/` models | 5 minutes | `documented` |
| OpenCode on `openai/` models | as Codex | `documented` |
| Grok, Antigravity, Antigravity CLI, Muse Code, other vendors | none | no published lifetime |
| echo | 5 minutes | fixed, for tests |

When the lifetime is unknown the header shows no clock. Showing a guessed one
would be worse than showing nothing.

### Claude

Claude Code picks the lifetime per request. On a Claude subscription within
its plan usage the main conversation asks for one hour; on an API key, a cloud
provider, or a subscription drawing on usage credits, it asks for five
minutes. `promptCacheTtl`, `CLAUDE_CODE_PROMPT_CACHE_TTL`,
`ENABLE_PROMPT_CACHING_1H` and `FORCE_PROMPT_CACHING_5M` override it, and
`DISABLE_PROMPT_CACHING` turns it off. Boite does not read any of these: the
API reports which lifetime each write used, and the driver reads that. A
request writing at both lifetimes counts as the shorter one. Subagent
requests (`parent_tool_use_id` set) build their own prefix at five minutes and
do not move the thread's clock.

Changing the effort level also starts a new cache on most models, which the
timer does not track.

Sources: [How Claude Code uses prompt caching](https://code.claude.com/docs/en/prompt-caching),
[Prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching).

### OpenAI

Codex sends a `prompt_cache_key` equal to its thread id and no retention
option (`ResponsesApiRequest` in `codex-rs/codex-api/src/common.rs` has no
such field). OpenAI's defaults then apply:

- GPT-5.6 and later: "A cached prefix remains eligible for reuse for 30
  minutes after its most recent write or reuse, though OpenAI may retain it
  longer."
- Earlier models: an organization without Zero Data Retention defaults to the
  extended retention, which "typically keeps entries available for around 30
  minutes and can retain them for up to 24 hours". With Zero Data Retention the
  default is in-memory, 5 to 10 minutes of inactivity. The core cannot see
  which kind of organization an account belongs to, so a ZDR account reads
  warmer than it is.

The same rule applies to pi and OpenCode when they call OpenAI's own endpoint.
A Codex configured on another model provider shows no clock.

Sources: [OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching),
[openai/codex `common.rs`](https://github.com/openai/codex/blob/e7bbc79f482acf285e50a09a9f898aeb2ce3881c/codex-rs/codex-api/src/common.rs).

### pi

pi's `PI_CACHE_RETENTION` (`short` by default, `long`, or `none`) chooses
between Anthropic's five minutes and one hour, and between OpenAI's default
and its explicit retention. On Anthropic pi passes the API's split through as
`cacheWrite1h`, so the driver reads the lifetime of each request rather than
the variable. On OpenAI, `long` asks for what the organization default
already is, so the rule above holds.

Source: [earendil-works/pi `packages/ai`](https://github.com/earendil-works/pi/blob/a8ed497713ee712b2ba5f27c2ec269d68657465b/packages/ai/src/api/anthropic-messages.ts).

### OpenCode

OpenCode marks Anthropic prompts with `cacheControl: { type: "ephemeral" }` and
no `ttl`, which is five minutes, and sets no retention option for OpenAI.
Its model ids name the vendor (`anthropic/claude-sonnet-5`,
`openai/gpt-6-astra`), which is what the driver reads. A model served through OpenCode's own gateway or another vendor
has no published lifetime.

Source: [anomalyco/opencode `transform.ts`](https://github.com/anomalyco/opencode/blob/2406400f0aeb07b36d0495af4e05aaca49159832/packages/opencode/src/provider/transform.ts).

### No published lifetime

- Gemini's implicit caching, which Antigravity and the Antigravity CLI rely on,
  publishes no lifetime. Only explicit `CachedContent` has one, an hour by
  default. [Context caching](https://ai.google.dev/gemini-api/docs/caching)
- xAI says cache entries "can be evicted at any time due to server load or
  restarts" and gives no number.
  [How prompt caching works](https://docs.x.ai/developers/advanced-api-usage/prompt-caching/how-it-works)
- Muse Code's documentation does not mention its cache.
