import { expect, test } from 'vitest';
import { videoPlayable } from './video-support';

test('a video type is refused only by an engine that knows video', () => {
  const iphone = (type: string) => type === 'video/mp4' || type === 'video/quicktime' ? 'maybe' : '';
  expect(videoPlayable('video/webm', iphone)).toBe(false);
  expect(videoPlayable('video/webm;codecs=vp9', iphone)).toBe(false);
  expect(videoPlayable('video/mp4', iphone)).toBe(true);
  expect(videoPlayable('VIDEO/MP4; codecs=avc1', iphone)).toBe(true);
  expect(videoPlayable('audio/ogg', iphone)).toBe(true);
  expect(videoPlayable('video/ogg', iphone)).toBe(false);
  // Chrome says no to these containers yet plays H.264 in them: the player decides.
  const chrome = (type: string) => type === 'video/mp4' || type === 'video/webm' ? 'maybe' : '';
  expect(videoPlayable('video/quicktime', chrome)).toBe(true);
  expect(videoPlayable('video/x-matroska', chrome)).toBe(true);
  // A DOM without media support says no to everything; the player decides.
  expect(videoPlayable('video/webm', () => '')).toBe(true);
});

test('an MP4 naming HEVC or AV1 is refused by an engine without that decoder', () => {
  // Desktop Chromium without an HEVC decoder; an iPhone older than the 15 Pro.
  const chromium = (type: string) => type === 'video/mp4' || type.includes('avc1') || type.includes('av01') ? 'probably' : '';
  const iphone = (type: string) => type === 'video/mp4' || type.includes('avc1') || type.includes('hvc1') ? 'probably' : '';
  expect(videoPlayable('video/mp4;codecs=hvc1.1.6.L123.B0', chromium)).toBe(false);
  expect(videoPlayable('video/mp4;codecs=av01.0.08M.08', chromium)).toBe(true);
  expect(videoPlayable('video/mp4; codecs="hvc1.1.6.L123.B0"', iphone)).toBe(true);
  expect(videoPlayable('video/mp4;codecs=av01.0.08M.08', iphone)).toBe(false);
  expect(videoPlayable('video/mp4;codecs=av01.0.08M.08', () => '')).toBe(true);
});