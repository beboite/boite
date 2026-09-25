/**
 * A process that opens a real audio session and plays nothing anybody can hear.
 *
 * `waveOutOpen` on the wave mapper is what puts a process in the Windows mixer,
 * which is exactly what the audio mute has to find. The buffer written is two
 * seconds of zeroed PCM: the session is real, the speakers stay silent. The
 * device is then held open a moment longer so the mute has a session to act on
 * for the whole of the test's window.
 *
 * It prints its pid and exits 0. Nothing here is audible, so `bun test` runs it.
 */
import { dlopen, FFIType, ptr } from 'bun:ffi';

if (process.platform !== 'win32') {
  console.error('silent-tone: Windows only');
  process.exit(2);
}

const MMSYSERR_NOERROR = 0;
/** `WAVE_MAPPER`: whatever the user's default output device is. */
const WAVE_MAPPER = 0xffffffff;
const CALLBACK_NULL = 0;
const WAVE_FORMAT_PCM = 1;
const CHANNELS = 2;
const SAMPLE_RATE = 44100;
const BITS = 16;
const SECONDS = 2;
/** WAVEHDR on x64: lpData, lengths, dwUser, flags, loops, lpNext, reserved. */
const WAVEHDR_SIZE = 48;
const WAVEFORMATEX_SIZE = 18;
/** How long the device stays open after the buffer, so the poll has time to see it. */
const HOLD_MS = 5000;

const winmm = dlopen('winmm.dll', {
  waveOutOpen: {
    args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.u64, FFIType.u64, FFIType.u32],
    returns: FFIType.u32,
  },
  waveOutPrepareHeader: { args: [FFIType.u64, FFIType.ptr, FFIType.u32], returns: FFIType.u32 },
  waveOutWrite: { args: [FFIType.u64, FFIType.ptr, FFIType.u32], returns: FFIType.u32 },
  waveOutUnprepareHeader: { args: [FFIType.u64, FFIType.ptr, FFIType.u32], returns: FFIType.u32 },
  waveOutReset: { args: [FFIType.u64], returns: FFIType.u32 },
  waveOutClose: { args: [FFIType.u64], returns: FFIType.u32 },
}).symbols;

function fail(call: string, code: number): never {
  console.error(`silent-tone: ${call} answered ${code}`);
  process.exit(2);
}

const blockAlign = (CHANNELS * BITS) / 8;
const format = new Uint8Array(WAVEFORMATEX_SIZE);
const formatView = new DataView(format.buffer);
formatView.setUint16(0, WAVE_FORMAT_PCM, true);
formatView.setUint16(2, CHANNELS, true);
formatView.setUint32(4, SAMPLE_RATE, true);
formatView.setUint32(8, SAMPLE_RATE * blockAlign, true);
formatView.setUint16(12, blockAlign, true);
formatView.setUint16(14, BITS, true);
formatView.setUint16(16, 0, true);

const handleOut = new BigUint64Array(1);
const opened = winmm.waveOutOpen(ptr(handleOut), WAVE_MAPPER, ptr(format), 0n, 0n, CALLBACK_NULL);
if (opened !== MMSYSERR_NOERROR) fail('waveOutOpen', opened);
const device = handleOut[0] ?? 0n;

// Every sample is zero: this is a session in the mixer, not a sound.
const audio = new Uint8Array(SECONDS * SAMPLE_RATE * blockAlign);
const header = new Uint8Array(WAVEHDR_SIZE);
const headerView = new DataView(header.buffer);
headerView.setBigUint64(0, BigInt(ptr(audio)), true);
headerView.setUint32(8, audio.byteLength, true);

const prepared = winmm.waveOutPrepareHeader(device, ptr(header), WAVEHDR_SIZE);
if (prepared !== MMSYSERR_NOERROR) fail('waveOutPrepareHeader', prepared);
const written = winmm.waveOutWrite(device, ptr(header), WAVEHDR_SIZE);
if (written !== MMSYSERR_NOERROR) fail('waveOutWrite', written);

// The driver reads these buffers on its own thread for as long as the device is
// open, and the collector frees a typed array after its last use in the script:
// a global reference is what keeps the audio data from being collected
// underneath wdmaud.drv, which segfaults Bun when it is not there.
const keepAlive = { audio, header, format };
(globalThis as unknown as { silentTone: unknown }).silentTone = keepAlive;

console.log(`silent-tone: pid ${process.pid} playing ${SECONDS}s of silence`);

await Bun.sleep(SECONDS * 1000 + HOLD_MS);

winmm.waveOutReset(device);
winmm.waveOutUnprepareHeader(device, ptr(keepAlive.header), WAVEHDR_SIZE);
winmm.waveOutClose(device);
console.log(`silent-tone: done, ${keepAlive.audio.byteLength} bytes of silence`);
process.exit(0);
