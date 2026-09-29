# Julia browser experiment protocol

This experiment tests finite-choice selection on saved public-page observations and on eight live workflows. Julia receives text and candidate descriptions. Luna generates the live subgoals and commands. Neither experiment measures an autonomous Julia browser agent.

## Model and runtime

The checkpoint is [SupersonicLabs/Julia-1](https://huggingface.co/SupersonicLabs/Julia-1/tree/a85b127321d580d65176c89ced8273f305745d85), revision `a85b127321d580d65176c89ced8273f305745d85`. The optional export is [Julia-1-ONNX](https://huggingface.co/SupersonicLabs/Julia-1-ONNX/tree/82a2fadf8fccfccdc5fd4e1009ba8f1a265eb7a8), revision `82a2fadf8fccfccdc5fd4e1009ba8f1a265eb7a8`. [Runtime provenance](2026-09-29-julia/runtime.json) records the weight, graph, runtime and server hashes.

The [source archive](2026-09-29-julia/source-archive.json) preserves exact UTF-8 contents for the 13 files in each live cohort, deduplicated into 15 source versions. It identifies the core checkout used during collection. Recorded and timing source versions remain separate; hashing reconstructed content reproduces every archived source digest.

Inference runs sequentially on an AMD Ryzen 7 5825U, Linux x86_64, CPU only, two intra-op threads and one inter-op thread. Both runtimes remain loaded in one process. Its peak RSS therefore does not measure either runtime alone. The benchmark does not test Apple hardware, WebGPU, quantization or GPU inference.

The server uses the official strict encoder, `maxLength=8192`, `head_length=1536`, batch size one and the CPU marker-only head. The combined input limit is 8,192 tokens; each option has a 48-token contract. Overflow fails explicitly. ONNX uses the same encoder and tensor layout with CPUExecutionProvider and FP32. Backend errors never invoke a different selector.

## Observation replay

The [original cases](2026-09-29-julia/decision-cases.json) contain 52 retrospectively selected decisions from the September 24 evidence. They comprise 40 local actions, 11 fact checks and one completion check. An expert supplies the local question and observed alternatives. The cases are correlated and were selected after the original workflows; they are not a held-out sample of arbitrary websites.

Four initial configurations make 208 requests: supplied full state with torch; a word-ranked state projection with torch or ONNX; and the same torch projection with cyclic option rotation. "Full" means the supplied case state, which already uses a page-body prefix and a candidate inventory. It does not mean the entire DOM. [Initial results](2026-09-29-julia/initial-replay-results.json) preserve contract rejections and historical labels.

The [label audit](2026-09-29-julia/label-audit.json) records six cases with multiple acceptable choices, three numeric-evidence losses in the original projection, and two ambiguous cookie questions. Historical and semantic scores remain separate. Gold labels, acceptance sets and provenance never enter model requests.

The [natural descriptions](2026-09-29-julia/natural-decision-cases.json) shorten the same option descriptions without changing their order or the original questions. This is a post-hoc representation experiment, not a new independent dataset. Its three configurations make another 144 requests:

- `full` retains the supplied state.
- `target-state` retains all candidate-control entries and tabs, but limits the action-case body prefix to 500 characters. Fact and completion states stay unchanged.
- `local-router` tests only the 40 actions. It supplies the title, URL, original goal, expert local question and candidate descriptions; the page body and DOM are explicitly omitted.

The public exports include exact prepared-state hashes and reconstructed request hashes. The old drivers saved input rows rather than independent network captures. The new replay CLI saves the exact POST body before transmission. Replay percentiles use sorted index `min(n-1,floor(n*q))`; the reported median is the upper middle value for even sample sizes.

## Live comparison

Both arms use agent-browser 0.38.1, fresh logged-out Edge 154 profiles, 1280 by 800 pixels and a light theme. Luna uses max reasoning and the acknowledged Fast/priority setting through the existing ChatGPT subscription. No OpenAI API key is used. One fresh model thread persists throughout each trial, with the same initial instruction and observation policy in both arms.

The eight frozen [tasks](../browser-lab-tasks.ts) cover GitHub issue filters and an author tab; latest release and ZIP download; Google Maps walking directions; Amazon variants and sellers in two tabs; Booking dates and hotel filters; YouTube duration and description; Wikipedia language, history and NASA tabs; and Google Flights dates, party, nonstop legs and total. Each task has three independently reviewed requirements. Arm order alternates by frozen task offset. There are 18 collected attempts: the original 16 and two paired Maps replacements. Both original Maps attempts remain published but are excluded from the primary 16 because Julia's browser failed before any model decision. Replacement trials use the same 13 archived source hashes. Ordinary runtime failures after decisions remain in the primary denominator.

The planner proposes 2 to 12 distinct, grounded single-action commands, neutral descriptions and its preferred index. `candidate-model` executes that preference. `candidate-julia` executes Julia's choice. Candidate order is deterministically shuffled without using the preference; that preference and the command objects are withheld from Julia. Both arms pay the candidate-generation cost. This design tests replacing selection after planning, not replacing Luna or saving its generation cost.

The execution budget is 180 seconds, at most 60 actions and 80 decisions. Invalid candidate proposals execute nothing and allow at most two consecutive corrections within the same budget. Current references and tabs must match the latest observation; exact previously delivered URLs can be reused within the permitted task domains. Selector errors end the trial without fallback. Readiness checks respond to document signals with a bounded timeout; they do not silently replay actions.

Luna receives text and actual screenshots. Julia receives the goal, immediate subgoal, factual memory and a scoped text observation. The scope preserves all candidate-target snapshot lines and adjacent lines, rejects target-context overflow, and separately limits other text. It records every omission. The raw evidence stays available to the reviewer. This does not establish that all decision-relevant context survives projection.

Success requires three corroborated requirements, an actual completed model turn, an executed finish action, no terminal task error and clean shutdown. Obtaining evidence without delivering an answer is partial completion. A finish claim alone never grants success. Browser artifacts, capture IDs and hashes accompany each criterion. The tool audit explicitly allows only `choose_action` for this cohort.

Live timing medians use the arithmetic mean of the two central values for even samples, as in the existing live reporter. Failures stay in all-attempt timing. Startup and execution are separate. One repetition cannot establish a production success rate or a general model ranking.

## Recordings and exclusions

Timing trials run without an encoder. Separate instrumented trials use actual CDP screencast events at normal speed, holding the last real frame while the page is static. They begin after the initial observation, before planner actions. They contain no reconstructed action replay, synthetic cursor or accelerated waiting. Instrumented timings are not mixed with the main comparison.

[Recording evidence](2026-09-29-julia/recording-evidence.json) records the four actual video hashes, frames, target transitions and encoder results. It also preserves all five fresh probes after the final recorder repair, including the two initial readiness failures. Recorder probes do not invoke either selector.

The [12 engineering preflights](2026-09-29-julia/engineering-preflights.json) remain separate from scored trials. The initial pilot had invalid reference and URL handling. Two later recorded starts failed before planning on screencast initialization or a capture timeout; their companion trials were deliberately stopped. These are infrastructure failures and cancellations, not Julia accuracy measurements. Recordings with encoder errors or missing target transitions cannot serve as completion evidence.

## Reproduction

Install the pinned upstream Python package and checkpoint in an isolated environment, plus onnxruntime for the optional pinned graph. Create a private ASCII bearer-token file, owned by the current account and mode 0600 on Unix. Keep it out of tracked files. Start the persistent server:

```sh
python bench/browser-lab-julia-server.py --model <checkpoint-directory> --token-file <private-token-file> --threads 2 --onnx-model-dir <onnx-directory> --revision a85b127321d580d65176c89ced8273f305745d85
```

The default endpoint is loopback port 18884. Set `BOITE_BENCH_JULIA=1`, `BOITE_JULIA_TOKEN`, `BOITE_JULIA_BACKEND=onnx` and a fresh `BOITE_BENCH_OUTPUT`, then run `bun bench/browser-lab-julia-replay.ts`. `BOITE_JULIA_REPLAY_MODES`, `BOITE_JULIA_DATASET` and `BOITE_JULIA_CASES` select configurations, the original dataset or a case subset.

For live trials also set `BOITE_BROWSER_TEST_BINARY` to the pinned native executable and `BOITE_BENCH_CODEX_BINARY` to the supported subscription CLI. Run `bun bench/browser-lab-julia.ts`. `BOITE_BENCH_TASKS` selects frozen task IDs and `BOITE_BENCH_JULIA_MODES` selects arms. For a separate recording, set `BOITE_BENCH_RECORD=1` and `BOITE_BENCH_FFMPEG`. Processes run through the core registry; only owned groups are stopped.

The command output is a collection status, not a success score. Review the three requirements against saved evidence before publishing a comparison. Stop the temporary server and remove its token and environment after the experiment.
