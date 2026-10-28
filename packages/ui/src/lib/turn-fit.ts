/**
 * A turn's images made to fit its byte budget together. Each image is first
 * prepared alone (`lib/image-prepare.ts`: 2000 px, JPEG at 0.85), which puts
 * twenty phone screenshots in a turn; fifty of them weigh twice
 * `ATTACHMENTS_TOTAL_MAX_BYTES`. That total cannot grow (the user message
 * travels and is journalled inline, and a Claude request stops at 32 MB), so
 * the images give way instead: lower JPEG quality first, then a shorter long
 * edge, never under `FIT_FLOOR_EDGE` pixels.
 *
 * Nothing moves while the turn is under budget. Past it, the budget is shared
 * out: an image lighter than its share stays as it is and the heavier ones are
 * brought under theirs, each from the copy it arrived with. A GIF keeps its
 * frames, a file stays a file and a draft picture whose bytes are still on
 * their way stays out of it; they all count at their weight.
 */
import { ATTACHMENTS_TOTAL_MAX_BYTES, decodedBytes, type Attachment } from '@boite/contracts';
import { decodeBase64 } from './attachment-save';
import { attachedBytes, readAttachmentFile } from './attachments';
import { unresolvedAssetId } from './draft-attachments';
import { browserCodec, fitWithin, renamed, type Decoded, type Encoded, type ImageCodec } from './image-prepare';

/** Past this long edge a screenshot's text stops being readable: the fitting never goes under it. */
export const FIT_FLOOR_EDGE = 1280;
/** Least loss first. Sizes fall along the list, so a binary search finds the first that fits. */
export const FIT_STEPS: readonly { edge: number; quality: number }[] = [
  { edge: 2000, quality: 0.75 },
  { edge: 2000, quality: 0.65 },
  { edge: 1800, quality: 0.6 },
  { edge: 1600, quality: 0.6 },
  { edge: 1440, quality: 0.55 },
  { edge: FIT_FLOOR_EDGE, quality: 0.55 },
  { edge: FIT_FLOOR_EDGE, quality: 0.45 },
  { edge: FIT_FLOOR_EDGE, quality: 0.35 }
];
/** A transparent picture tries PNG at these edges before it gives its transparency up for a JPEG. */
const PNG_EDGES = [2000, 1600, FIT_FLOOR_EDGE];

export interface Fitted {
  /** The same attachments in the same order, the heavier images replaced by lighter copies. */
  attachments: Attachment[];
  /** False when even the floor leaves the turn over budget. */
  fits: boolean;
}

function shrinkable(attachment: Attachment): boolean {
  return attachment.kind === 'image' && attachment.mimeType !== 'image/gif' && attachment.data.length > 0 && unresolvedAssetId(attachment) === undefined;
}

/** The level that shares `budget` out: images under it keep their weight, the others get it. */
export function waterLevel(sizes: number[], budget: number): number {
  if (budget <= 0 || sizes.length === 0) return 0;
  let remaining = budget;
  let count = sizes.length;
  for (const size of [...sizes].sort((a, b) => a - b)) {
    if (size > remaining / count) break;
    remaining -= size;
    count -= 1;
  }
  return count === 0 ? Infinity : remaining / count;
}

type Try = { blob: Blob; mimeType: Encoded['mimeType'] };

/** The least reduced copy of `image` within `target` bytes, the lightest one when none is, or `image` when nothing beats it. */
async function shrink(image: Attachment, target: number, codec: ImageCodec): Promise<Attachment> {
  const weight = decodedBytes(image.data);
  let decoded: Decoded | null = null;
  try { decoded = await codec.decode(new File([decodeBase64(image.data)], image.name ?? 'image', { type: image.mimeType })); } catch { decoded = null; }
  if (decoded === null) return image;
  const source = decoded;
  try {
    const tries: Try[] = [];
    const encode = async (edge: number, mimeType: Encoded['mimeType'], quality?: number): Promise<Try | null> => {
      const size = fitWithin(source.width, source.height, edge);
      const blob = await source.encode(size.width, size.height, mimeType, quality);
      if (blob === null) return null;
      const made = { blob, mimeType };
      tries.push(made);
      return made;
    };
    let pick: Try | null = null;
    if (image.mimeType !== 'image/jpeg' && source.hasAlpha()) {
      for (const edge of PNG_EDGES) {
        const made = await encode(edge, 'image/png');
        if (made !== null && made.blob.size <= target) { pick = made; break; }
      }
    }
    if (pick === null) {
      let low = 0;
      let high = FIT_STEPS.length - 1;
      while (low <= high) {
        const middle = (low + high) >> 1;
        const step = FIT_STEPS[middle]!;
        const made = await encode(step.edge, 'image/jpeg', step.quality);
        if (made !== null && made.blob.size <= target) { pick = made; high = middle - 1; } else low = middle + 1;
      }
    }
    pick ??= tries.reduce<Try | null>((best, made) => best === null || made.blob.size < best.blob.size ? made : best, null);
    if (pick === null || pick.blob.size >= weight) return image;
    const name = renamed(image.name ?? 'image', pick.mimeType);
    const made = await readAttachmentFile(new File([pick.blob], name, { type: pick.mimeType }));
    return { ...made, name: image.name === null ? null : name };
  } finally {
    source.close();
  }
}

/**
 * `attachments` within `max` bytes together, or as close as the floor gets.
 * Under budget, the very same array comes back.
 */
export async function fitTurn(attachments: Attachment[], codec: ImageCodec = browserCodec, max = ATTACHMENTS_TOTAL_MAX_BYTES): Promise<Fitted> {
  const sizes = attachments.map(attachment => decodedBytes(attachment.data));
  const total = (): number => sizes.reduce((sum, size) => sum + size, 0);
  if (total() <= max) return { attachments, fits: true };
  const next = [...attachments];
  const open = new Set(attachments.flatMap((attachment, at) => shrinkable(attachment) ? [at] : []));
  // Each round either fits or closes an image that could not reach its share.
  while (total() > max && open.size > 0) {
    const fixed = sizes.reduce((sum, size, at) => open.has(at) ? sum : sum + size, 0);
    const share = waterLevel([...open].map(at => sizes[at]!), max - fixed);
    const over = [...open].filter(at => sizes[at]! > share);
    if (over.length === 0) break;
    for (const at of over) {
      const smaller = await shrink(attachments[at]!, share, codec);
      next[at] = smaller;
      sizes[at] = decodedBytes(smaller.data);
      if (sizes[at]! > share) open.delete(at);
    }
  }
  return { attachments: next, fits: total() <= max };
}

/** The fit running on each box, so a second one waits for the first and a send for both. */
const running = new WeakMap<object, Promise<boolean>>();

/** The fit still running on `target`, or undefined: what a send waits for. */
export function fitting(target: object): Promise<boolean> | undefined {
  return running.get(target);
}

/**
 * What a box holds, fitted in place: for the ways in that join pictures
 * without reading files, a paste of copied pictures or queued prompts taken
 * back. A picture removed while the fitting ran stays removed. Fits of one box
 * run one after the other, so none swaps in copies another already replaced.
 * True only when what the box holds at the end is within the budget.
 */
export function fitHeld(target: { attachments: Attachment[] }, codec?: ImageCodec, max = ATTACHMENTS_TOTAL_MAX_BYTES): Promise<boolean> {
  const previous = running.get(target);
  const run = (previous ?? Promise.resolve(true)).then(() => fitNow(target, codec, max), () => fitNow(target, codec, max));
  running.set(target, run);
  const done = (): void => { if (running.get(target) === run) running.delete(target); };
  run.then(done, done);
  return run;
}

async function fitNow(target: { attachments: Attachment[] }, codec: ImageCodec | undefined, max: number): Promise<boolean> {
  for (;;) {
    const before = target.attachments;
    const fitted = await fitTurn(before, codec, max);
    if (fitted.attachments !== before) {
      const swaps = new Map(before.flatMap((attachment, at) => fitted.attachments[at] === attachment ? [] : [[attachment, fitted.attachments[at]!] as const]));
      target.attachments = target.attachments.map(attachment => swaps.get(attachment) ?? attachment);
    }
    if (attachedBytes(target.attachments) <= max) return true;
    // Over budget: fit again only when pictures joined while this one ran.
    const seen = new Set([...before, ...fitted.attachments]);
    if (!fitted.fits || target.attachments.every(attachment => seen.has(attachment))) return false;
  }
}
