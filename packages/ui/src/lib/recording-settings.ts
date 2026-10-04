/*
 * How this desktop records its browser tabs: 30 or 60 frames per second as in
 * T3 Code, and the video codec, H.264 unless another is chosen. Client
 * preferences like `boite.theme`: they live in `localStorage` and apply to
 * recordings an agent starts on this desktop too, unless the agent names its own.
 */
import { BROWSER_RECORDING_CODECS, BROWSER_RECORDING_FRAME_RATES, DEFAULT_BROWSER_RECORDING_CODEC, DEFAULT_BROWSER_RECORDING_FRAME_RATE, type BrowserRecordingCodec, type BrowserRecordingFrameRate } from '@boite/contracts';

export const RECORDING_FRAME_RATE_KEY = 'boite.recording-frame-rate';
export const RECORDING_CODEC_KEY = 'boite.recording-codec';

/** The stored rate, or 30 when none is stored or the stored one is not offered. */
export function recordingFrameRate(): BrowserRecordingFrameRate {
  try {
    const stored = Number(window.localStorage.getItem(RECORDING_FRAME_RATE_KEY));
    return BROWSER_RECORDING_FRAME_RATES.find(rate => rate === stored) ?? DEFAULT_BROWSER_RECORDING_FRAME_RATE;
  } catch { return DEFAULT_BROWSER_RECORDING_FRAME_RATE; }
}

export function setRecordingFrameRate(rate: BrowserRecordingFrameRate): void {
  try {
    if (rate === DEFAULT_BROWSER_RECORDING_FRAME_RATE) window.localStorage.removeItem(RECORDING_FRAME_RATE_KEY);
    else window.localStorage.setItem(RECORDING_FRAME_RATE_KEY, String(rate));
  } catch { /* storage refused: the rate lasts for this recording only */ }
}

/**
 * The stored codec, or H.264 when none is stored or the stored one is not
 * offered. A stored codec this desktop cannot encode stays chosen: recording
 * then refuses with the reason instead of switching codec.
 */
export function recordingCodec(): BrowserRecordingCodec {
  try {
    const stored = window.localStorage.getItem(RECORDING_CODEC_KEY);
    return BROWSER_RECORDING_CODECS.find(codec => codec === stored) ?? DEFAULT_BROWSER_RECORDING_CODEC;
  } catch { return DEFAULT_BROWSER_RECORDING_CODEC; }
}

export function setRecordingCodec(codec: BrowserRecordingCodec): void {
  try {
    if (codec === DEFAULT_BROWSER_RECORDING_CODEC) window.localStorage.removeItem(RECORDING_CODEC_KEY);
    else window.localStorage.setItem(RECORDING_CODEC_KEY, codec);
  } catch { /* storage refused: the codec lasts for this recording only */ }
}
