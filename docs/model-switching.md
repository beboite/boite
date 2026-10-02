# Changing models in a conversation

The composer picker can select another provider or account in an existing
thread. The conversation, draft, working directory and worktree stay in place.
The selection applies to the next prompt accepted by the core. An already
running or queued turn keeps its account, model, effort and permissions.

A compatible model change on the same account follows the driver's existing
model-switch path. Changing accounts clears the native session. The next turn
starts a fresh session with context from the journal. Returning to an earlier
account also starts fresh, so it receives the intervening work.

## Provider defaults

Settings > Providers stores a default model and effort per provider on this
device. New threads use those defaults; Ctrl+Enter preserves an explicit choice.
Existing threads keep their selection. A first send probes when needed and
refuses a preset unavailable on that account by name. Presets live in client
configuration; descriptor lists and native probes own availability.

## Picker and favorites

The picker hides unnamed `default` and `auto` entries while retaining them in
the provider contract for existing sessions. It lists named models by family
tier and numeric version, with legacy models folded away. This is a display
heuristic, not a benchmark ranking.

Each model has a star. The first provider-rail entry, Favorites, contains only
starred models and shows their associated account. Favorites persist in the
client's local storage, not across devices. Selecting a dynamic favorite checks
the account's current model list; a removed model is refused explicitly.

The reasoning popover has one notch per level reported by the selected model.
Dragging previews the level and saves on release. Arrow keys, Home, End and
the dots select the same discrete values. The compact panel shows the model and
current level centred above the track. The track reaches the thumb and becomes
more saturated at higher levels. Ultrathink belongs only to Claude and is offered
when its SDK reports adaptive thinking.

Claude Code also acts on two words typed anywhere in a prompt: `ultrathink`
asks for the deepest thinking on that turn, and `ultracode` opts the turn into
the Workflow tool when the account has workflows. When Claude Code runs a Claude
model, the composer and the sent message draw them apart, `ultrathink` in the
spectrum and `ultracode` in the accent. Another harness, or Claude Code routed
to another model, reads them as plain words, and they stay plain there. `ultraplan` and
`ultrareview` run on claude.ai and are not
available through the SDK.

Model catalogs persist in client storage, scoped to the core endpoint and data
directory and checked against the current provider/account records. Opening an
agent shows the cached list immediately while discovery runs in the background.
With no cached list, the column shows loading rows and the reading line until
the first answer lands. Claude ships no model catalog and never offers descriptor
placeholders after a failed read. An empty catalog offers a refresh instead.
Paired phones can discover and refresh the same account models and ACP effort
metadata as desktop clients, without access to provider or account configuration.
Reopening the picker after five minutes refreshes that account's catalog, and a
catalog restored from storage is also revalidated. These reads replace the
displayed models and their legacy flags without changing per-provider defaults.
Before creating a thread with a named model, the composer awaits the owning
core's catalog even when the client already has cached rows. A restarted remote
core reads the agent's models first; a core with a catalog reuses it. The selected
model, effort and speed are preserved, and a failed read leaves the draft unsent.
The refresh button forces a new probe; concurrent requests share one
operation. A failed read keeps the visible list and backs off for five minutes;
the refresh button can retry immediately.
Each provider column has a compact search field matching names and ids. Search
includes legacy models directly in the main results, without opening a submenu.
Long lists retain prefix groups and a bounded first page; search reaches every
model. Desktop focuses the field when opened, while phones wait for a tap.
The menu floats without changing the page layout. It prefers the space below the
composer and flips above when needed. On desktop, provider logos sit in a
narrow left column, with names in tooltips. On phones, they form a horizontal
strip above them. The frame keeps the same size when switching providers or
favorites, limited by the available viewport space. Models scroll independently
below the provider name and account chips. Legacy models open in a
side submenu, with a left-side or in-viewport fallback on narrow screens.
Both menus use the browser's top layer so the composer's glass or Grain blur
cannot offset or clip them. Pointer-click checks cover both materials.
Favorites use a single row; an inline account label only distinguishes the same
model starred on different accounts.

Claude aliases use their resolved id and versioned native name. Default aliases are
filtered before deduplication so they cannot hide the named Opus row or its Fast
capability. Native discovery replaces the descriptor list rather than adding
older descriptor ids. Models without an explicit legacy classification stay in
the main list, including models found on a manual refresh; the legacy submenu
appears only when the list contains explicitly classified legacy entries.
Capabilities absent from native discovery remain absent instead of inheriting
another model's settings.

The lightning button beside the effort chip cycles through the model's advertised speeds and
back to standard. Codex uses its per-model `serviceTiers` list, including Fast or
Ultrafast only when listed, and sends the selected id as `turn/start.serviceTier`.
Claude uses `supportsFastMode` and session-scoped `settings.fastMode`; changing it
reopens the CLI on the same native session. Older Codex catalogs use
`additionalSpeedTiers` when `serviceTiers` is absent.
Native tiers cycle Fast before Ultrafast regardless of catalog order. When no
native tier is advertised, a listed model and its `-fast`, `_fast` or `:fast`
variant share the lightning control, as do `ultrafast` variants. Both ids must
come from the same provider and account. Switching variants changes the model
id with no service tier and preserves an effort both models support.
Other model/account changes clear speed and effort. Schema 10 stores `threads.speed`,
and each accepted turn freezes it with the other execution settings.

Device appearance and WebView material rules are documented in
[development](development.md#ui-spacing-and-motion).

## Context transfer

The first prompt carries historical user and assistant text, tool outcomes and
recent images before the current request. It excludes private reasoning and
past approval grants. Each provider keeps its own system instructions and tools.
The assembled context never becomes an extra user message in the timeline.
New answers identify their model. Old turns without execution metadata do not
guess an author.

Transfer uses bounded excerpts, not an additional model-generated summary. It
retains up to 12,000 characters of opening exchanges and 64,000 of recent
exchanges. Individual entries are capped at 12,000 characters with beginning
and end preserved. Gaps are identified to the receiving agent. These are
transport bounds, not token estimates. Some old details may be absent; the
journal remains unchanged.

A thread whose last context reading is over 200,000 tokens asks before it moves
to another account: the receiving agent gets these excerpts, not what the old
session held, and a compaction summary is not part of them. A model change
inside one account keeps its session.

Moving a thread to another project uses the same transfer on every driver but
Codex, whose resume takes the new folder and keeps its session. The seeded
prompt says the thread moved during the conversation and that the latest move
note names the folder it works in now ([moving a thread](development.md#moving-a-thread)).

Keeping the session does not guarantee prompt-cache reuse. Model, effort or
speed changes can alter the request prefix. Inside one account, the UI asks
before such a change when the last context reading exceeds 100,000 tokens and
is less than an hour old. This is a recency rule, not a cache invalidation
detector; [cache lifetimes](prompt-cache.md) can differ. An account change uses
the history-transfer warning above instead.

Historical images use remaining slots within the eight-image turn limit. The
current prompt's attachments take priority, then the most recent historical
images. Delivery is chronological. The receiving agent is told which older
image references lack an attachment. An image-incapable destination refuses
continuation of an image-bearing history explicitly.

## Storage and concurrent changes

The composer resolves an old `default` or `auto` model alias to the configured
provider preset for the next prompt when one is configured. A named model stays
selected. Before sending on an old thread, the UI verifies the preset against the
account's model catalog
and saves it with the thread's selection revision. An unavailable preset or a
concurrent selection change refuses the send; it never silently runs the alias.
The picker also ignores saved presets containing these aliases.

Schema 9 adds `threads.session_generation`, `threads.selection_version` and
`turns.execution`. Existing native session IDs survive migration. Execution
snapshots record the target at acceptance, and both scheduler and driver use it.

Results from an earlier account generation cannot overwrite the selected
account's native session, commands or context meter. The old warm process is
released once its turn settles. Account removal and login-switch protection
include accounts held by active turns that the picker has since left.

`threads.update` accepts `accountId`, nullable `model` and an optional
`expectedSelectionVersion`; provider identity derives from the account.
`turns.start` accepts the same revision precondition. The UI supplies it to
refuse stale selections explicitly. Older clients may omit it. Existing device
access rules still apply. Paged history also returns its turns for attribution.

This adds no automatic retry after uncertain native dispatch. Existing
interrupted-turn recovery remains authoritative. Prompts held locally in the
composer are not accepted turns; they use the selected model when submitted.

## Verification

`packages/core/test/model-switch.test.ts` covers account changes and return,
queued execution ownership, stale selections, long history, images and schema
migration. The UI test preserves the thread and draft across picker changes.
`tests/e2e/model-switch.test.ts` switches Echo to a fixture ACP process through
real WebSocket and stdio paths and captures desktop and phone layouts.
These tests do not use real provider accounts.
