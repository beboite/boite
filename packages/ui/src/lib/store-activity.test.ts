import { expect, vi } from 'vitest';
import { test } from '../test/fake-client';

const image = { kind: 'image' as const, mimeType: 'image/png' as const, data: 'aW1hZ2U=', name: 'reference.png' };

test.for([
  ['/goal Match the reference', false],
  ['/goal Match the reference', true],
  ['/loop 2 Check the reference', false],
  ['/loop 2 Check the reference', true],
] as const)('%s with an image, draft=%s', async ([command, draft], { store, client }) => {
  const choice = store.threads.find(thread => thread.id === 't-trace')!;
  if (draft) store.startDraft(store.projects[0]!.id);
  else await store.open('t-trace');
  expect(await store.submit(command, choice, [image])).toBe(true);
  expect(store.error).toBeNull();
  const threadId = store.openThread!.id;
  await vi.waitFor(async () => {
    const thread = await client.call('threads.get', { threadId });
    const messages = thread.messages.filter(message => message.role === 'user' && message.parts.some(part => part.type === 'text' && part.activity));
    expect(messages).toHaveLength(command.startsWith('/loop') ? 2 : 1);
    expect(messages[0]!.parts).toContainEqual({ type: 'image', mimeType: image.mimeType, data: image.data, alt: image.name });
    if (messages[1]) expect(messages[1].parts.some(part => part.type === 'image')).toBe(false);
  });
});
