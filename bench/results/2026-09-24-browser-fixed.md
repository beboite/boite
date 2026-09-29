# Public-site rerun after fixing the browser adapter

Measured on 2026-09-24. The [original baseline](2026-09-24-browser.md)
remains unchanged: 0/9 complete Jev workflows before these fixes.
The corrected plugin completed 9/9, with three fresh profiles per task.

The subsequent [30-workflow evaluation](2026-09-24-browser-wide.md) completed
38/84 valid trials across 23 sites. It includes live recordings and all failed
attempts. Use that broader sample when assessing general website reliability.

| Site | Corrected Jev, three attempts | Earlier GPT visual | Earlier GPT + agent-browser |
| --- | --- | --- | --- |
| Wikipedia | 3/3, 1.50-2.33 s | 22.86 s | 17.42 s |
| GitHub release assets | 3/3, 1.41-3.33 s | 84.99 s | 31.06 s |
| GOV.UK search and renewal guide | 3/3, 1.57-1.73 s | 33.52 s | 27.27 s |

These are execution times, excluding initial browser startup/navigation and
cleanup. They include model and tool latency. Including startup/navigation,
Jev took 3.12-5.83 seconds. All nine runs reported `succeeded`, passed the
independent workflow grader and left zero owned browser processes.
The [result JSON](2026-09-24-browser-fixed.json) records individual timings,
visited URLs, chosen controls and the SHA-256 of the tested browser loop.

GPT results are the earlier same-day subscription trials, one per site; they
were not rerun. The visual arm uses screenshots and coordinate inputs through
agent-browser, not OpenAI's integrated Computer Use tool. Their end-to-end
timings include subscription-agent orchestration and are not isolated model
latency comparisons. These tasks guided the fixes, so this is a regression
rerun, not a held-out reliability evaluation.

## What changed

- Read interactive snapshots and expose large control lists in document order,
  in bounded groups. Inspect remaining groups before accepting a blocked verdict.
  Keep the original observed references and recheck them before every action.
- Distinguish editable comboboxes from native selects. Pass the caller's exact
  string to the driver and read the resulting field value back before proceeding.
- Reobserve empty navigation documents, and recheck completion when content
  arrives during a model decision.

No site-specific selectors, URLs or navigation scripts were added to the
production loop. The goals, supplied values, exact destination/text checks,
30-step limit, 120-second timeout, browser and viewport match the baseline.
The GOV.UK grader still requires the exact supplied search query in an observed
search URL. Its instrumentation now excludes field metadata objects that have
no URL; these otherwise caused `Invalid URL` while grading an actual success.

The nine published runs made 30 Jev requests, using 152,359 input tokens.
Median request latency was 252 ms. At the published
[$0.042 per million input tokens](https://docs.typesafe.ai/models), their
estimated model cost is $0.006399, excluding development runs.

## Evidence and reproduction

[Jev reached the requested GitHub assets](https://pub-15ca30b4efbf4285a292416a3e0e6c38.r2.dev/202609/d2906527e05edf6e3acfd4b32601b7c7/github-1.png).
[Jev reached the GOV.UK Renew instructions after search](https://pub-15ca30b4efbf4285a292416a3e0e6c38.r2.dev/202609/346e52449125c50c7fab6a98fac50b80/govuk-1.png).

Use the environment setup in the [baseline protocol](2026-09-24-browser.md#reproduce)
with a fresh output directory, then run `bun run bench/browser-real.ts`.
No fixed route is replayed; Jev selects every action from the current page.

Verification on the final loop:

- `bun test packages/core/test/browser.test.ts packages/core/test/browser-rpc.test.ts`: 30 pass, 0 fail.
- `bun test tests/e2e/jev.test.ts` with the live opt-in and key: 5 pass, 0 fail.
- `bun run check` and the browser benchmark TypeScript check passed.

Regression tests failed before their corresponding fixes: large pages, input
and select comboboxes, silent field no-ops, empty navigation documents, late
completion, oversized labels and focus redirection. The native invoice fixture
still checks both review records and exactly one final submission.

Development runs are excluded from the final sample: an initial three-site
probe and five nine-run series guided the fixes. These exposed transient
navigation observations, the grader's field-metadata bug and premature
handoffs. The last development series passed 7/9: two Wikipedia attempts
stopped while the search control was still in an unexamined group. Preserving
document order and examining remaining groups before handoff addresses that
failure. The published nine-run series was executed after all production
changes. Authentication, uploads/downloads, arbitrary widgets and native browser
execution on Linux/macOS remain unverified.
