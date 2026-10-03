/*
 * The frame rate this desktop records its browser tabs at, 30 or 60 as in T3
 * Code. A client preference like `boite.theme`: it lives in `localStorage` and
 * applies to recordings an agent starts on this desktop too.
 */
import { BROWSER_RECORDING_FRAME_RATES, DEFAULT_BROWSER_RECORDING_FRAME_RATE, type BrowserRecordingFrameRate } from '@boite/contracts';

export const RECORDING_FRAME_RATE_KEY = 'boite.recording-frame-rate';

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
