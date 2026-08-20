import type { MessageKey } from "$lib/i18n/index.svelte";

/**
 * Speech in, through the page's own SpeechRecognition.
 *
 * The audio stays at the edge: capture happens in this webview, on the device
 * the user is holding, and only text ever crosses the bus. No key, no server,
 * no stream. The engine is real on Android Chrome and in the TWA; on Windows
 * WebView2 support is uneven and on Linux WebKitGTK it is mostly absent, which
 * is why availability is asked, named, and written on the button — never a
 * silent fallback to some other provider.
 *
 * SpeechRecognition is not in TypeScript's DOM lib, so the shape used here is
 * declared locally, minimal, prefixed-or-not.
 */

interface RecognitionAlternative {
  transcript: string;
}

interface RecognitionResult {
  isFinal: boolean;
  0: RecognitionAlternative;
}

interface RecognitionResultEvent {
  results: ArrayLike<RecognitionResult>;
}

interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: RecognitionResultEvent) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

type RecognitionCtor = new () => Recognition;

function recognitionCtor(): RecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: RecognitionCtor;
    webkitSpeechRecognition?: RecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/** Whether this webview can hear at all, with the reason spelled out when not. */
export function sttAvailability(): { ok: true } | { ok: false; reasonKey: MessageKey } {
  if (recognitionCtor()) return { ok: true };
  return { ok: false, reasonKey: "voice.sttUnsupported" };
}

/**
 * One utterance: created on press, stopped on release, dead after `onDone`.
 *
 * The transcript is rebuilt from the engine's full result list on every event
 * rather than accumulated, so a revised interim segment replaces itself instead
 * of stuttering. `onUpdate` fires with the live text while talking; `onDone`
 * fires exactly once with the final text when the engine settles.
 */
export class SttSession {
  private rec: Recognition | null = null;
  private text = "";
  private done = false;

  constructor(
    private readonly lang: string,
    private readonly onUpdate: (text: string) => void,
    private readonly onDone: (text: string) => void,
  ) {}

  /** False when the engine is missing; the button should not have been drawn. */
  start(): boolean {
    const Ctor = recognitionCtor();
    if (!Ctor) return false;
    const rec = new Ctor();
    rec.lang = this.lang;
    rec.continuous = true;
    rec.interimResults = true;
    rec.onresult = (e) => {
      let text = "";
      for (let i = 0; i < e.results.length; i += 1) {
        text += e.results[i][0].transcript;
      }
      this.text = text.trim();
      this.onUpdate(this.text);
    };
    // The engine can end on its own (silence, error) as well as on stop();
    // either way the session settles exactly once, with whatever was heard.
    rec.onend = () => {
      if (this.done) return;
      this.done = true;
      this.onDone(this.text);
    };
    this.rec = rec;
    try {
      rec.start();
    } catch {
      return false;
    }
    return true;
  }

  /** Release: asks the engine to settle. `onDone` follows with the text. */
  stop(): void {
    this.rec?.stop();
  }
}
