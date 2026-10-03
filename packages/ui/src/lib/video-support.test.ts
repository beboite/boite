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