# Luna max Fast comparison protocol

Frozen before the measured campaign on 2026-09-24. The browser plugin remains
unchanged; this is a benchmark of two alternative policies.

- Thirty public workflows from `bench/browser-wide-tasks.ts`, two fresh-profile
  attempts per workflow and policy: 120 attempts total.
- Direct: GPT-6 Luna, max reasoning, priority service tier (Fast).
- Hybrid: Jev 1.13.0 gets ten decisions or a 15-second cancellation threshold,
  then Luna resumes the same page if Jev returns needs-agent or an error.
  An in-flight browser command finishes before the handoff. No restart or
  independent grading feedback is supplied to Luna.
- Both policies use the same goals, supplied values, completion conditions,
  agent-browser 0.37.1 daemon, 1280x800 viewport and independent graders.
  Every attempt starts logged out. Only the starting origin is allowed.
- The shared execution budget is 120 seconds and 30 attempted browser actions.
  Browser startup and initial navigation precede that budget but are included
  in the reported total. Final evidence capture and cleanup are excluded.
- One Codex app-server process stays warm for the campaign. Each Luna leg gets
  a fresh ephemeral thread; its startup and tool round trips count in task time.
  The live catalogue and thread response must confirm Luna, max and priority.
  Authentication uses the existing ChatGPT subscription, without an API key.
- Luna receives rendered field metadata, a searchable accessibility snapshot
  and batches of up to eight observed actions. This compares complete pilots,
  not a model-only substitution in Jev's constrained choice loop. No direct
  URL navigation, arbitrary scripts, external tools or site-specific action
  recipes are available to the model.
- The first pass runs direct then hybrid for each workflow; the second reverses
  policy order and rotates workflow order. Failed attempts stay in the results.
- The twelve development pilot attempts are excluded. One early ESA pilot
  omitted Luna's exact completion condition; this was fixed before measurement.
  Live recordings are separate runs and also excluded from timing statistics.

Run `bun run bench/browser-luna.ts` with `BOITE_BENCH_LUNA=1`,
`BOITE_BENCH_REPETITIONS=2`, `BOITE_BENCH_OUTPUT` pointing to a new directory,
`BOITE_BROWSER_TEST_BINARY`, `BOITE_BENCH_CODEX_BINARY`, and the Jev key supplied
through `TYPESAFE_API_KEY`. Both modes and all thirty tasks are the defaults.

The runner writes source hashes, per-attempt browser commands, model setting
acknowledgements, timing, usage, final checks and process cleanup counts. Model
transcripts stay private; only sanitized results and selected public-site
recordings are published. No failure is retried into a success in the same run.
