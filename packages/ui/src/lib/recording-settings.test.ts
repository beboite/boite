import { afterEach, expect, test } from 'vitest';
import { RECORDING_CODEC_KEY, RECORDING_FRAME_RATE_KEY, recordingCodec, recordingFrameRate, setRecordingCodec, setRecordingFrameRate } from './recording-settings';

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

test('a desktop records H.264 until another codec is chosen, keeps the choice and reads unknown codecs as H.264', () => {
  expect(recordingCodec()).toBe('h264');
  setRecordingCodec('av1');
  expect(localStorage.getItem(RECORDING_CODEC_KEY)).toBe('av1');
  expect(recordingCodec()).toBe('av1');
  setRecordingCodec('hevc');
  expect(recordingCodec()).toBe('hevc');
  setRecordingCodec('h264');
  expect(localStorage.getItem(RECORDING_CODEC_KEY)).toBeNull();
  for (const stored of ['vp9', 'AV1', '']) {
    localStorage.setItem(RECORDING_CODEC_KEY, stored);
    expect(recordingCodec()).toBe('h264');
  }
});
