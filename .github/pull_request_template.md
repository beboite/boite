<!--
The title becomes the squash commit and the release notes line:
type(scope): summary, with type one of feat, fix, perf, refactor, docs,
test, ci, build, chore or revert. The scope is optional.
-->

## What changed

Describe the problem and the resulting behavior. Link the issue it closes.

## Verification

List the commands run, their results, and anything not verified.
Include desktop and phone captures for visual changes.

## Affected paths

Tick what this change touches and was checked on. Leave the rest empty.

- [ ] Desktop and phone
- [ ] Each affected driver: Claude, ACP, Codex, pi, echo
- [ ] Both transports: the real core and `lib/fake-client.ts`
- [ ] Reverse actions: archive, uninstall, unsubscribe, shutdown
- [ ] Windows and Linux
- [ ] Contract first: `packages/contracts/src/index.ts`
- [ ] Documentation
