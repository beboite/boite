# Browser controllers on large public sites

The four-arm comparison completed 64 scored attempts on eight workflows. Playwright completed 13 of 16 with either DOM-only or DOM plus screenshots. Native agent-browser completed 8 of 16 with DOM-only and 11 of 16 with screenshots. These are complete workflow results, not successful clicks or model claims.

All arms used GPT-6 Luna, max reasoning, priority service, the existing ChatGPT subscription, fresh logged-out Edge 153 profiles, a 180-second execution budget and at most 60 actions. Installed versions were agent-browser 0.38.1 and Playwright 1.63.0. Read the [protocol](2026-09-24-browser-lab-protocol.md) for task limits, model transport, source freezing and exclusions. [Per-attempt results](2026-09-24-browser-lab.json) contain all criterion decisions, viewed capture IDs, evidence hashes, usage and cleanup checks.

## Completed workflows

Each cell has two attempts. A pass requires all three task requirements, an actual completed model turn, no task error, and clean shutdown.

| Workflow | Native DOM | Playwright DOM | Native with vision | Playwright with vision |
| --- | ---: | ---: | ---: | ---: |
| GitHub issue filters, comment ordering and author tab | 2/2 | 2/2 | 2/2 | 2/2 |
| Latest release, date and actual ZIP download | 0/2 | 2/2 | 0/2 | 2/2 |
| Google Maps walking route and distance | 2/2 | 2/2 | 1/2 | 2/2 |
| Amazon product variants, prices, sellers and two tabs | 2/2 | 2/2 | 2/2 | 2/2 |
| Booking dates, party, rating filter and hotel results | 0/2 | 0/2 | 0/2 | 0/2 |
| YouTube filters, duration and expanded description | 0/2 | 1/2 | 2/2 | 2/2 |
| Wikipedia language, revision history and NASA source | 2/2 | 2/2 | 2/2 | 2/2 |
| Google Flights round trip, two adults and nonstop legs | 0/2 | 2/2 | 2/2 | 1/2 |
| Total | 8/16 | 13/16 | 11/16 | 13/16 |

The original eight Wikipedia attempts are retained but excluded from scoring in every arm. A benchmark socket listener incorrectly closed large native responses. A separate matched eight-attempt rerun with an independent connection passed all eight. The table combines 56 eligible original attempts and those eight corrected attempts; their source hashes and cohorts remain separate in the JSON. There were 72 collected attempts, not 64 flawless setups.

## Time and model usage

| Configuration | Median of all 16 attempts | Median of successful attempts | Requirements met |
| --- | ---: | ---: | ---: |
| Native DOM | 126.8 s | 75.3 s | 28/48 |
| Playwright DOM | 93.0 s | 56.9 s | 40/48 |
| Native with vision | 81.2 s | 57.2 s | 37/48 |
| Playwright with vision | 73.0 s | 66.0 s | 41/48 |

Times include browser startup and task execution, with final capture and cleanup separate. Failures stay in the all-attempt median. Successful-only medians describe different subsets and cannot establish a speed ranking by themselves. Two lanes shared network and subscription capacity. Two repetitions are insufficient to estimate a dependable production success rate.

Reported cumulative token usage across the 16 attempts was 30.0 million for native DOM, 29.8 million for Playwright DOM, 22.7 million for native vision and 23.2 million for Playwright vision. Between 89% and 91% of reported input tokens were cached. These are repeated inference input counts, not unique context size or a subscription dollar cost.

## What failed

Native ZIP download cancellation was reproducible with Windows extended destination paths. A separate ordinary-path CDP adapter subsequently downloaded and hashed the actual ZIP using the native click, without Playwright. Edge's downloads hub could also become the selected target; pinning the original page fixed that part independently. The [diagnostic report](2026-09-24-browser-diagnostics.md) keeps the four-way path experiment separate from autonomous results.

The Booking searches lost their dates after submission in every original arm. A deterministic UI probe reproduced a server redirect from the correctly populated search request to a destination-only URL and then a generic city page. The evidence does not establish why Booking redirects this environment. Changing a selector or assigning a larger model is not a demonstrated fix.

Other failures were task-specific: a walking answer gave an unsupported distance, YouTube filter recovery lost a required filter, flight-row controls were covered despite existing in the DOM, and one correct-looking itinerary omitted the requested nonstop filter. Screenshots and coordinates recovered some covered-control cases. Neither engine had universal coverage.

Playwright evidence capture logged 25 observation errors across its 32 scored attempts, including screenshot timeouts. Native evidence capture logged none in the corrected baseline. The later direct-CDP capture prototype has separate results; the local font regression alone does not establish reliability on real sites.

## Other tested designs

[Browser Use and Stagehand probes](2026-09-24-browser-frameworks.md) used their own orchestration. Browser Use completed 2/8 full workflows. Stagehand's compatibility attempts and usable phase probes did not establish a complete workflow. Their context, launch versions and repetition counts differ from this comparison, so their times are not a matched ranking.

A fresh Luna thread per decision with at most 6,000 characters of explicit memory completed 5/8 workflows. Its median was 164.5 seconds and total reported usage was 1.80 million tokens. It repeatedly re-observed loading release assets and failed to finish the Amazon comparison. Lower context use did not produce a faster or more reliable default in this trial. This prototype also changed capture and prompts; it is not an isolated test of memory length. [Prototype evidence](2026-09-24-browser-prototypes.json) retains its eight attempts separately.

The corrected native controller with Luna completed 6/8 workflows, with a 75.8-second median and 20/24 requirements satisfied. The ZIP was downloaded, but Luna gave a release date unsupported by its observations. Booking failed with both repeated redirects and capture errors. This candidate adds direct capture and the native download correction to the independent transport; it is a separate one-repetition cohort.

For this native candidate, Maps took 52.8 seconds while logged browser commands summed to 1.6 seconds. Flights took 90.1 seconds with 2.9 seconds in those commands. The remaining time includes model turns, observation delivery and asynchronous work. These measurements do not attribute all residual time to inference, but they rule out command execution as the dominant measured cost in those two runs.

The same corrected native controller with GPT-6 Astra, max reasoning and priority service completed 7/8 workflows, with 21/24 requirements satisfied and a 70.9-second median. Its seven successful attempts had a 57.9-second median. Only Booking failed; Astra reported the missing results instead of returning hotel prices from an unrelated page. It observed the release date that Luna had failed to establish. Reported usage was 9.73 million tokens, including 8.68 million cached input tokens.

| Separate prototype | Complete workflows | All-attempt median | Requirements met |
| --- | ---: | ---: | ---: |
| Corrected native controller, Luna max priority | 6/8 | 75.8 s | 20/24 |
| Same controller, Astra max priority | 7/8 | 70.9 s | 21/24 |
| Fresh decision threads, bounded memory, Playwright, Luna | 5/8 | 164.5 s | 18/24 |

The native Luna and Astra runs have identical controller source hashes and task limits, with one attempt per task each. They ran at different times with different concurrent activity. A one-workflow success difference and a 4.8-second median difference do not establish a general model ranking. The memory prototype changes more than the model and must remain a separate design experiment.

The integrated Computer Use reference was unavailable in this session, as documented in the protocol. The Astra trial uses this project's native/CDP controller and must not be labelled integrated Computer Use.

## Proposed plugin design

Keep agent-browser upstream and put the integration fixes in a small adapter. An independent native connection, explicit web-tab ownership and the ordinary-path download adapter repaired observed failures without a fork. Playwright remains a separately selectable controller with stronger baseline completion here. Attaching it midway through a native task changes download policy, so a transparent mid-task fallback is not yet validated.

Use the selected subscription model to own the whole browser task. Astra with the corrected native controller is the best candidate in this follow-up, with seven fully verified workflows; Luna remains a lower-success alternative in this small sample. Keep a conversation for the task rather than resetting the model after each decision. The bounded-memory experiment saved reported input but lost recovery history and was slower. Jev's narrow action chooser should not be the default general-web controller on the strength of its local form speed.

The host should own tabs, downloads, cancellation and capture independently of model decisions. A failed recorder must preserve the actual action outcome. A failed direct capture should fall back to the engine's screenshot and report degradation instead of repeating the same timeout. These recovery corrections have targeted regressions; they do not retroactively improve any campaign score.

Completion needs saved state that supports the requested facts, including the exact dates, selected filters, chosen variant or actual downloaded file. Keep an explicit incomplete result when those facts cannot be established. Booking remains unresolved in both Edge and Helium; no tested controller in this experiment completed that workflow. A reused authenticated profile, a remote browser or a human handoff are possible next investigations, not demonstrated fixes.

These are proposals for the general browser plugin. The installed Jev capability still has the narrower bounds in [browser automation](../../docs/browser-automation.md). Authenticated applications, uploads, canvas editors, CAPTCHA, native dialogs and arbitrary website coverage have not been validated by these eight workflows.
