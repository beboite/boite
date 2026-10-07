import type { Message } from '@boite/contracts';
import type { Store } from './store.svelte';

/**
 * Asks for the page below a window `threads.get` cut around a reading
 * position once the reader is within `reach` pixels of its bottom. The store
 * refuses a second call while one is in flight, and a window at the end has
 * no cursor to ask with.
 */
export function pullNewer(store: Store, box: HTMLElement, reach: number): void {
  if ((store.messagesAfter ?? null) === null || store.loadingNewer) return;
  if (box.scrollHeight - box.scrollTop - box.clientHeight > reach) return;
  void store.loadNewer();
}

/**
 * Asks the store for the page above the window once the reader is within
 * `reach` pixels of the top, then puts the height it added back into the
 * scroll position on the next frame, so the message being read stays exactly
 * where it was. `head` names the first row before the call, and `above`
 * answers what the rows in front of it weigh once the page is in: the running
 * total of the new rows, a read rather than a measurement of a list that has
 * just been laid out, right whether they landed in the window or in the spacer
 * above it. The store itself refuses a second call while one is in flight and
 * a call with no cursor left.
 */
export function pullOlder(store: Store, box: HTMLElement, reach: number, head: string | undefined, above: (head: string | undefined) => number, moved: () => void): void {
  if (box.scrollTop > reach) return;
  if (store.messagesBefore === null || store.loadingOlder) return;
  const topBefore = box.scrollTop;
  void store.loadOlder().then((added) => {
    if (added === 0) return;
    requestAnimationFrame(() => {
      const grew = above(head);
      if (grew <= 0) return;
      box.scrollTop = topBefore + grew;
      moved();
    });
  });
}

/**
 * Edit of a sent prompt, once the pictures and files a light page left on
 * the core are back: the composer sends what the message holds. False, with
 * the failure shown, when one of them could not be read.
 */
export async function editWhole(store: Store, threadId: string, message: Message): Promise<boolean> {
  if (!(await store.loadAttachments(threadId, message))) return false;
  store.startEdit(threadId, message);
  return true;
}
