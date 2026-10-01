/*
 * Reading a QR code from the phone's camera, to pair a machine without typing
 * its link.
 *
 * Chrome on Android decodes in the browser (`BarcodeDetector`). Safari has no
 * such thing, so the frames go through jsQR there, a chunk loaded on the first
 * scan and never at startup. Nothing leaves the page either way.
 */

interface Detector {
  detect(source: CanvasImageSource): Promise<{ rawValue: string }[]>;
}
type DetectorClass = new (options: { formats: string[] }) => Detector;

/** Why the camera cannot be used, as a key of `strings.machines.scanErrors`. */
export type ScanFailure = 'insecure' | 'denied' | 'missing' | 'failed';

/** The time between two decoded frames: a code held steady is read in one or two. */
const FRAME_MS = 150;
/** The longest side a frame is decoded at; a pairing link's code needs far less. */
const MAX_SIDE = 720;

/** A page on plain HTTP has no `mediaDevices` at all: the camera needs HTTPS. */
export function cameraFailure(error?: unknown): ScanFailure {
  if (typeof navigator.mediaDevices?.getUserMedia !== 'function') return 'insecure';
  const name = (error as { name?: unknown } | undefined)?.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'denied';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'missing';
  return 'failed';
}

/** The rear camera, without sound. The caller stops its tracks. */
export function openCamera(): Promise<MediaStream> {
  if (typeof navigator.mediaDevices?.getUserMedia !== 'function') return Promise.reject(new Error('camera unavailable'));
  return navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' } } });
}

/** One RGBA frame through jsQR, the path Safari takes. Null when no code is in it. */
export async function decodeFrame(data: Uint8ClampedArray, width: number, height: number): Promise<string | null> {
  const { default: jsQR } = await import('jsqr');
  return jsQR(data, width, height, { inversionAttempts: 'dontInvert' })?.data || null;
}

async function reader(): Promise<(video: HTMLVideoElement) => Promise<string | null>> {
  const Native = (window as unknown as { BarcodeDetector?: DetectorClass }).BarcodeDetector;
  if (Native) {
    try {
      const detector = new Native({ formats: ['qr_code'] });
      return async video => (await detector.detect(video))[0]?.rawValue || null;
    } catch { /* a build without the QR format falls through to jsQR */ }
  }
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('no 2d canvas');
  return async video => {
    const scale = Math.min(1, MAX_SIDE / Math.max(video.videoWidth, video.videoHeight));
    const width = Math.round(video.videoWidth * scale), height = Math.round(video.videoHeight * scale);
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    context.drawImage(video, 0, 0, width, height);
    return decodeFrame(context.getImageData(0, 0, width, height).data, width, height);
  };
}

/**
 * Reads frames of a playing video until one holds a code `accept` takes, then
 * resolves with its text. Aborting the signal rejects; a frame that fails to
 * decode is skipped, the next one may not.
 */
export async function scanVideo(video: HTMLVideoElement, signal: AbortSignal, accept: (text: string) => boolean = () => true): Promise<string> {
  const read = await reader();
  for (;;) {
    if (signal.aborted) throw new DOMException('scan stopped', 'AbortError');
    if (video.readyState >= 2 && video.videoWidth > 0) {
      const text = await read(video).catch(() => null);
      if (text && accept(text)) return text;
    }
    await new Promise(resolve => setTimeout(resolve, FRAME_MS));
  }
}
