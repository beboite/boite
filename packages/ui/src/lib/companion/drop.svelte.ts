/*
 * Files and images dropped on the companion, held for its next request: the
 * page shows them as chips under the ask bar and sends them with it. An image
 * becomes a JPEG the way a capture does (`screen.ts`); any other file goes as
 * the file it is, which the core hands the agent as a local path. The core's
 * caps (`ATTACHMENT_MAX_BYTES`, `ATTACHMENTS_PER_TURN`,
 * `ATTACHMENTS_TOTAL_MAX_BYTES`) are checked as each file comes, and a refusal
 * names the file and the cap in the composer's words (`lib/attachments.ts`).
 *
 * The shell leaves the companion's webview its own drag and drop
 * (`companion_window.rs`), so the page hears `dragover` and `drop`; it takes a
 * drop only over the areas marked `data-hit`, the ones the window does not let
 * through.
 */
import { ATTACHMENT_MAX_BYTES, ATTACHMENTS_PER_TURN, ATTACHMENTS_TOTAL_MAX_BYTES, type Attachment, type ImageAttachment } from '@boite/contracts';
import { acceptAttachments, attachedBytes, readAttachmentFile } from '../attachments';
import { bytes } from '../format';
import { isReducible } from '../image-prepare';
import { fill, strings } from '../strings';
import { imageOfFile, type ScreenShot } from './screen';

/** An image made light enough to send under `budget` decoded bytes; null to send the file as it is. */
export type Encode = (file: File, budget: number) => Promise<ImageAttachment | null>;

export interface Gathered {
  /** What is held now: what was, and the files that passed. */
  held: Attachment[];
  /** The first refusal, naming the file and the cap, or null. */
  refused: string | null;
}

/**
 * The dropped files read one by one into attachments, after the ones held.
 * A file that would pass a cap is refused by name and the others go on; one
 * over the size of a single attachment or the room left is never read.
 */
export async function gatherDropped(files: File[], held: Attachment[], encode: Encode = imageOfFile): Promise<Gathered> {
  let current = held;
  let refused: string | null = null;
  const refuse = (message: string) => {
    refused ??= message;
  };
  for (const file of files) {
    const name = file.name || strings.composer.attachUnnamed;
    if (current.length >= ATTACHMENTS_PER_TURN) {
      refuse(fill(strings.composer.attachTooMany, { name, max: String(ATTACHMENTS_PER_TURN) }));
      break;
    }
    const room = ATTACHMENTS_TOTAL_MAX_BYTES - attachedBytes(current);
    let attachment: Attachment | null = isReducible(file) ? await encode(file, Math.min(ATTACHMENT_MAX_BYTES, room)).catch(() => null) : null;
    if (!attachment) {
      if (file.size > ATTACHMENT_MAX_BYTES) {
        refuse(fill(strings.composer.attachTooLarge, { name, max: bytes(ATTACHMENT_MAX_BYTES) }));
        continue;
      }
      if (file.size > room) {
        refuse(fill(strings.composer.attachTotalTooLarge, { name, max: bytes(ATTACHMENTS_TOTAL_MAX_BYTES) }));
        continue;
      }
      try {
        attachment = await readAttachmentFile(file);
      } catch {
        refuse(fill(strings.composer.attachReadError, { name }));
        continue;
      }
    }
    const result = acceptAttachments(current, [attachment]);
    if (result.refused !== null) refuse(result.refused);
    else current = result.accepted;
  }
  return { held: current, refused };
}

/** What goes with a request: the dropped files, then the screen. A string names the cap the two together would pass. */
export function joinScreen(held: Attachment[], shot: ScreenShot | null): Attachment[] | string {
  if (!shot) return held;
  const { accepted, refused } = acceptAttachments(held, shot.images);
  return refused ?? accepted;
}

/** The drag carries files, not text or a link. */
export const carriesFiles = (event: DragEvent): boolean => Array.from(event.dataTransfer?.types ?? []).includes('Files');

/** Over one of the areas that take the pointer (`data-hit`). */
const onArea = (target: EventTarget | null): boolean => target instanceof Element && target.closest('[data-hit]') !== null;

/** `dragover` comes every few tens of milliseconds while a drag stays over the page: its silence is the drag leaving. */
const LEAVE_AFTER_MS = 250;

export class Dropped {
  held = $state.raw<Attachment[]>([]);
  /** Files are dragged over the companion: it opens its eyes wide. */
  over = $state(false);
  reading = $state(false);
  problem = $state('');
  private leaveTimer: ReturnType<typeof setTimeout> | undefined;
  /** The drops read so far, one after the other, and how many are still to read. */
  private queue: Promise<void> = Promise.resolve();
  private waiting = 0;

  /**
   * A drag over the page. Files over an area are offered a copy; elsewhere
   * the page refuses them, so a file never replaces it. True when taken.
   */
  dragover(event: DragEvent): boolean {
    if (!carriesFiles(event)) return false;
    event.preventDefault();
    const taken = onArea(event.target);
    if (event.dataTransfer) event.dataTransfer.dropEffect = taken ? 'copy' : 'none';
    this.over = taken;
    clearTimeout(this.leaveTimer);
    if (taken) this.leaveTimer = setTimeout(() => (this.over = false), LEAVE_AFTER_MS);
    return taken;
  }

  /** Files let go over an area: they are read and held. The reading, or null when the drop is not taken. */
  drop(event: DragEvent): Promise<void> | null {
    if (!carriesFiles(event)) return null;
    event.preventDefault();
    clearTimeout(this.leaveTimer);
    this.over = false;
    const files = Array.from(event.dataTransfer?.files ?? []);
    if (!onArea(event.target) || files.length === 0) return null;
    return this.add(files);
  }

  /** One drop is read at a time, each from what the one before it held: a second drop never overwrites the first. */
  add(files: File[]): Promise<void> {
    this.waiting += 1;
    this.reading = true;
    const reading = this.queue.then(() => this.read(files)).finally(() => {
      this.waiting -= 1;
      this.reading = this.waiting > 0;
    });
    this.queue = reading.catch(() => {});
    return reading;
  }

  private async read(files: File[]): Promise<void> {
    const { held, refused } = await gatherDropped(files, this.held);
    this.held = held;
    this.problem = refused ?? '';
  }

  remove(index: number): void {
    this.held = this.held.filter((_, at) => at !== index);
    this.problem = '';
  }

  clear(): void {
    this.held = [];
    this.problem = '';
  }

  dispose(): void {
    clearTimeout(this.leaveTimer);
  }
}
