//! Local speech-to-text: a paired phone borrows the desktop's whisper.cpp.
//!
//! The shape is a bounded RPC body — one utterance in, one string out — never
//! a stream and never a new WebSocket opcode. A phone that cannot hear
//! (WebView without SpeechRecognition, or the user picked the local engine)
//! records a short clip, sends it as base64 over the ordinary bus, and gets
//! text back. The audio is written to a temp file, handed to the binary, and
//! deleted; nothing is kept and nothing leaves the machine.
//!
//! The binary is the user's own install, named by environment rather than
//! bundled: `BOITE_WHISPER_BIN` points at a whisper.cpp CLI and
//! `BOITE_WHISPER_MODEL` at a ggml model file. Missing either answers with a
//! named error that says exactly what to set — a transcription path that
//! silently does nothing would read as a broken microphone.

use std::io::Write;
use std::process::Command;

use base64::Engine;

/// One utterance, not a podcast: 12 MB of decoded audio is well past a minute
/// of 16 kHz mono WAV, and everything above it is refused before any decode
/// buffer grows.
pub const MAX_AUDIO_BYTES: usize = 12 * 1024 * 1024;

const BIN_VAR: &str = "BOITE_WHISPER_BIN";
const MODEL_VAR: &str = "BOITE_WHISPER_MODEL";

/// The one provider today. A name on the wire from day one, so the OpenAI
/// compatible remote path can join later without a shape change.
pub const PROVIDER_WHISPER_LOCAL: &str = "whisper-local";

/// Transcribes one clip with the local whisper.cpp binary.
///
/// The page sends WAV (it re-encodes whatever MediaRecorder produced, because
/// whisper.cpp reads WAV and this module refuses to grow an audio decoder).
pub fn transcribe(audio_b64: &str, mime: &str, provider: &str) -> Result<String, String> {
    if provider != PROVIDER_WHISPER_LOCAL {
        return Err(format!(
            "unknown voice provider {provider}; the one available is {PROVIDER_WHISPER_LOCAL}"
        ));
    }
    if mime != "audio/wav" && mime != "audio/wave" && mime != "audio/x-wav" {
        return Err(format!(
            "whisper-local reads audio/wav and the clip is {mime}; the page encodes WAV \
             before sending"
        ));
    }
    // A base64 length check first: 4 characters carry 3 bytes, so the cap is
    // enforced before a decode allocates anything.
    if audio_b64.len() / 4 * 3 > MAX_AUDIO_BYTES {
        return Err(format!(
            "AUDIO_TOO_LONG: the clip decodes past {MAX_AUDIO_BYTES} bytes; one utterance, \
             not a recording session"
        ));
    }
    let bin = std::env::var(BIN_VAR)
        .map_err(|_| format!("NO_WHISPER: set {BIN_VAR} to a whisper.cpp CLI binary"))?;
    let model = std::env::var(MODEL_VAR)
        .map_err(|_| format!("NO_WHISPER: set {MODEL_VAR} to a ggml model file"))?;
    let audio = base64::engine::general_purpose::STANDARD
        .decode(audio_b64)
        .map_err(|e| format!("the audio is not base64: {e}"))?;

    let path = std::env::temp_dir().join(format!(
        "boite-voice-{}-{}.wav",
        std::process::id(),
        crate::now_ms()
    ));
    let written = std::fs::File::create(&path)
        .and_then(|mut f| f.write_all(&audio))
        .map_err(|e| format!("could not write the clip to a temp file: {e}"));
    let answer = written.and_then(|()| {
        // `-nt` drops timestamps so stdout is the sentence itself. stderr is
        // the binary's progress chatter and stays out of the answer.
        let out = Command::new(&bin)
            .args(["-m", &model, "-f"])
            .arg(&path)
            .args(["-nt", "--no-prints"])
            .output()
            .map_err(|e| format!("could not run {bin}: {e}"))?;
        if !out.status.success() {
            let err = String::from_utf8_lossy(&out.stderr);
            let last = err.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("");
            return Err(format!("whisper exited {}: {last}", out.status));
        }
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    });
    // The clip dies with the call, transcribed or not.
    let _ = std::fs::remove_file(&path);
    answer
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every refusal is named before anything touches disk or spawns: the
    /// provider, the mime, the size cap. No test runs a real binary — an audio
    /// engine has no place in a test run.
    #[test]
    fn refusals_are_named_before_any_work() {
        let wrong_provider = transcribe("", "audio/wav", "openai").unwrap_err();
        assert!(wrong_provider.contains("whisper-local"), "{wrong_provider}");

        let wrong_mime = transcribe("", "audio/webm", PROVIDER_WHISPER_LOCAL).unwrap_err();
        assert!(wrong_mime.contains("audio/wav"), "{wrong_mime}");

        let too_long = "A".repeat(MAX_AUDIO_BYTES / 3 * 4 + 8);
        let refused = transcribe(&too_long, "audio/wav", PROVIDER_WHISPER_LOCAL).unwrap_err();
        assert!(refused.contains("AUDIO_TOO_LONG"), "{refused}");
    }
}
