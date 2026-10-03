import { afterEach, expect, test } from 'vitest';
import { RECORDING_FRAME_RATE_KEY, recordingFrameRate, setRecordingFrameRate } from './recording-frame-rate';

afterEach(() => localStorage.clear());

test('a desktop records at 30 frames per second until 60 is chosen, and keeps the choice', () => {
  expect(recordingFrameRate()).toBe(30);
  setRecordingFrameRate(60);
  expect(localStorage.getItem(RECORDING_FRAME_RATE_KEY)).toBe('60');
  expect(recordingFrameRate()).toBe(60);
  setRecordingFrameRate(30);
  expect(localStorage.getItem(RECORDING_FRAME_RATE_KEY)).toBeNull();
  expect(recordingFrameRate()).toBe(30);
});

test('a stored rate the app does not offer reads as 30', () => {
  for (const stored of ['45', '120', 'fast', '']) {
    localStorage.setItem(RECORDING_FRAME_RATE_KEY, stored);
    expect(recordingFrameRate()).toBe(30);
  }
});
