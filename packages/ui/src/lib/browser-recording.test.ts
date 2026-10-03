import { expect, test } from 'vitest';
import { pickRecordingType } from './browser-recording';

test('recordings prefer H.264 MP4, which iPhones play, and fall back to WebM', () => {
  // WebView2 and recent Chromium encode H.264 into MP4.
  expect(pickRecordingType(type => type.startsWith('video/mp4;codecs=avc1') || type.startsWith('video/webm'))).toEqual({ type: 'video/mp4;codecs=avc1.640028', mime: 'video/mp4' });
  expect(pickRecordingType(type => type === 'video/mp4;codecs=avc1.42E01E' || type === 'video/webm')).toEqual({ type: 'video/mp4;codecs=avc1.42E01E', mime: 'video/mp4' });
  // An MP4 that might carry VP9 is not taken for H.264.
  expect(pickRecordingType(type => type === 'video/mp4' || type === 'video/webm;codecs=vp8')).toEqual({ type: 'video/webm;codecs=vp8', mime: 'video/webm' });
  expect(pickRecordingType(type => type === 'video/webm')).toEqual({ type: 'video/webm', mime: 'video/webm' });
  expect(pickRecordingType(() => false)).toBeNull();
});
