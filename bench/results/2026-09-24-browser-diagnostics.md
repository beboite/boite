# Browser integration diagnostics

These 2026-09-24 diagnostics explain failures seen in the [large-site experiment](2026-09-24-browser-lab-protocol.md). They are deterministic probes, not autonomous task successes.

## Native ZIP downloads on Windows

Four fresh, hidden Edge 153 profiles used native agent-browser 0.38.1 clicks on the same observed Playwright release asset. A separate CDP connection configured the destination before the click and matched download events by GUID.

| CDP route | Destination path | Result | Saved bytes |
| --- | --- | --- | ---: |
| Browser root | Ordinary absolute path | Completed | 42,612,768 |
| Browser root | Windows extended path | Canceled | 0 |
| Active page | Ordinary absolute path | Completed | 42,612,768 |
| Active page | Windows extended path | Canceled | 0 |

Both successful files have ZIP signature `504b0304` and SHA-256 `a5e93fab1a07523554337ee1e759681c9b3b5038ff184811edea59a61b4bde03`. All four browser process groups ended at zero. Four earlier attempts stopped before clicking because GitHub had not loaded Assets; those setup failures remain in the evidence.

The native implementation [canonicalizes the destination parent](https://github.com/vercel-labs/agent-browser/blob/v0.38.1/cli/src/native/actions.rs#L7568) before [passing it to CDP](https://github.com/vercel-labs/agent-browser/blob/v0.38.1/cli/src/native/browser.rs#L2207). The probe reproduces the Windows extended path form explicitly. This establishes that path spelling can cause the cancellation in this Edge configuration; routing alone did not explain it. It does not establish behavior in other Chromium versions or UNC paths, nor capture the daemon's original CDP request.

The [candidate adapter](../browser-lab-download.ts) uses an ordinary destination path, the native observed-ref click, and matching frame/GUID events. It pins the original web target to avoid Edge's downloads hub becoming the active page. It verifies and copies the actual downloaded file; it does not fetch the ZIP through another HTTP client or attach Playwright. Its separate live smoke saved the same 42,612,768-byte ZIP and hash, retained the original 1280 by 800 light-mode page, and cleaned up every owned process.

`BOITE_BENCH_DOWNLOAD_PROBE=1 bun run bench/browser-lab-download-probe.ts OUTPUT BINARY` runs the four-way diagnostic. `BOITE_BENCH_PIN=1 BOITE_BENCH_NATIVE_DOWNLOAD_FIX=1 bun test bench/browser-lab-pin.test.ts` exercises the adapter with the configured native binary and output directory. The live smoke passed 11 assertions; the adapter's five unit tests passed 21 assertions. All final captures were opened.

## Booking search redirects

A separate [scripted diagnostic](../browser-lab-booking-probe.ts) selected Paris, 12-15 October 2026, two adults, zero children and one room. Its recorded document request contained those exact values. The server returned HTTP 301 to a destination-only search URL, then another HTTP 301 to the generic Paris city page. That page had cleared the dates. The before/after captures were opened, and cleanup was zero.

This reproduces the reset without model decisions. It does not prove whether the cause is browser identity, profile state, site policy or another server condition. Three earlier diagnostic attempts stopped at destination selection or a late sign-in overlay; they are retained as script setup failures. The final diagnostic handled the observed consent and sign-in buttons before submitting. No account was used and no reservation was made.

One further diagnostic used a fresh, hidden and muted Helium 154 profile with the same form actions. Before the first navigation, it waited for the browser's component uBlock Origin to report `µBlock.readyToFilter === true`; the condition became true after 2,758 ms. The submitted document request contained the correct Paris destination, dates and occupancy. Booking again returned HTTP 301 to a destination-only search URL, then HTTP 301 to the city page with cleared dates. Both captures were opened and the owned process count ended at zero. Switching to this Helium configuration did not preserve the search. This scripted result does not establish an autonomous task success or identify why the server redirects the request.

## Capture waits

A local regression page left a web font request pending while visible fallback text rendered. Playwright's ordinary screenshot timed out after 5,001 ms. Direct CDP capture saved an actual 1280 by 800 PNG in 28 ms while the font was still loading. The capture was opened. This diagnoses the wait mechanism; it is not an Internet workflow speed comparison.

The [capture adapter](../browser-lab-capture.ts) records the currently selected target and retains its emulation session. The live regression passed seven assertions with zero remaining owned processes. Real-site candidate campaigns report their own timing separately.

The native-kernel Luna Booking attempt exposed a separate failure. After its selected page target changed, observations 006-019 produced 14 `Target.attachToTarget` timeouts of about five seconds each. Native state, snapshots and tab inventory continued to respond on the new target. The trial exhausted its 180-second budget; it remains a tool-error result. Two earlier viewport commands and one click also timed out. These failures are distinct from the server redirects reproduced by the scripted probes.

The frozen capture adapter keeps one startup WebSocket, does not reconnect or refresh its CDP URL, and does not check socket state before later sends. Close and error handlers reject pending requests, but a later send after an idle disconnect can still become a timeout. Late replies are discarded after the five-second request deadline. These are recovery gaps. The saved logs contain no socket or target lifecycle events that establish which condition caused this attempt's failures; a stale connection and an unanswered attach remain possible explanations. Native lifecycle records reported no browser relaunch. No cause is proven, and no frozen campaign source was changed to repair it.

## Corrections after the campaigns

After all scored campaigns ended, the default factory adopted the independent native connection and the duplicate corrected factory became a compatibility export. The launcher exposes a separate client socket for its owned TCP or Unix endpoint. An actual TCP fixture and a path-endpoint fixture both pass; the latter ran as a Windows named pipe here, not a Linux browser session.

The default factory's live Wikipedia regression read a 1,100,000-character native response and then another successful command while the launch owner's socket stayed open. A deliberately invalid capture target then exercised the new fallback: direct CDP capture reported its failure, and the original native screenshot saved a viewed 1280 by 800 PNG. Later captures use that fallback instead of repeating the broken adapter. Only screenshots are retried; no page action is replayed. Cleanup ended at zero.

The recorder now records its own follow-target errors without replacing the wrapped action's result or error. Its regression and the capture fallback regression both failed before their fixes and passed afterward. These changes are included in subsequent recordings, not retroactively counted in any scored campaign. `bun test bench/browser-lab-capture.test.ts bench/browser-lab-recording.test.ts` passed 11 assertions across two unit tests. The live native transport and capture-fallback check passed 20 assertions across six tests.
