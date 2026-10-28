import { ATTACHMENT_MAX_BYTES, ATTACHMENTS_PER_TURN, ATTACHMENTS_TOTAL_MAX_BYTES, type Attachment, type ProviderSummary } from '@boite/contracts';
import { acceptAttachments, attachedBytes, isImageMimeType, keepSource, readAttachmentFile } from './attachments';
import { checkpoint, replaceInHistory } from './composer-history';
import { insertImageReference, removeImageReferences } from './composer-images';
import type { ComposerState } from './composer-queue';
import { loadedFrom, readSettled, type DraftAttachment } from './draft-attachments';
import { bytes } from './format';
import { IMAGE_SOURCE_MAX_BYTES, isReducible, prepareImageAway, type ImageCodec } from './image-prepare';
import { fill, strings } from './strings';
import type { Store } from './store.svelte';

/** Files dropped on the shell window, wherever they land (`lib/native-drop.ts`). */
export { receiveDroppedFiles } from './native-drop';

export interface Holder {
  /** What is attached now, read again before each file: a removal made meanwhile counts. */
  held(): Attachment[];
  /** One attachment that passed every cap. */
  add(attachment: Attachment): void;
  /** Null when images go anywhere, as files given with an answer do. */
  noImages: { provider: string } | null;
  codec?: ImageCodec;
}

/** Why a file cannot even start: `stop` when no later file can either. */
function admission(file: File, held: Attachment[], noImages: Holder['noImages']): { refused: string; stop: boolean } | null {
  if (held.length >= ATTACHMENTS_PER_TURN) {
    return { refused: fill(strings.composer.attachTooMany, { name: file.name, max: String(ATTACHMENTS_PER_TURN) }), stop: true };
  }
  if (noImages !== null && isImageMimeType(file.type)) {
    return { refused: fill(strings.composer.attachNoImages, { provider: noImages.provider }), stop: false };
  }
  return null;
}

/**
 * One admitted file as an attachment: an image brought to a sendable size
 * first (`lib/image-prepare.ts`, off the main thread), then the caps checked
 * against `held` before base64 is allocated.
 */
async function readFile(file: File, held: () => Attachment[], noImages: Holder['noImages'], codec?: ImageCodec): Promise<{ attachment: Attachment } | { refused: string }> {
  // Without image input nothing becomes an image: a HEIC, BMP or TIFF goes as the file it is.
  let ready = file;
  if (noImages === null && isReducible(file)) {
    const prepared = await prepareImageAway(file, codec);
    if (prepared.kind === 'tooLarge') return { refused: fill(strings.media.sourceTooLarge, { name: file.name, size: bytes(file.size), max: bytes(IMAGE_SOURCE_MAX_BYTES) }) };
    ready = prepared.file;
  }
  if (ready.size > ATTACHMENT_MAX_BYTES) return { refused: fill(strings.composer.attachTooLarge, { name: file.name, max: bytes(ATTACHMENT_MAX_BYTES) }) };
  if (attachedBytes(held()) + ready.size > ATTACHMENTS_TOTAL_MAX_BYTES) {
    return { refused: fill(strings.composer.attachTotalTooLarge, { name: file.name, max: bytes(ATTACHMENTS_TOTAL_MAX_BYTES) }) };
  }
  try {
    const attachment = await readAttachmentFile(ready);
    const result = acceptAttachments(held(), [attachment]);
    return result.refused !== null ? { refused: result.refused } : { attachment };
  } catch {
    return { refused: fill(strings.composer.attachReadError, { name: file.name }) };
  }
}

/**
 * Files read into attachments one at a time. A refused file says why and the
 * rest go on. Returns the first reason, or null. `lib/attachments.ts` owns
 * the caps.
 */
export async function gatherAttachments(files: File[], holder: Holder): Promise<string | null> {
  let refused: string | null = null;
  for (const file of files) {
    const denied = admission(file, holder.held(), holder.noImages);
    if (denied) {
      refused ??= denied.refused;
      if (denied.stop) break;
      continue;
    }
    const result = await readFile(file, () => holder.held(), holder.noImages, holder.codec);
    if ('refused' in result) refused ??= result.refused;
    else holder.add(result.attachment);
  }
  return refused;
}

/** A composer input that takes files: its list, placeholders included, and what to do as each one moves. */
export interface Receiver {
  /** What the reads of this input queue on: its state, which a draft keeps when it becomes a thread. */
  input: object;
  attachments: Attachment[];
  /** A placeholder just joined the list: its `[Image N]` goes where the caret is now. */
  placed(placeholder: Attachment): void;
  /** The file read for `placeholder`, or null when it was refused: it takes the placeholder's place. */
  settle(placeholder: Attachment, ready: Attachment | null): void;
}

/** Each input's reads, one after another, so every file lands under the number its reference was given. */
const reads = new WeakMap<object, Promise<void>>();

/**
 * The composer's way in, from the attach button, a paste or a drop. Every
 * file shows at once as a loading tile, a picture with its `[Image N]`, and
 * the box keeps taking keys while the files are read behind it, in order.
 * A refusal goes to `store.error` as soon as it is known. Resolves once every
 * file of this call has settled.
 */
export function receiveFiles(
  store: Store,
  files: File[],
  receiver: Receiver,
  attachmentProvider: ProviderSummary | null | undefined,
  codec?: ImageCodec
): Promise<void> {
  const noImages = attachmentProvider && !attachmentProvider.capabilities.images ? { provider: attachmentProvider.name } : null;
  let refused = false;
  const refuse = (message: string): void => {
    if (refused) return;
    refused = true;
    store.error = message;
  };
  const waiting: [File, Attachment][] = [];
  // Past the cap a file waits instead: an earlier one of these refused once it is read leaves it a slot.
  const over: File[] = [];
  /** False while the box is full. */
  const admit = (file: File): boolean => {
    const denied = admission(file, receiver.attachments, noImages);
    if (denied?.stop) return false;
    if (denied) { refuse(denied.refused); return true; }
    const image = noImages === null && (isImageMimeType(file.type) || isReducible(file));
    // A HEIC shows as a picture before it is one: the type is the source's until the read replaces it.
    const placeholder = { kind: image ? 'image' : 'file', mimeType: file.type || 'application/octet-stream', name: file.name || null, data: '', loading: true } as DraftAttachment;
    receiver.attachments = [...receiver.attachments, placeholder];
    // The list's own copy: a reactive list wraps what it is given, and identity is what finds it again.
    const held = receiver.attachments.at(-1)!;
    receiver.placed(held);
    waiting.push([file, held]);
    return true;
  };
  const admitWaiting = () => { while (over.length > 0 && admit(over[0]!)) over.shift(); };
  const refuseOver = () => {
    const [first] = over;
    if (first) refuse(fill(strings.composer.attachTooMany, { name: first.name, max: String(ATTACHMENTS_PER_TURN) }));
  };
  for (const file of files) if (over.length > 0 || !admit(file)) over.push(file);
  const ahead = reads.get(receiver.input);
  // Full of tiles still being read: these wait behind them, which may leave them a slot.
  if (waiting.length === 0 && (over.length === 0 || !ahead)) { refuseOver(); return Promise.resolve(); }
  const run = (ahead ?? Promise.resolve()).then(async () => {
    admitWaiting();
    for (let next = 0; next < waiting.length; next++) {
      const [file, placeholder] = waiting[next]!;
      // A read that throws still settles its placeholder: no tile waits forever.
      const result = await readFile(file, () => receiver.attachments.filter(item => item !== placeholder), noImages, codec)
        .catch(() => ({ refused: fill(strings.composer.attachReadError, { name: file.name }) }));
      if ('refused' in result) refuse(result.refused);
      receiver.settle(placeholder, 'attachment' in result ? result.attachment : null);
      admitWaiting();
    }
    refuseOver();
  });
  // Only reads still going are waited on: once every one has settled, a full box refuses at once.
  const settled: Promise<void> = run.catch(() => {}).then(() => { if (reads.get(receiver.input) === settled) reads.delete(receiver.input); });
  reads.set(receiver.input, settled);
  return run;
}

/**
 * `receiveFiles` for one composer state, wherever its key is now: a draft
 * that became a thread meanwhile still gets its files. The tiles and their
 * references are one undo step; a refused file calls `refused`.
 */
export function takeFiles(store: Store, state: ComposerState, files: File[], attachmentProvider: ProviderSummary | null | undefined, refused: () => void): Promise<void> {
  const keyOf = () => Object.keys(store.composerStates).find(name => store.composerStates[name] === state);
  return receiveFiles(store, files, {
    input: state,
    get attachments() { return state.attachments; },
    set attachments(value: Attachment[]) { checkpoint(state); state.attachments = value; },
    placed(placeholder) {
      const key = keyOf();
      if (placeholder.kind === 'image' && key !== undefined) insertImageReference(store, key);
    },
    settle(placeholder, ready) {
      readSettled(placeholder, ready);
      const at = state.attachments.indexOf(placeholder);
      if (at < 0) { replaceInHistory(state, placeholder, ready); return; }
      if (!ready) refused();
      // A picture that went as a file, or not at all, takes its reference with it and renumbers the others.
      const key = keyOf();
      if (placeholder.kind === 'image' && ready?.kind !== 'image' && key !== undefined) removeImageReferences(store, key, at);
      state.attachments = ready ? state.attachments.map((item, index) => index === at ? ready : item) : state.attachments.filter((_, index) => index !== at);
      const landed = ready ? state.attachments[at]! : null;
      if (ready && landed) { loadedFrom(landed, placeholder); keepSource(ready, landed); }
      replaceInHistory(state, placeholder, landed);
    }
  }, attachmentProvider);
}
