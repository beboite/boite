# Changing models in a conversation

The composer picker can select another provider or account in an existing
thread. The conversation, draft, working directory and worktree stay in place.
The selection applies to the next prompt accepted by the core. An already
running or queued turn keeps its account, model, effort and permissions.

A compatible model change on the same account follows the driver's existing
model-switch path. Changing accounts clears the native session. The next turn
starts a fresh session with context from the journal. Returning to an earlier
account also starts fresh, so it receives the intervening work.

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

Historical images use remaining slots within the eight-image turn limit. The
current prompt's attachments take priority, then the most recent historical
images. Delivery is chronological. The receiving agent is told which older
image references lack an attachment. An image-incapable destination refuses
continuation of an image-bearing history explicitly.

## Storage and concurrent changes

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
