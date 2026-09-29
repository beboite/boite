import { describe, expect, test } from 'bun:test';
import { normalizeInitialInput, normalizeToolResult } from './browser-lab-codex.ts';

const imageUrl = 'data:image/png;base64,iVBORw0KGgo=';

describe('browser lab Codex content transport', () => {
  test('passes image tool results as actual content instead of JSON text', () => {
    const contentItems = [{ type: 'inputText' as const, text: 'Rendered page' }, { type: 'inputImage' as const, imageUrl }];
    expect(normalizeToolResult({ contentItems })).toEqual({ contentItems, success: true });
    expect(normalizeToolResult({ contentItems, success: false }).success).toBe(false);
  });
  test('maps initial text and images to the distinct UserInput schema', () => {
    expect(normalizeInitialInput([{ type: 'inputText', text: 'Task' }, { type: 'inputImage', imageUrl }])).toEqual([
      { type: 'text', text: 'Task', text_elements: [] }, { type: 'image', url: imageUrl },
    ]);
    expect(normalizeInitialInput('Task')).toEqual([{ type: 'text', text: 'Task', text_elements: [] }]);
  });
  test('keeps plain DOM JSON callbacks compatible', () => {
    expect(normalizeToolResult({ url: 'https://example.com' })).toEqual({
      contentItems: [{ type: 'inputText', text: '{"url":"https://example.com"}' }], success: true,
    });
  });
  test('rejects malformed content and nonembedded image references', () => {
    for (const value of [ { contentItems: [] }, { contentItems: [{ type: 'image', url: imageUrl }] },
      { contentItems: [{ type: 'inputImage', imageUrl: 'C:/private.png' }] },
      { contentItems: [{ type: 'inputImage', imageUrl: 'https://example.com/image.png' }] },
      { contentItems: [{ type: 'inputText', text: 'x' }], success: 'yes' },
    ]) expect(() => normalizeToolResult(value)).toThrow();
  });
});
