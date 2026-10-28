import type { Message } from '@boite/contracts';
import { tick, untrack } from 'svelte';
import type { Store } from './store.svelte';
import { offerDraftUndo } from './composer-editing';
import { strings } from './strings';

/**
 * A first page holds about one screen, and a list that does not reach past
 * its viewport by `reach` gets no scroll to page with: `page` asks for the
 * pages beside it at once. The caller's effect runs this again after each
 * page lands, until the list is long enough or the thread is whole; a failed
 * page changes no row and is not asked again until something does.
 */
export function fillShort(box: HTMLElement | undefined, open: boolean, navigating: () => boolean, reach: number, page: (box: HTMLElement) => void): void {
  if (!box || !open) return;
  void tick().then(() => {
    // A list with no height is hidden, not short: it would page in the whole thread unseen.
    if (!box.isConnected || !box.clientHeight || navigating() || box.scrollHeight - box.clientHeight > reach) return;
    untrack(() => page(box));
  });
}

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
 *
 * That total counts the rows the window mounts just above the reader at their
 * estimate, while they draw at their real height: 850 px more for four tool
 * runs on a desktop on 2026-10-13, and the anchor kept on the next measurement
 * held the text there. Once the window is drawn, `nodeOf(head)` is put back
 * where it stood on screen when the call left.
 */
export function pullOlder(store: Store, box: HTMLElement, reach: number, head: string | undefined, above: (head: string | undefined) => number, moved: () => void, nodeOf?: (id: string) => HTMLElement | undefined): void {
  if (box.scrollTop > reach) return;
  if (store.messagesBefore === null || store.loadingOlder) return;
  const topBefore = box.scrollTop;
  const offset = (): number | null => {
    const node = head === undefined ? undefined : nodeOf?.(head);
    return node?.isConnected ? node.getBoundingClientRect().top - box.getBoundingClientRect().top : null;
  };
  const stood = offset();
  void store.loadOlder().then((added) => {
    if (added === 0) return;
    requestAnimationFrame(() => {
      const grew = above(head);
      if (grew <= 0) return;
      box.scrollTop = topBefore + grew;
      moved();
      void tick().then(() => {
        const now = stood === null ? null : offset();
        if (now === null || stood === null || Math.abs(now - stood) <= 1) return;
        box.scrollTop += now - stood;
        moved();
      });
    });
  });
}

const editRequests = new WeakMap<Store, object>();

/**
 * Edit of a sent prompt, once the pictures and files a light page left on
 * the core are back: the composer sends what the message holds. False, with
 * the failure shown, when one of them could not be read.
 */
export async function editWhole(store: Store, threadId: string, message: Message, current: () => boolean = () => true): Promise<boolean> {
  const request = {};
  editRequests.set(store, request);
  const client = store.client, thread = store.openThread;
  const state = store.composerStates[threadId];
  const text = state?.text, editing = state?.editing;
  const attachments = [...state?.attachments ?? []], references = [...state?.previewReferences ?? []];
  if (!(await store.loadAttachments(threadId, message))) return false;
  // A late read belongs to the visit and draft that asked, never to text typed meanwhile.
  const now = store.composerStates[threadId];
  if (editRequests.get(store) !== request || store.client !== client || store.openThread !== thread || !current() ||
    now !== state || now?.text !== text || now?.editing !== editing ||
    (now?.attachments.length ?? 0) !== attachments.length || attachments.some((part, index) => now?.attachments[index] !== part) ||
    (now?.previewReferences?.length ?? 0) !== references.length || references.some((reference, index) => now?.previewReferences?.[index] !== reference)) return false;
  store.startEdit(threadId, message);
  const edited = store.composerStates[threadId]!;
  offerDraftUndo({ store, key: threadId, box: undefined, state: edited, provider: null, moved: () => {} }, { text: text ?? '', attachments: attachments.length }, strings.composer.draftReplaced);
  return true;
}
