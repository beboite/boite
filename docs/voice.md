# Voice dictation

The microphone beside Send records a draft, for any agent. Finish inserts the
transcript after the current text, including text typed while recording. It
never sends a prompt. Escape or Cancel discards the recording. Switching
conversations, leaving the page or hiding the app cancels microphone capture.
Recordings last at most two minutes. A failed transcription can be retried
while the composer remains open; audio stays in memory until retry or cancel.

The microphone remains in the toolbar during recording; press it again to
finish. A compact live preview inside the composer refreshes approximately
every 2.5 seconds, subject to engine latency. It transcribes at most the latest
12 seconds, replaces the provisional text, and never edits the typed draft.
Only one preview request runs at a time. Silence skips uploads; a failed
preview pauses further previews and shows the error. Finish cancels and drains
the preview before transcribing the full recording for the draft. These are
bounded repeated transcription requests, not a provider token stream; API mode
therefore sends additional requests while recording.

On phones, the composer keeps one row for message options, model, microphone
and Send. The plus button opens image attachments, reasoning, permissions and
the draft's worktree switch. While recording, Cancel and Finish replace Send;
the transcript stays above these controls. Back or Escape closes the options
panel without losing the draft.

## Set it up

Open Settings, Voice on the machine hosting the conversation. The card at the
top says whether dictation works now and, when it does not, offers the one
action that fixes it: Set up dictation downloads the local engine, Try again
restarts a failed download, Save to repair rewrites an unreadable
`speech.json`. With no configuration the engine is Local, so on Windows x64 a
single click is the whole setup. The microphone beside Send links to this page
when the engine is not ready.

The engine, the API provider, the fallback and the language apply as soon as
they change. API keys and local paths have their own Save button, so a
half-typed key is never sent. A machine whose core predates dictation answers
`speech.status` with MethodNotFound; the page and the microphone then name that
machine and ask to update Boite there, instead of showing the RPC error.

Its owner chooses the engine and credentials. Paired phones dictate through
that same core, but cannot change its configuration, install executables or
read local paths.

## Engines

- Local runs whisper.cpp on the core's machine, with no cloud fallback. Windows
  x64 downloads the pinned CPU runtime and multilingual Whisper Small Q5_1
  model together. The model is approximately 190 MB. Other platforms download
  the model and use `whisper-cli` on PATH, or the executable path in Local paths.
  A custom GGML model can be selected by absolute path. Paths refer to the core,
  never the phone. Whisper uses four CPU threads, no GPU, and exits after each
  request. Remove download deletes only Boite's managed runtime and model.
- API supports Groq `whisper-large-v3-turbo` and OpenRouter
  `openai/whisper-large-v3-turbo`. Groq accepts multipart audio; OpenRouter accepts
  JSON with base64 `input_audio`. Optionally try the other provider on failure
  when both keys are configured. There is no speculative duplicate request.
  Calls have a 60-second provider deadline.

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

Browsers require a secure context for microphone access. On a phone, open the
core through the trusted HTTPS origin described in [phone.md](phone.md). A LAN
HTTP address does not qualify; localhost does for development. Permission is
requested only after pressing Dictate. A denial explains how to retry. Silent
or very short recordings are refused before uploading.

## Lifecycle and limits

`speech.status`, `speech.transcribe` and `speech.cancel` are available to paired
devices. Configuration and download methods are owner-only. Cancellation is
scoped to a connection and request ID. Disconnecting aborts its active request.
At most two API transcriptions or one local transcription run at once; extra
requests fail visibly and can be retried. The full request expires after three
minutes. Transcription does not occupy an agent turn or alter a native session.

The core validates audio before spawning or calling a provider. It does not
journal audio or transcripts. Local WAV and output files are removed in a
`finally` block; a restarted core removes its own abandoned audio directories.
Local processes use `procs.spawn` under a synthetic speech ID. Downloads check
byte length and SHA-256, write partial files, and only publish completed
artifacts. A download has no total deadline: it gives up after 60 s without a
byte. A dropped or silent connection keeps the partial file, and installing
again asks the server for the rest with a `Range` header; a server that sends
the whole file instead starts the file over. A retry keeps a runtime already
unpacked. A wrong size or digest, and a cancel, remove the partial file.
whisper-cli picks its own thread count, at most four. No model loads at startup.

## Verification

```sh
bun test packages/core/test/speech.test.ts
bun test tests/e2e/speech.test.ts
```

Core tests cover both API payloads, fallback, credential redaction, phone
authorization, stale configuration and cancellation over real RPC. Browser
tests drive the actual recorder, AudioWorklet and resampler with a synthetic
microphone, capturing desktop and phone layouts. Hardware permissions and
mobile OS suspension still need device testing.

`BOITE_E2E_SPEECH_LOCAL=1 bun test packages/core/test/speech.local.live.test.ts`
downloads the real runtime/model into a temporary directory, transcribes the
upstream JFK fixture, checks the text and removes the managed files. It does
not call a cloud API. Cloud tests use substituted responses and do not
establish live credentials or provider availability.
