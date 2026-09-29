# Broader public-site browser evaluation

This protocol is frozen before running Jev on the new task manifest in
[`browser-wide-tasks.ts`](../browser-wide-tasks.ts). It tests the existing
plugin without production changes or site-specific action scripts.

## Sample

- 30 new public, logged-out workflows, three attempts each: 90 timed trials.
- Fresh browser profile per attempt, 1280 by 800 viewport, sequential execution.
- Rotate task order between repetitions. Retain every failure and timeout.
- Use agent-browser 0.37.1 and Jev 1.13.0 through the actual browser plugin RPC.
- Preserve the plugin's 30-step cap and 120-second total task deadline.
- Record the task manifest and production loop SHA-256 in the output protocol.

The tasks cover public search, catalog navigation, language changes, filters,
pagination, disclosures and calculators. HTTP/source preflight establishes
goals and expected outcomes before testing; it does not test Jev or prescribe
its actions. Unavailable sites and bot challenges remain in the denominator.
No credentials, account creation, purchases or public messages are involved.

## Grading

A success requires the plugin to report success, at least one successful
interaction, every independent outcome predicate to pass, and zero owned
browser processes after cleanup. Predicates inspect final URL, rendered text,
field state or observed intermediate URLs. Grader selectors are never sent
to Jev and never drive the page. A claimed success with failed outcome checks
is reported as a false positive, not accepted as a success.

The runner records model decisions, command outcomes, visited URLs, input
tokens and timings. It attempts a final screenshot before closing each browser;
an unavailable or cancelled connection can prevent final evidence collection.
Such trials remain failures. Execution time excludes initial browser startup
and navigation; total time includes them. Evidence capture and cleanup are
reported separately. Report successful and failed durations separately.

## Recordings

Video runs use a separate output directory and are excluded from the 90 timed
trials. Native CDP screencast records the live browser. A recorder overlay shows
elapsed time, Jev's selected action and actual DOM events. It does not replay
actions, dispatch synthetic pointer events or supply actions to Jev. Its closed
shadow root and hidden accessibility host keep it out of the plugin's page
observations. Any displayed clip excerpt links to its complete recording.

## Reproduction

Set `BOITE_BENCH_BROWSER=1`, `BOITE_BENCH_REPETITIONS=3`, a fresh
`BOITE_BENCH_OUTPUT`, the verified native executable in
`BOITE_BROWSER_TEST_BINARY`, and `TYPESAFE_API_KEY` in the child environment.
Run `bun run bench/browser-wide.ts`.

For separate video runs, set `BOITE_BENCH_RECORD=1`, repetitions to `1`, and
`BOITE_BENCH_TASKS` to comma-separated manifest IDs. The output protocol marks
these trials as recorded. Never combine them with the uninstrumented sample.

This sample cannot establish that a browser agent can do everything online.
It does not establish reliability for authenticated workflows, payments,
uploads, downloads, arbitrary visual widgets or cross-origin workflows.
