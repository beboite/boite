# Luna max Fast on public websites

On 2026-09-24, 120 fresh-profile trials compared GPT-6 Luna at max reasoning
and Fast with Jev followed by the same Luna pilot. Both policies passed 43/60
frozen automatic checks. This does not establish reliable general web automation.
The production plugin still uses Jev; the Luna policies are benchmark prototypes.

| Measure | Luna direct | Jev then Luna |
| --- | --- | --- |
| Frozen automatic passes | 43/60 (71.7%) | 43/60 (71.7%) |
| Median, all measured attempts | 35.25 s | 22.89 s |
| p90, all measured attempts | 67.44 s | 95.46 s |
| Attempts with total time recorded | 60/60 | 59/60 |
| Median, successful attempts only | 33.97 s | 3.92 s |

Jev finished 27 hybrid attempts without Luna; all 27 passed. Luna was needed
on 33 attempts, and 16 passed. Successful fallback attempts took a median
31.36 seconds. The low hybrid success median comes from the Jev-only tasks.
Both policies passed the same 41 task/repetition pairs; on that matched subset,
their medians were 32.86 and 4.09 seconds. Each policy had two exclusive passes.

## Live recordings

Four separate recording attempts produced three verified outcomes. The GIFs
are normal-speed excerpts; the complete success recordings include the waits.
The overlay labels actual commands and observed DOM events. These attempts
are excluded from the timing table; their [results are recorded separately](2026-09-24-browser-luna-recordings.json).

Hybrid BMI: Jev leaves the age at 75 and weight at 65; Luna restores the
requested age 35 and weight 75, then obtains BMI 23.1.

![Luna corrects the BMI fields after Jev](https://pub-15ca30b4efbf4285a292416a3e0e6c38.r2.dev/202609/942040342ed225748023fb8ec25f01f9/hybrid-calculatornet-bmi-1-pr.gif)

[Complete hybrid BMI recording, 33.5 seconds](https://pub-15ca30b4efbf4285a292416a3e0e6c38.r2.dev/202609/137473775af9e53e01c26162d310f29c/hybrid-calculatornet-bmi-1.mp4).

Direct BMI: Luna fills the requested values and submits the form.

![Luna fills and calculates BMI directly](https://pub-15ca30b4efbf4285a292416a3e0e6c38.r2.dev/202609/5f85beb8ac7eb1c6201542a53d1442ee/luna-calculatornet-bmi-1-pr.gif)

[Complete direct BMI recording, 23.7 seconds](https://pub-15ca30b4efbf4285a292416a3e0e6c38.r2.dev/202609/cf727150b7e1a8294526b065de05cd71/luna-calculatornet-bmi-1.mp4).

Direct W3C: Luna sets CSS and Recommendations filters and opens CSS Color 3.
The advanced section stays collapsed in this recording; the checks verify
submitted filter state and destination, not that every requested UI step occurred.

![Luna enters CSS and changes the W3C filter controls](https://pub-15ca30b4efbf4285a292416a3e0e6c38.r2.dev/202609/bc3b83f097a2269948a4729f8b1ad8b3/luna-w3c-css-recommendation-1-pr.gif)

[Complete direct W3C recording, 75 seconds](https://pub-15ca30b4efbf4285a292416a3e0e6c38.r2.dev/202609/356cf666bc4ece37a6ca26795127f133/luna-w3c-css-recommendation-1.mp4).
The hybrid W3C recording attempt fails with a closed browser connection.
Only [the first 41.3 seconds of that failed attempt](https://pub-15ca30b4efbf4285a292416a3e0e6c38.r2.dev/202609/63a90b2c2681f0e0d2282b571cff5896/hybrid-w3c-css-recommendation-1.mp4)
survive; recorder shutdown also fails. This partial clip is not its 90-second total.


## What the checks missed

The [per-attempt data](2026-09-24-browser-luna.json) preserves all 120 attempts
and their original pass bits. No failed attempt was replaced by a rerun.

- Python's language selector navigates to /fr/3.14/ while the frozen request
  and grader require /fr/3/. All four attempts selected French. Both direct
  captures show the translated basic-usage section; one hybrid attempt timed
  out while looking for the requested address. The scenario has a defective
  URL requirement, so these are not four clean model failures or four successes.
- All four Internet Archive captures show the requested search results.
  The body-text extraction is empty, so the text predicate fails despite
  the displayed results. These are verifier failures.
- Excluding both defective scenarios removes eight attempts and gives 43/56
  automatic passes per policy (76.8%). This filtered score is separate from
  the frozen score, and still has the visual limitation below.
- The second direct W3Schools color attempt passes its field and text checks,
  but its capture shows a consent dialog covering the result. A correct DOM
  state does not establish a completed visible workflow. This pass remains
  in the frozen data and is not presented as a clean visual success.

[Internet Archive results despite the empty extracted text](https://pub-15ca30b4efbf4285a292416a3e0e6c38.r2.dev/202609/5c9e676d57c5ec63b6139db70cfca98d/luna-archive-voynich-1.png),
[the French Python section at the versioned URL](https://pub-15ca30b4efbf4285a292416a3e0e6c38.r2.dev/202609/86d7ba5f9cb6b8645e14b59d2a5678b4/luna-python-json-french-1.png)
and [the consent dialog covering the passing color result](https://pub-15ca30b4efbf4285a292416a3e0e6c38.r2.dev/202609/8ca91522c1adc6e8501d8f171541163d/luna-w3schools-color-2.png)
provide the visual audit evidence.

## Remaining failures

npm, PyPI and both timeanddate tasks present anti-bot challenges. Neither
policy completes them. W3Schools navigation fails in all four attempts;
consent handling and the available page observations remain insufficient.

CalculatorSoup fails twice in direct mode after correct values and a click
on the Calculate submit control. A subsequent browser read times out and
the daemon connection closes. Jev completes both equivalent submissions.
The traces locate the failure after submission but do not prove its cause.
The second hybrid W3C attempt also loses its browser connection before Luna
can start. That attempt remains a failure and has no recorded total time.

The direct pilot passes the W3C filter workflow twice, including evidence
that the CSS search and Recommendations filter preceded the final document.
Both modes pass BMI, percentage calculation, Gutenberg pagination, Go section
navigation and WHO language switching twice. Hybrid fallback helps on these
tasks, but does not produce a higher overall automatic score in this sample.

## All workflows

| Site | Workflow | Direct | Hybrid | Direct successful median | Hybrid successful median |
| --- | --- | --- | --- | --- | --- |
| Wikipedia | wikipedia-hopper | 2/2 | 2/2 | 36.99 s | 3.43 s |
| Wikipedia | wikipedia-history | 2/2 | 2/2 | 28.75 s | 19.66 s |
| MDN | mdn-tosorted | 2/2 | 2/2 | 29.48 s | 4.17 s |
| MDN | mdn-array-french | 2/2 | 2/2 | 27.96 s | 3.75 s |
| Python documentation | python-pathlib | 2/2 | 2/2 | 50.10 s | 3.56 s |
| Python documentation | python-json-french | 0/2 | 0/2 | n/a | n/a |
| The Rust Book | rust-borrowing | 2/2 | 2/2 | 27.31 s | 1.80 s |
| Go documentation | go-effective-maps | 2/2 | 2/2 | 33.19 s | 37.79 s |
| npm | npm-zod | 0/2 | 0/2 | n/a | n/a |
| crates.io | crates-serde | 2/2 | 2/2 | 64.23 s | 3.61 s |
| PyPI | pypi-httpx | 0/2 | 0/2 | n/a | n/a |
| Project Gutenberg | gutenberg-pride | 2/2 | 2/2 | 18.96 s | 2.98 s |
| Project Gutenberg | gutenberg-austen-page-two | 2/2 | 2/2 | 25.25 s | 31.36 s |
| Standard Ebooks | standardebooks-frankenstein | 2/2 | 2/2 | 37.87 s | 2.77 s |
| Open Library | openlibrary-hobbit | 2/2 | 2/2 | 38.75 s | 19.38 s |
| Internet Archive | archive-voynich | 0/2 | 0/2 | n/a | n/a |
| Wikimedia Commons | commons-lunar-images | 2/2 | 2/2 | 44.30 s | 4.75 s |
| NASA | nasa-euclid-search | 2/2 | 2/2 | 37.36 s | 45.42 s |
| European Space Agency | esa-euclid | 2/2 | 2/2 | 38.63 s | 3.40 s |
| NHS | nhs-hay-fever | 2/2 | 2/2 | 48.19 s | 2.98 s |
| World Health Organization | who-physical-activity-french | 2/2 | 2/2 | 16.92 s | 23.81 s |
| timeanddate | timeanddate-leap-duration | 0/2 | 0/2 | n/a | n/a |
| timeanddate | timeanddate-calendar | 0/2 | 0/2 | n/a | n/a |
| Calculator.net | calculatornet-bmi | 2/2 | 2/2 | 31.29 s | 24.24 s |
| Calculator.net | calculatornet-percent | 2/2 | 2/2 | 14.01 s | 30.12 s |
| CalculatorSoup | calculatorsoup-percent | 0/2 | 2/2 | n/a | 3.46 s |
| UnitConverters.net | unitconverters-length | 2/2 | 2/2 | 23.93 s | 2.03 s |
| W3Schools | w3schools-color | 1/2 | 0/2 | 70.94 s | n/a |
| W3Schools | w3schools-startswith | 0/2 | 0/2 | n/a | n/a |
| W3C | w3c-css-recommendation | 2/2 | 1/2 | 88.99 s | 103.63 s |

The W3Schools color pass is covered by the visual caveat above. Section-text
checks establish page contents, not that the section occupies the viewport.

## Method and reproducibility

The [frozen protocol](2026-09-24-browser-luna-protocol.md) uses 30 workflows
on 23 public hostnames, two repetitions per policy, fresh logged-out profiles,
30 attempted actions and a shared 120-second execution budget. The second
pass reverses policy order and rotates task order. Twelve development pilot
attempts and separate video runs are excluded from the 120 timed attempts.

Browser startup and initial navigation count in reported total time. Evidence
capture and cleanup do not. The p90 uses the nearest-rank observation at
ceil(0.9 x n). One hybrid failure lacks total timing; the other 119 are measured.
The suite ran serially on Windows with Edge 153.0.4234.48, agent-browser 0.37.1
and Codex 0.156.1. One Codex app-server stayed warm; each Luna leg had a new
ephemeral thread. Its one-time process startup took 0.377 seconds and is
reported separately from task times.

The model catalogue and all 92 recorded Luna legs confirm gpt-6-luna,
max reasoning, priority service tier and the OpenAI provider. Authentication
uses an existing ChatGPT subscription. One of 93 requested Luna legs has no
record because the browser failed before handoff. Seven recorded legs hit
the time limit; 85 returned completed turns. No unexpected model tools ran.
All 120 browser process groups and the final Codex process group closed.

Luna receives rendered field metadata, searchable accessibility snapshots and
action batches. Jev uses its production candidate loop. This compares complete
pilots, not only their models. Direct URL navigation, arbitrary model scripts,
external tools and site-specific action recipes are unavailable. Login reuse,
cross-origin workflows, multiple tabs, files and native desktop control are
outside this test. The global Codex configuration, including hooks and MCP
startup, remained active; these times are not minimum model inference latency.

Reported model usage totals 16,820,531 input tokens, including 14,818,304 cached
tokens, and 122,924 output tokens. Uncached input is 2,002,227 tokens; reported
reasoning output is 103,203 tokens. Per-turn usage sums match the cumulative
totals. No dollar cost is inferred from subscription usage.

The campaign sources were frozen at commit b3a87cb. The data records hashes
for the runner, model transport, page adapter, task manifest, grader and Jev
loop. The production Jev loop is unchanged from the earlier evaluation.
Run the campaign using the protocol, then generate sanitized data with:

```sh
bun bench/browser-luna-report.ts --input RUN_DIR --output REPORT_DIR
```

The report command rejects incomplete runs unless --partial is supplied,
checks source hashes and requires final Codex cleanup evidence. Raw model
events stay private; the published JSON contains outcomes, settings, timings,
usage and cleanup counts. Adapter, grader and report regression tests run with:

```sh
bun test bench/browser-luna-page.test.ts bench/browser-wide-grade.test.ts bench/browser-luna-report.test.ts
bunx tsc --noEmit -p bench/browser.tsconfig.json
```

The [earlier Jev-only evaluation](2026-09-24-browser-wide.md) reported 38/84
valid attempts over three repetitions. Its criteria and denominator differ;
that percentage is context, not a directly comparable improvement figure.
