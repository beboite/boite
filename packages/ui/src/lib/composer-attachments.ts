import { ATTACHMENT_MAX_BYTES, ATTACHMENTS_PER_TURN, ATTACHMENTS_TOTAL_MAX_BYTES, type Attachment, type ProviderSummary } from '@boite/contracts';
import { acceptAttachments, attachedBytes, decodedBytes, isImageMimeType, keepSource, readAttachmentFile } from './attachments';
import { checkpoint, replaceInHistory } from './composer-history';
import { closeDraftUndo } from './composer-editing';
import { insertImageReference, removeImageReferences } from './composer-images';
import type { ComposerState } from './composer-queue';
import { loadedFrom, readSettled, readyAttachments, tileKey, type DraftAttachment } from './draft-attachments';
import { bytes } from './format';
import { IMAGE_SOURCE_MAX_BYTES, isReducible, prepareImageAway, type ImageCodec } from './image-prepare';
import { fill, strings } from './strings';
import { fitTurn, fitting, queued, type Fitted } from './turn-fit';

import type { Store } from './store.svelte';

/** Files dropped on the shell window, wherever they land (`lib/native-drop.ts`). */
export { receiveDroppedFiles } from './native-drop';

export interface Holder {
  /** What is attached now, read again before each file: a removal made meanwhile counts. */
  held(): Attachment[];
  /** One attachment that passed every cap. */
  add(attachment: Attachment): void;
  /** Held attachments swapped for the lighter copies a fitted turn made of them (`lib/turn-fit.ts`). */
  replace(lighter: Map<Attachment, Attachment>): void;
  /** Null when images go anywhere, as files given with an answer do. */
  noImages: { provider: string } | null;
  codec?: ImageCodec;
  /** The box the files go to: their fit waits for any other running there (`lib/turn-fit.ts`). */
  box?: object;
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
 * against `held`. The byte total is left to the caller, which fits the turn
 * when the file passes it (`lib/turn-fit.ts`).
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
  try {
    const attachment = await readAttachmentFile(ready);
    const result = acceptAttachments(held(), [attachment], { fit: true });
    return result.refused !== null ? { refused: result.refused } : { attachment };
  } catch {
    return { refused: fill(strings.composer.attachReadError, { name: file.name }) };
  }
}

/** Whether `attachment` joining `held` passes the byte total: then it waits for the turn to be fitted. */
function passesTotal(held: Attachment[], attachment: Attachment): boolean {
  return attachedBytes(held) + decodedBytes(attachment.data) > ATTACHMENTS_TOTAL_MAX_BYTES;
}

/**
 * `incoming` fitted into one turn with what `held` holds (`lib/turn-fit.ts`).
 * A paste or a removal made while the turn was fitted changes what it weighs:
 * the fit starts again from what is held then. Returns the held attachments
 * to swap for lighter copies, and `incoming` as fitted, in order.
 */
async function fitWith(held: () => Attachment[], incoming: Attachment[], codec?: ImageCodec): Promise<{ lighter: Map<Attachment, Attachment>; incoming: Attachment[] }> {
  let before: Attachment[], fitted: Fitted;
  do {
    before = held();
    fitted = await fitTurn([...before, ...incoming], codec);
  } while (!same(before, held()));
  const lighter = new Map(before.flatMap((attachment, at) => fitted.attachments[at] === attachment ? [] : [[attachment, fitted.attachments[at]!] as const]));
  return { lighter, incoming: fitted.attachments.slice(before.length) };
}

function same(one: Attachment[], other: Attachment[]): boolean {
  return one.length === other.length && one.every((attachment, at) => other[at] === attachment);
}

/**
 * Files read into attachments one at a time. Files go in as they are read
 * while the turn stays under its byte total; the ones after that wait for the
 * rest of the batch, and the turn is fitted once with them (`fitWith`), the
 * images already held included. A refused file says why and the rest go on.
 * Returns the first reason, or null. `lib/attachments.ts` owns the caps.
 */
export async function gatherAttachments(files: File[], holder: Holder): Promise<string | null> {
  let refused: string | null = null;
  const refuse = (message: string): void => { refused ??= message; };
  const waiting: { attachment: Attachment; name: string }[] = [];
  for (const file of files) {
    const denied = admission(file, [...holder.held(), ...waiting.map(item => item.attachment)], holder.noImages);
    if (denied) {
      refuse(denied.refused);
      if (denied.stop) break;
      continue;
    }
    const result = await readFile(file, () => holder.held(), holder.noImages, holder.codec);
    if ('refused' in result) refuse(result.refused);
    else if (waiting.length > 0 || passesTotal(holder.held(), result.attachment)) waiting.push({ attachment: result.attachment, name: file.name });
    else holder.add(result.attachment);
  }
  if (waiting.length > 0) {
    const admit = (): Promise<void> => admitFitted(waiting, holder, refuse);
    await (holder.box ? queued(holder.box, admit) : admit());
  }
  return refused;
}

/** The files past the byte total, in once the whole turn is fitted, as many as it then holds. */
async function admitFitted(waiting: { attachment: Attachment; name: string }[], holder: Holder, refuse: (message: string) => void): Promise<void> {
  const fitted = await fitWith(() => holder.held(), waiting.map(item => item.attachment), holder.codec);
  if (fitted.lighter.size > 0) holder.replace(fitted.lighter);
  waiting.forEach((item, at) => {
    const attachment = fitted.incoming[at]!;
    if (holder.held().length >= ATTACHMENTS_PER_TURN) {
      refuse(fill(strings.composer.attachTooMany, { name: item.name, max: String(ATTACHMENTS_PER_TURN) }));
      return;
    }
    if (passesTotal(holder.held(), attachment)) {
      refuse(fill(strings.composer.attachTotalTooLarge, { name: item.name, max: bytes(ATTACHMENTS_TOTAL_MAX_BYTES) }));
      return;
    }
    holder.add(attachment);
  });
}

/**
 * Whether a send from `box` may go: once what runs on it ended, still the box
 * the composer shows (`current`), with what was `typed` when Send was pressed
 * (text, references, chips) unchanged, and within the byte total, said in
 * `store.error` when not. A send that may not go leaves the box as it is, the
 * words written while it waited included. Waits only while a fit runs.
 */
export function readyToSend(store: Store, box: { attachments: Attachment[] }, current: () => object, typed: () => unknown = () => null): boolean | Promise<boolean> {
  const within = (): boolean => {
    if (attachedBytes(box.attachments) <= ATTACHMENTS_TOTAL_MAX_BYTES) return true;
    store.error = fill(strings.composer.attachTotalOver, { max: bytes(ATTACHMENTS_TOTAL_MAX_BYTES) });
    return false;
  };
  const fit = fitting(box);
  if (!fit) return within();
  const pressed = JSON.stringify(typed());
  return fit.then(() => current() === box && JSON.stringify(typed()) === pressed && within());
}

/** A composer input that takes files: its list, placeholders included, and what to do as each one moves. */
export interface Receiver {
  /** What the reads and fits of this input queue on: its state, which a draft keeps when it becomes a thread. */
  input: object;
  attachments: Attachment[];
  /** A placeholder just joined the list: its `[Image N]` goes where the caret is now. */
  placed(placeholder: Attachment): void;
  /** The file read for `placeholder`, or null when it was refused: it takes the placeholder's place. */
  settle(placeholder: Attachment, ready: Attachment | null): void;
  /** Files already in swapped for the lighter copies a fitted turn made of them (`lib/turn-fit.ts`). */
  replace(lighter: Map<Attachment, Attachment>): void;
}

/** Each input's reads, one after another, so every file lands under the number its reference was given. */
const reads = new WeakMap<object, Promise<void>>();

/**
 * The composer's way in, from the attach button, a paste or a drop. Every
 * file shows at once as a loading tile, a picture with its `[Image N]`, and
 * the box keeps taking keys while the files are read behind it, in order.
 * Files settle as they are read while the turn stays under its byte total;
 * past it, they and the rest of the batch stay loading until the turn is
 * fitted once with them (`fitWith`), and only a file that still does not fit
 * is refused. A refusal goes to `store.error` as soon as it is known.
 * Resolves once every file of this call has settled.
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
  const others = (placeholder: Attachment) => receiver.attachments.filter(item => item !== placeholder);
  /** Files read past the byte total, each still behind its loading placeholder. */
  const pending: { placeholder: Attachment; attachment: Attachment; name: string }[] = [];
  // On the input's fit queue: a paste of copied pictures fitted meanwhile (`fitHeld`) never swaps the same pictures.
  const settleFitted = (batch: typeof pending) => queued(receiver.input, async () => {
    // A fit that throws still settles the tiles: each file goes as it was read when the total leaves it room.
    const fitted = await fitWith(() => readyAttachments(receiver.attachments), batch.map(item => item.attachment), codec)
      .catch(() => ({ lighter: new Map<Attachment, Attachment>(), incoming: batch.map(item => item.attachment) }));
    if (fitted.lighter.size > 0) receiver.replace(fitted.lighter);
    batch.forEach(({ placeholder, name }, at) => {
      const attachment = fitted.incoming[at]!;
      if (!passesTotal(others(placeholder), attachment)) { receiver.settle(placeholder, attachment); return; }
      refuse(fill(strings.composer.attachTotalTooLarge, { name, max: bytes(ATTACHMENTS_TOTAL_MAX_BYTES) }));
      receiver.settle(placeholder, null);
    });
  });
  for (const file of files) if (over.length > 0 || !admit(file)) over.push(file);
  const ahead = reads.get(receiver.input);
  // Full of tiles still being read: these wait behind them, which may leave them a slot.
  if (waiting.length === 0 && (over.length === 0 || !ahead)) { refuseOver(); return Promise.resolve(); }
  const run = (ahead ?? Promise.resolve()).then(async () => {
    admitWaiting();
    let next = 0;
    while (next < waiting.length) {
      for (; next < waiting.length; next++) {
        const [file, placeholder] = waiting[next]!;
        // A read that throws still settles its placeholder: no tile waits forever.
        const result = await readFile(file, () => others(placeholder), noImages, codec)
          .catch(() => ({ refused: fill(strings.composer.attachReadError, { name: file.name }) }));
        if ('refused' in result) {
          refuse(result.refused);
          receiver.settle(placeholder, null);
        } else if (pending.length > 0 || passesTotal(others(placeholder), result.attachment)) {
          // Past the total the file keeps loading: the rest of the batch joins it, and the turn is fitted once.
          pending.push({ placeholder, attachment: result.attachment, name: file.name });
        } else receiver.settle(placeholder, result.attachment);
        admitWaiting();
      }
      // A file the fit refuses leaves a slot: one past the cap may take it, and is read in turn.
      if (pending.length > 0) { await settleFitted(pending.splice(0)); admitWaiting(); }
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
 * references are one undo step; a refused file calls `refused`. A fit swaps
 * pictures already in for lighter copies under the same tiles, in the box
 * and in its undo steps.
 */
export function takeFiles(store: Store, state: ComposerState, files: File[], attachmentProvider: ProviderSummary | null | undefined, refused: () => void, codec?: ImageCodec): Promise<void> {
  const keyOf = () => Object.keys(store.composerStates).find(name => store.composerStates[name] === state);
  return receiveFiles(store, files, {
    input: state,
    get attachments() { return state.attachments; },
    // A file arriving ends a phone's offer to undo clearing this draft: that undo would take the file back.
    set attachments(value: Attachment[]) { closeDraftUndo(undefined, state); checkpoint(state); state.attachments = value; },
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
    },
    replace(lighter) {
      const before = state.attachments;
      state.attachments = before.map(item => lighter.get(item) ?? item);
      before.forEach((item, at) => {
        const light = lighter.get(item);
        if (!light) return;
        // The lighter copy keeps the tile, so a Send waiting on the files still finds the box it was pressed on.
        const landed = state.attachments[at]!;
        loadedFrom(landed, tileKey(item));
        keepSource(light, landed);
        replaceInHistory(state, item, landed);
      });
    }
  }, attachmentProvider, codec);
}
