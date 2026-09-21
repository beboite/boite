# Changing models in a conversation

The composer picker can select another provider or account in an existing
thread. The conversation, draft, working directory and worktree stay in place.
The selection applies to the next prompt accepted by the core. An already
running or queued turn keeps its account, model, effort and permissions.

A compatible model change on the same account follows the driver's existing
model-switch path. Changing accounts clears the native session. The next turn
starts a fresh session with context from the journal. Returning to an earlier
account also starts fresh, so it receives the intervening work.

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

Model catalogs persist in client storage, scoped to the core endpoint and data
directory and checked against the current provider/account records. Opening an
agent shows the cached list immediately while discovery runs in the background.
The top-right refresh button forces a new probe; concurrent requests share one
operation. A failed refresh keeps the visible list and waits for a manual retry.
The menu floats without changing the page layout. It prefers the space below the
composer and flips above when needed. Provider tabs sit above the models; the
menu fits its content up to a scrollable height limit. Legacy models open in a
side submenu, with a left-side or in-viewport fallback on narrow screens.
Both menus use the browser's top layer so the composer's glass or Grain blur
cannot offset or clip them. Pointer-click checks cover both materials.
Favorites use a single row; an inline account label only distinguishes the same
model starred on different accounts.

Claude aliases use their resolved id and versioned name. Default aliases are
filtered before deduplication so they cannot hide the named Opus row or its Fast
capability. Known legacy descriptor ids stay available; capabilities absent from
native discovery remain absent instead of inheriting another model's settings.

The lightning button beside the effort chip cycles through the model's advertised speeds and
back to standard. Codex uses its per-model `serviceTiers` list, including Fast or
Ultrafast only when listed, and sends the selected id as `turn/start.serviceTier`.
Claude uses `supportsFastMode` and session-scoped `settings.fastMode`; changing it
reopens the CLI on the same native session. ACP and pi expose no speed switch.
A model/account change clears speed and effort. Schema 10 stores `threads.speed`,
and each accepted turn freezes it with the other execution settings.

Appearance offers accent swatches and a hue slider. The colour persists per
client as `boite.accent-hue` and colours reasoning, primary buttons, links and
focus indicators. The file attachment button sits beside Send; keyboard help
stays out of the chatbar.

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
inside one account keeps its session and asks nothing.

Historical images use remaining slots within the eight-image turn limit. The
current prompt's attachments take priority, then the most recent historical
images. Delivery is chronological. The receiving agent is told which older
image references lack an attachment. An image-incapable destination refuses
continuation of an image-bearing history explicitly.

## Storage and concurrent changes

The composer resolves an old `default` or `auto` model alias to the configured
provider preset for the next prompt when one is configured. A named model stays selected. Before sending
on an old thread, the UI verifies the preset against the account's model catalog
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
