# Browser framework probes

Browser Use 0.13.10 completed two of eight complex public-site workflows with GPT-6 Luna, max reasoning and priority service through the existing ChatGPT subscription. Stagehand 4.1.0 did not complete its shorter GitHub investigation. These exploratory probes use the frameworks' own prompts, observations and orchestration; they are not matched speed comparisons with [the four-arm engine experiment](2026-09-24-browser-lab-protocol.md).

![Ten seconds from the real Browser Use investigation, at original speed](https://pub-15ca30b4efbf4285a292416a3e0e6c38.r2.dev/202609/cd036c2e503d307924ec97db539e7812/browser-pr.gif)

[Watch the complete 147-second recording](https://pub-15ca30b4efbf4285a292416a3e0e6c38.r2.dev/202609/fae1d21c956c6f37d774633496804c58/browser.mp4). It retains waiting time and follows the selected tab. A newly opened tab may finish its first load before recording attaches. The recording contains no replayed actions or synthetic cursor.

## Browser Use

Each workflow had a 180-second framework budget, a fresh logged-out browser and at most 15 steps. The caller created a fresh ephemeral Codex thread for each inference, with the framework's message history, schema and screenshot. Unlike the main experiment, these threads inherited ordinary global context. Completed and interrupted model events are retained.

| Workflow | Mandatory criteria met | Framework seconds | Observed outcome |
| --- | --- | ---: | --- |
| GitHub issue and author profile | 3/3 | 145.22 | Correct closed Chromium issue, descending comment order, 40 comments, linked profile and both tabs retained. |
| GitHub source archive | 3/3 | 76.18 | Latest stable release and date observed; saved ZIP contains 42,612,768 bytes and the ZIP signature. Download metadata identifies the release referrer and codeload source. |
| Google Maps walking route | 2/3 | 178.04 | Correct route and detailed walking steps visible, 1 h and 4.4 km; no final answer before the deadline. |
| Amazon product comparison | 0/3 | 180.56 | Repeated service-error pages, then search results for one mouse; no two product tabs or complete comparison. |
| Booking hotel filters | 0/3 | 180.81 | Date selection repeatedly returned to the city page; no exact-date filtered results or total stay prices. |
| YouTube filters and description | 1/3 | 180.37 | Correct search and both filters selected; no opened video or expanded description. |
| Wikipedia language, history and source | 0/3 | 181.46 | Apollo 11 opened, but the language control did not produce a French article; no history or NASA tabs. |
| Google Flights round trip | 0/3 | 178.50 | Passenger and date controls partly filled; date picker remained open, with no submitted nonstop search or selected itinerary. |

Only complete workflows count as successes: 2/8. The separate diagnostic count is 9/24 mandatory criteria. Eight probes recorded 80 inference calls and 2,062,272 tokens from available usage events, including five interrupted calls. There is no inferred subscription dollar cost. Every owned process group reported zero after cleanup. An independent reviewer opened saved captures and checked the framework history and downloaded bytes; framework success flags alone were insufficient.

The original Maps attempt failed before inference because an exact `google.com` domain entry excluded `consent.google.com`. That adapter failure remains recorded separately. The corrected attempt used exact hosts plus documented subdomain patterns. The ZIP trial used agent-browser 0.37.1 to launch its browser; subsequent batch trials used 0.38.1. Browser Use operated through its own CDP controller. The earlier GitHub probe preceded viewport/theme normalization. Some probes overlapped other work, so elapsed times do not establish a framework ranking.

## Stagehand

The compatibility probes first failed at CDP extension-origin access, callback schema validation and extension initialization. Using Stagehand's own launch flags on an isolated browser and navigating after initialization allowed real actions. No user browser configuration changed.

An initial usable attempt applied the GitHub query and extracted a result title, but remained on the issue list after reporting that it had opened the issue. A second attempt added explicit post-action verification and one retry per phase. It again failed to open the issue: 20 calls, 189.47 seconds and 385,279 reported tokens. The verifier rejected the false completion. These results cover one workflow; they do not establish that Stagehand cannot perform other tasks.

The opt-in adapters are [the TypeScript bridge](../browser-lab-alternatives.ts), [Browser Use runner](../browser-lab-alternatives.py) and [seven-task batch](../browser-lab-alternatives-batch.ts). TypeScript checks and Python AST parsing passed. The production browser plugin is unchanged by these probes.
