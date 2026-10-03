# Voice dictation

The microphone beside Send records a draft, for any agent. Finish inserts the
transcript after the current text, including text typed while recording. It
never sends a prompt. Escape or Cancel discards the recording. Switching
conversations, leaving the page or hiding the app cancels microphone capture.
Recordings last at most two minutes. A failed transcription can be retried
while the composer remains open; audio stays in memory until retry or cancel.

The microphone remains in the toolbar during recording; press it again to
finish. With Nemotron Streaming, a compact preview receives new audio every
400 ms, subject to engine latency. Each sample is uploaded once, including
silence. Finish waits for the current chunk, sends the remaining audio and
drains the decoder's lookahead. It does not transcribe the recording again.
Provisional text replaces the preview and never edits the typed draft.

Whistle, Whisper and API mode use separate preview transcriptions. Whistle
refreshes approximately every second over the latest four seconds. Whisper
refreshes every 1.5 seconds over at most twelve seconds; API mode every 2.5
seconds. Only one request runs at a time and silence skips batch previews.
Finish cancels and drains a batch preview before transcribing the full
recording. API mode sends these additional requests while recording. A failed
preview pauses further previews and shows the error; the recording remains
available for retry.

Once a local preview has heard the language, the next previews and the final
request pass it back, which skips whisper's language detection. A language set
in Voice settings wins over the one heard.

On phones, the composer keeps one row for message options, model, microphone
and Send. The plus button opens image attachments, reasoning, permissions and
the draft's worktree switch. While recording, Cancel and Finish replace Send;
the transcript stays above these controls. Back or Escape closes the options
panel without losing the draft.

## Set it up

Open Settings, Voice on the machine hosting the conversation. The line at the
top says whether dictation works now and, when it does not, offers the one
action that fixes it: Set up dictation downloads the local engine, Try again
restarts a failed download, Save to repair rewrites an unreadable
`speech.json`, Update replaces a runtime installed before whisper-server was
part of it. New configurations use Local with Nemotron Streaming; existing
choices remain selected. On supported platforms a single click downloads the
model and native runtime. The microphone beside Send links to this page
when the engine is not ready. Explanations sit behind the (i) beside each
label.

Voice dictation can be turned off on each device from this page, even when the
core has an installed model. Turning it off removes the microphone from the
message bar and cancels any capture or transcription running on that device.
The model and engine configuration remain available for turning it back on.

The engine, the API provider, the fallback, the language and the model apply as
soon as they change. API keys and local paths have their own Save button, so a
half-typed key is never sent. The Save keys button shows only once a key is
typed. A machine whose core predates dictation answers
`speech.status` with MethodNotFound; the page and the microphone then name that
machine and ask to update Boite there, instead of showing the RPC error.

Its owner chooses the engine and credentials. Paired phones dictate through
that same core, but cannot change its configuration, install executables or
read local paths.

## Engines

- Local runs the selected engine on the core's machine, with no cloud fallback.
  Nemotron downloads sherpa-onnx 1.13.8 on Windows x64, Linux x64/ARM64 and macOS
  x64/ARM64. Whistle downloads Needle on Windows x64/ARM64, Linux x64/ARM64 and
  macOS ARM64. Whisper downloads its pinned CPU runtime v1.9.2 on Windows x64;
  other platforms use `whisper-cli` on PATH or the executable in Local paths.
  A model path set by hand always uses Whisper. Paths refer to the core,
  never the phone. See [Models](#models) and [Resident server](#resident-server).
- API supports Groq `whisper-large-v3-turbo` and OpenRouter
  `openai/whisper-large-v3-turbo`. Groq accepts multipart audio; OpenRouter accepts
  JSON with base64 `input_audio`. Optionally try the other provider on failure
  when both keys are configured. There is no speculative duplicate request.
  Calls have a 60-second provider deadline.

## Models

The Model card offers two newer engines and the existing Whisper models.
Each artifact is pinned by immutable revision or version, size and SHA-256:

| Model | File | Size |
| --- | --- | --- |
| Nemotron 3.5 Streaming (default) | Encoder, decoder, joiner and tokens | 682 MB |
| Whistle | `whistle.cact` | 17 MB |
| Whisper Base | `ggml-base-q5_1.bin` | 60 MB |
| Whisper Small | `ggml-small-q5_1.bin` | 190 MB |
| Whisper Large v3 Turbo | `ggml-large-v3-turbo-q5_0.bin` | 574 MB |

Nemotron supports French and incremental decoding with a 560 ms acoustic
window. Its native decoder runs in a separate traced process, limited to four
CPU threads, so inference cannot block the core's RPC event loop. It loads
lazily, stays resident between dictations and stops after 150 seconds idle,
on cancel, disconnect, model changes or core shutdown.

[Whistle](https://cactuscompute.com/blog/whistle) supports English, German,
French, Spanish, Italian, Dutch and Polish. It is a batch engine rather than
a causal streaming model. Long recordings use 25-second windows with a
one-second overlap, joining shared words. Each window runs with at most four
threads. Whistle does not need a resident server.

One model is in use at a time. Picking one already downloaded uses it at once;
picking one that is not downloads it, then makes it the model in use. Each
downloaded model has its own remove button; removing the model in use hands over
to another downloaded one, or back to the default when none remains.

Add from a link takes an `https://` URL to any whisper.cpp ggml model, such as
a Hugging Face `resolve` link. A link has no known size or digest, so the core
checks what it can instead: the file must start with the ggml magic and a
Whisper header (audio context 1500, text context 448, 80 or 128 mel bands),
must not redirect to plain HTTP, and must weigh at most 4 GiB. A Hugging Face
`blob` page, a GGUF file, a voice activity model or an HTTP error is refused
with the reason in Voice settings, and leaves no entry behind. The link is
downloaded under `<dataDir>/speech/custom/`, named `custom-` plus the first 12
hex digits of the URL's SHA-256, and resumes like the catalogue models.

A model path set by hand in Local paths wins over the list, which then shows
no model in use.

`speech.install {model}` or `speech.install {url}` starts a download,
`speech.uninstall {model}` removes one model and `speech.uninstall {}` removes
the runtime and every model Boite downloaded.

## Resident server

When the runtime has `whisper-server` beside `whisper-cli`, the core keeps one
loaded model instead of starting a process per request:

- It listens on 127.0.0.1 only, on a random port, under a random request path,
  so another local process cannot reach it by guessing.
- It starts when recording starts (`speech.warm`, available to paired devices),
  so the model loads while the user speaks, and stops after 150 s without a
  request, when the model or runtime changes, and when the core stops.
- It runs with `max(min(4, cores), min(8, cores / 2))` threads, no GPU, and no
  timestamps. A preview limits the encoder to the audio it holds
  (`audio_ctx = seconds * 50 + 64`, at most 1500); the final request keeps the
  full window.
- A disconnect or a cancel aborts the decode on the server.

A runtime without `whisper-server`, and any `whisper-cli` set by path, runs one
process per request as before, with the same thread count.

Measured on 2026-09-26 on a 16-thread Ryzen 7 9800X3D with Whisper Small Q5_1,
median of five runs over RPC: the final transcription after Stop went from
5514 ms to 1419 ms for an 11 s English clip, and from 5914 ms to 1518 ms for an
8 s French clip. A preview with the heard language takes about 0.6 s.

## Language

An empty language selects automatic detection. A two-letter code such as `fr`
or `en` requests that language. Every change is written to this core at once.
Changing it invalidates recordings started under the previous configuration, so
a local recording cannot silently become a cloud request.

Keys live in `<dataDir>/speech.json`, outside the journal, with restrictive file
creation permissions. Configuration reads never return key values. An empty
key field preserves the saved key; Remove key deletes it on Save keys. Cloud mode
sends audio to the provider, whose own retention policy applies.
An invalid `speech.json` disables dictation and reports its error in Voice
settings without preventing core startup. Save to repair writes the choices
shown; the invalid file is left untouched until then.

## Microphone and HTTPS

Capture uses Web Audio and a same-origin AudioWorklet, with mono 16 kHz PCM WAV
sent over authenticated RPC. The UI and server both enforce the size limit.
The microphone is never played through speakers. No browser speech-recognition
service is used.

Browser microphone access requires the [secure origin](phone.md#https-and-installation)
used for phone setup; a LAN HTTP address does not qualify, while localhost does
for development. Permission is requested only after pressing Dictate or Test
microphone. A denial explains how to retry. Silent
or very short recordings are refused before uploading.

Settings > Voice also selects the microphone on the current device, including
paired phones. System default follows the OS input; an explicit choice uses
that input for dictation and the test. An unavailable selected input reports an
error instead of silently recording a different one. The input level meter
reads local audio without recording, uploading or transcribing it. Stop test,
turning off Voice, leaving the page or hiding the app releases capture.

## Lifecycle and limits

`speech.status`, `speech.transcribe`, `speech.cancel`, `speech.warm` and the
stream start/chunk/finish methods are
available to paired devices. Configuration, download and removal methods are
owner-only. Cancellation is
scoped to a connection and request ID. Disconnecting aborts its active request.
At most two API transcriptions or one local transcription run at once; extra
requests fail visibly and can be retried. A stream holds the same local decoder
reservation, requires ordered sequence numbers and accepts at most two seconds
per chunk. Its final tail may be longer. Both paths enforce two minutes of
audio and invalidate old configuration revisions. The full request expires after three
minutes. Transcription does not occupy an agent turn or alter a native session.

The core validates audio before spawning or calling a provider. It does not
journal audio or transcripts. Local WAV and output files are removed in a
`finally` block; a restarted core removes its own abandoned audio directories.
Local processes, the resident server included, use `procs.spawn` under a
synthetic speech ID. Catalogue downloads check byte length and SHA-256, links
check the Whisper header; all write partial files and only publish completed
artifacts. A download has no total deadline: it gives up after 60 s without a
byte. A dropped or silent connection keeps the partial file, and installing
again asks the server for the rest with a `Range` header; a server that sends
the whole file instead starts the file over. A retry keeps a runtime already
unpacked. A wrong size or digest, and a cancel, remove the partial file.
No model loads at core startup; the first `speech.warm` or local transcription
loads it.

## Verification

```sh
bun test packages/core/test/speech.test.ts
bun test packages/core/test/speech-streams.test.ts packages/core/test/speech-assets.test.ts
bun test tests/e2e/speech.test.ts
```

Core tests cover both API payloads, fallback, credential redaction, phone
authorization, stale configuration and cancellation over real RPC, plus the
model list, link refusals and the resident server against a fake
`whisper-server` (`packages/core/test/fixtures/whisper-server.ts`); no test
downloads anything. Browser
tests drive the actual recorder, AudioWorklet and resampler with a synthetic
microphone, capturing desktop and phone layouts. Hardware permissions and
mobile OS suspension still need device testing.

`BOITE_E2E_SPEECH_LOCAL=1 bun test packages/core/test/speech.local.live.test.ts`
downloads the real runtime/model into a temporary directory, transcribes the
upstream JFK fixture, checks the text and removes the managed files. It does
not call a cloud API. Cloud tests use substituted responses and do not
establish live credentials or provider availability.

`BOITE_E2E_SPEECH_NATIVE=1 bun test packages/core/test/speech.native.live.test.ts`
downloads and verifies the real Nemotron and Whistle artifacts in a fresh
temporary data directory, transcribes a public French fixture, checks text
arriving before Finish, and removes the managed files. It prints
`NATIVE_SPEECH_MEASURED` with first-text and finalization latency. On 2026-10-03,
the 6.85-second fixture produced first text after 1842 ms and finalized in
211 ms after Finish on Linux x64. These are one-clip observations, not a
language accuracy benchmark. Native Windows/macOS decoding and physical-phone
microphone permissions need separate device testing.
