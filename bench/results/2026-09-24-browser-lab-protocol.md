# Large-site browser experiment

Campaign: 2026-09-24. This experiment replaces the narrow task suite for architecture decisions; it does not overwrite its results.

Eight workflows cover GitHub issue investigation with an author tab, a release archive download, Google Maps walking directions, two Amazon products, Booking hotel filters, YouTube search filters and expanded descriptions, Wikipedia language/history/NASA navigation, and a Google Flights round trip. Goals and three mandatory requirements per workflow are in [the task manifest](../browser-lab-tasks.ts). GitHub's label picker was inspected before freezing: the applicable label is `browser-chromium`, not an invented `bug` label.

## Comparison

Four arms use the same GPT-6 Luna model, max reasoning, priority service tier and ChatGPT subscription:

| Arm | Actions and observation | Images delivered to model |
| --- | --- | --- |
| agent-browser-dom | agent-browser native snapshot and actions | No |
| playwright-dom | Playwright AI snapshot and actions | No |
| agent-browser-vision | agent-browser native snapshot and actions | Yes, with coordinate clicks available |
| playwright-vision | Playwright AI snapshot and actions | Yes, with coordinate clicks available |

The current registry versions were checked before the campaign: agent-browser 0.38.1 and Playwright 1.63.0. Both passed the same live command smoke test. Playwright 1.63 exposes `ariaSnapshot({mode:'ai'})` publicly; the older 1.58 development probe used its internal predecessor and is not a campaign result.

Each workflow runs twice per arm, 64 attempts total, split between two concurrent lanes of four workflows. Lane A covers GitHub, Maps and Amazon; lane B covers Booking, YouTube, Wikipedia and Flights. Task order rotates between repetitions and arm order rotates between tasks. Shared subscription and network contention remain a timing limitation. Each attempt starts a fresh logged-out Edge 153 profile at 1280 by 800 with an explicit light color scheme. Both arms share the agent-browser-owned browser launch; Playwright attaches over CDP. This compares action and observation stacks, not independent browser launch infrastructure.

Playwright attachment also initializes its persistent context's download policy. It is not a passive connection. The native and Playwright ZIP results therefore compare their complete download implementations and policy setup on this Edge installation. They do not establish that the native implementation fails in every Chromium browser.

Each attempt has 180 seconds for execution and 60 attempted actions. Startup is timed separately and included in total time. Final capture and cleanup are separate. All completed failures and blocked attempts remain in the denominator. A slow successful retry will be a separate diagnostic, never a replacement for its original attempt.

The model can use observed links across the task's named domains, multiple tabs, keyboard, scrolling, forms and a public ZIP download. There are no site-specific locator recipes or model-authored scripts. Account changes, purchases, public messages and CAPTCHA completion are outside these tasks.

## Observation and verification

Every observation saves the full snapshot, DOM text, dialogs, visible link destinations, tab inventory and a viewport PNG. The model receives a bounded text view and can search the full observation. Shadow-root text is included. Both arms incur evidence screenshot capture; only the vision arms receive the image. The controller normalizes viewport and theme before each observation, then checks viewport dimensions, PNG dimensions and the dark-mode media query. A mismatch on the initial observation stops the campaign as invalid setup. A later mismatch rejects stale references and returns an error; recovery must produce a valid observation before another referenced action.

Two live transport probes found that native dynamic-tool image output was accepted but unreadable by Luna. Initial user images worked. A subsequent probe supplied independent random numbers only in screenshots and verified that both initial and later images were read correctly through `turn/steer`. All four arms therefore receive their callback observations through the same steering transport. Inherited MCP tools and plugins are disabled and checked per thread. Every main-campaign arm uses a temporary Codex home with a link to the existing subscription login, removed at shutdown. Child-only configuration clears developer personalization and limits skill context. Nine preliminary arithmetic turns compared ordinary context, overrides alone and an isolated home; these are context probes, not browser performance results.

Completion is reviewed against every manifest requirement, using the saved sequence and captures. The model's `finish` answer is a claim, not a pass. Review records each satisfied requirement and cites the observation that supports it. A CAPTCHA, missing required field, wrong itinerary, hidden result or missing file cannot be counted as complete. Site blocks and tool errors are classified separately without removing them from the success rate.

Timing uses all attempts with a recorded duration, plus a separate successful-attempt measure. Missing timing is reported explicitly. Usage comes from final cumulative model events. No subscription dollar price is inferred.

## Transport correction and follow-up experiments

During the first repetition, the native French Wikipedia snapshot exposed a benchmark transport bug. The benchmark borrowed the launch owner's TCP connection while its production receive listener remained attached. That listener closed the connection above 1,000,000 characters, even with no pending production request. A valid 1,099,970-character native response crossed that limit. This was a benchmark failure, not evidence that agent-browser could not read Wikipedia.

Before the second Wikipedia repetition was reviewed, all eight original Wikipedia attempts were excluded from scoring, including successful Playwright attempts. Their outcomes and captures remain in the report. The other 56 attempts keep their original cohort. A separate matched rerun repeats Wikipedia twice in all four arms using an independent TCP connection to the same daemon. The command implementations, observations, goals, model settings and limits remain unchanged. The correction has its own frozen source hashes. A live regression verified a 1.1-million-character response followed by another successful command, with no owned processes left after cleanup.

A further prototype tests a fresh model thread per decision, a bounded memory of at most 6,000 characters, and direct CDP viewport capture. It retains complete raw observations for review. This changes orchestration and capture together, so any measured improvement belongs to that combination. A local page with a pending web font reproduced a five-second Playwright screenshot timeout; direct capture produced a valid 1280 by 800 PNG in 28 ms. This fixture diagnoses a mechanism and is not a real-site speed result. Live prototype runs remain separate from the four-arm comparison.

## Other candidates and recordings

Browser Use and Stagehand receive separate compatibility and live-task probes through their own orchestration and the same Luna subscription. Their per-inference model lifecycle differs and must be disclosed before comparing latency.

The session's integrated Computer Use returned an empty browser inventory; hidden in-app creation returned `Browser is not available: iab`, and browser selection returned `No browser is available`. The separate Windows Computer Use package imported successfully, but its read-only window inventory failed with `Computer Use native pipe is unavailable` and OS error 2. Neither reference could execute a browser task. These are unavailable reference environments, not scored failures on the eight tasks.

Native agent-browser recording pins its initial page. Multi-tab demonstrations need a recorder that follows the selected CDP target. Recorded trials are separate from timing trials and retain real waiting time; interrupted captures are labelled partial. No accelerated clip is presented as elapsed performance.

The runner writes frozen source copies and hashes, versions, per-attempt evidence and explicit owned process-group cleanup counts. Sixteen development attempts are excluded: four initial transport/controller trials, four trials before correcting native references with preceding attributes, two before correcting the Playwright viewport reset and theme mismatch, and six before normalizing each observation after navigation or download failure. All sixteen remain excluded, including their successful outcomes. The GitHub goal was clarified before the main campaign to require the comment-count badge in the sorted issue list, rather than a count of currently loaded comment nodes.

The final real-page preflight passed 136 assertions across two tests. Both engines passed ordinary navigation and tab checks. A separate download characterization preserved a native failure: the ZIP navigation was cancelled, after which metrics remained unavailable following explicit Back and navigation. Playwright saved the 42,612,768-byte ZIP and passed ten rendering checkpoints. This known native failure stays eligible to fail the live task; the adapter does not replace the native download with another implementation. Development evidence remains available locally.

A later native trace identified `edge://downloads-hub/` as the automatically selected target behind those metric errors. Explicitly switching back to the original web tab recovered normal observations. The [native target filter](https://github.com/vercel-labs/agent-browser/blob/v0.38.1/cli/src/native/browser.rs) excludes Chrome internal schemes but omits `edge://`. A single separate [pin-tab probe](../browser-lab-pin.test.ts) used the supported `pinTab:true` setting: the original web target stayed active and the final capture remained 1280 by 800 in light mode, but the ZIP still failed with cancellation and no saved bytes. Pinning fixes the observed target-selection failure, not the download. This eight-second deterministic probe overlapped the two model lanes and is excluded from their latency comparison.
