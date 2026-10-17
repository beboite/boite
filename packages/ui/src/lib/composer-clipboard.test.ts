import { afterEach, describe, expect, it } from 'vitest';
import type { Attachment } from '@boite/contracts';
import type { ComposerState } from './composer-queue';
import { copiedFrom, copyImages, fitCopy, forgetCopy, IMAGE_CLIPBOARD_TYPE } from './composer-clipboard';

const image = (data: string): Attachment => ({ kind: 'image', mimeType: 'image/png', data, name: `${data}.png` });
const file: Attachment = { kind: 'file', mimeType: 'text/plain', data: 'bm90ZXM=', name: 'notes.txt' };

function board(): DataTransfer {
  const data = new Map<string, string>();
  return { getData: (type: string) => data.get(type) ?? '', setData: (type: string, value: string) => { data.set(type, value); } } as unknown as DataTransfer;
}

afterEach(forgetCopy);

describe('composer clipboard', () => {
  it('renumbers pasted references, reuses a picture already held and drops a refused one', () => {
    const one = image('b25l'), two = image('dHdv'), three = image('dGhyZWU=');
    const from: ComposerState = { text: 'a [Image 1] b [Image 2] c [Image 3]', attachments: [one, file, two, three], queued: [], sending: false, paused: false };
    const clipboard = board();
    expect(copyImages(clipboard, from, 2, from.text.length)).toBe(true);
    const copied = copiedFrom(clipboard)!;
    expect(copied.text).toBe('[Image 1] b [Image 2] c [Image 3]');
    // The target already holds `two`, as a copy of the same bytes; `three` is refused.
    const fitted = fitCopy(copied, [image('eA=='), { ...two }], incoming => incoming.filter(item => item.data !== three.data));
    expect(fitted.text).toBe('[Image 3] b [Image 2] c ');
    expect(fitted.attachments.map(item => item.data)).toEqual(['eA==', two.data, one.data]);
  });

  it('ignores a selection without images and a clipboard written by someone else', () => {
    const from: ComposerState = { text: 'plain [Image 1]', attachments: [image('b25l')], queued: [], sending: false, paused: false };
    expect(copyImages(board(), from, 0, 5)).toBe(false);
    const clipboard = board();
    copyImages(clipboard, from, 6, 15);
    const other = board();
    other.setData(IMAGE_CLIPBOARD_TYPE, JSON.stringify({ id: 'stale' }));
    other.setData('text/plain', '[Image 1]');
    expect(copiedFrom(other)).toBeNull();
    const text = board();
    text.setData('text/plain', 'something else');
    expect(copiedFrom(text)).toBeNull();
  });
});

describe('pasting a copy whose pictures are all refused', () => {
  it('keeps the selected text instead of replacing it with nothing', async () => {
    const { pasteImages } = await import('./composer-editing');
    const from: ComposerState = { text: '[Image 1]', attachments: [image('b25l')], queued: [], sending: false, paused: false };
    const clipboard = board();
    copyImages(clipboard, from, 0, from.text.length);
    const state: ComposerState = { text: 'keep these words', attachments: [], queued: [], sending: false, paused: false };
    const box = document.createElement('textarea');
    box.value = state.text;
    box.setSelectionRange(0, 4);
    const store = { error: null as string | null, editComposerText: (_key: string, value: string) => { state.text = value; } };
    const event = { clipboardData: clipboard, preventDefault() {} } as unknown as ClipboardEvent;
    expect(pasteImages({ store: store as never, key: 'k', box, state, provider: { name: 'Text only', capabilities: { images: false } }, moved: () => {} }, event)).toBe(true);
    expect(state.text).toBe('keep these words');
    expect(box.value).toBe('keep these words');
    expect(store.error).toContain('Text only');
  });
});
