import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DownloadSpec } from './speech-models.ts';
import { safeEntryPath } from './providers/install-unpack.ts';

const NEEDLE = 'https://huggingface.co/Cactus-Compute/needle3/resolve/c7c415a3d1b3d929014bc6e866d51ebb971f7089/';
const NEMOTRON = 'https://huggingface.co/csukuangfj2/sherpa-onnx-nemotron-3.5-asr-streaming-0.6b-560ms-int8-2026-06-11/resolve/ab43d895f5985b1bbab8b6eac8607fcdc05343f3/';

export interface SpeechArtifact extends DownloadSpec { file: string }
const artifact = (file: string, url: string, bytes: number, sha256: string): SpeechArtifact => ({ file, url, bytes, sha256 });

/** Immutable upstream revisions, with every model component verified before activation. */
export const NEMOTRON_FILES: readonly SpeechArtifact[] = [
  artifact('encoder.int8.onnx', `${NEMOTRON}encoder.int8.onnx`, 657601403, '012e9321373af99021415e0b0eb3ec827b4be3153be6f30d9b448fe65e896e68'),
  artifact('decoder.int8.onnx', `${NEMOTRON}decoder.int8.onnx`, 14978075, '19f9c98fc6d0a2c33a65a43b36fdb2e914c26c0aa9764be3aebc502a1e982fb0'),
  artifact('joiner.int8.onnx', `${NEMOTRON}joiner.int8.onnx`, 9504438, '4101c7c679a0bc30483794b27a059e34e79232aa2068d78d51231a22c8b0d7ce'),
  artifact('tokens.txt', `${NEMOTRON}tokens.txt`, 131440, '729cc103155bafa785f9cd45746cd41cabe97eab7182fc04d594129587958f8a'),
];

const WHISTLE_BINARIES: Record<string, SpeechArtifact> = {
  'linux-x64': artifact('needle', `${NEEDLE}linux-x86_64/needle`, 1517200, 'b197ceaef3b300a0b14c3a4fde92305527e43f9256c53d2a53d2a2fe8fe69678'),
  'linux-arm64': artifact('needle', `${NEEDLE}linux-arm64/needle`, 1409312, 'bcf48b66a3e1834e8cb92c9f9998d85d4618d3e949c8a9d293116749a1f0d205'),
  'win32-x64': artifact('needle.exe', `${NEEDLE}windows-x86_64/needle.exe`, 1540096, 'c70ca998f6c542c862c06c22352046e303ef5c769384069ee25cef9f4667e4cf'),
  'win32-arm64': artifact('needle.exe', `${NEEDLE}windows-arm64/needle.exe`, 1331712, '078a7659770c5117458abf23b320e7de603aeac8d0d9cbbb31eb65eedbc0795d'),
  'darwin-arm64': artifact('needle', `${NEEDLE}macos-arm64/needle`, 1073160, 'f52c9ce7c05ef44e8d8441584aec9e6ac6054f811866eacd70f33da2462577dc'),
};

const SHERPA_PACKAGES: Record<string, [string, number, string]> = {
  'linux-x64': ['linux-x64', 11089653, '13291bcd825da5858ca27a35443e9a2c229a40616c0910086de2db12c5c9312c'],
  'linux-arm64': ['linux-arm64', 13910679, 'e1671ad6e94e51947229a5736d06022780f3fba967da8d917173cd9765902ee8'],
  'win32-x64': ['win-x64', 8894875, 'fe522f02a5c113c2567a43982107ef41ae517f9a431931e90731e7e4d4341073'],
  'darwin-x64': ['darwin-x64', 11191481, '3e583d3423160cb8a0f9316008e293ad9a6b66c63e1966ad399a88300390fbaa'],
  'darwin-arm64': ['darwin-arm64', 10047754, 'e1abc1d9676478996574de922e55714d80b4500b860bc4e7349aa01cd0ea4929'],
};

export function whistleRuntime(platform = process.platform, arch = process.arch): SpeechArtifact | undefined {
  return WHISTLE_BINARIES[`${platform}-${arch}`];
}

export function sherpaRuntime(platform = process.platform, arch = process.arch): SpeechArtifact[] | null {
  const pkg = SHERPA_PACKAGES[`${platform}-${arch}`];
  if (!pkg) return null;
  const [suffix, bytes, sha256] = pkg;
  return [
    artifact('bindings.tgz', 'https://registry.npmjs.org/sherpa-onnx-node/-/sherpa-onnx-node-1.13.8.tgz', 11954, 'db2a7b8b18d950b6e9ca5c1c919afec33fd3dd2bfef1aade0bea5a9fe7a1f0f1'),
    artifact('native.tgz', `https://registry.npmjs.org/sherpa-onnx-${suffix}/-/sherpa-onnx-${suffix}-1.13.8.tgz`, bytes, sha256),
  ];
}

/** Small, pinned npm packages only. No install scripts, links, or arbitrary archive paths execute. */
export async function unpackSpeechRuntime(archive: string, target: string, signal: AbortSignal): Promise<void> {
  const { gunzipSync } = await import('fflate');
  // The largest uncompressed platform package is 35 MB. Cap allocation before inflating.
  const compressed = new Uint8Array(await Bun.file(archive).arrayBuffer());
  const size = new DataView(compressed.buffer, compressed.byteOffset, compressed.byteLength).getUint32(compressed.length - 4, true);
  if (size > 40 * 1024 * 1024) throw new Error('speech runtime: archive exceeds 40 MiB');
  const tar = gunzipSync(compressed, { out: new Uint8Array(size) });
  const text = (from: number, to: number) => new TextDecoder().decode(tar.subarray(from, to)).split('\0')[0]!;
  mkdirSync(target, { recursive: true });
  for (let offset = 0; offset + 512 <= tar.length;) {
    signal.throwIfAborted();
    const name = text(offset, offset + 100);
    if (!name) break;
    const bytes = Number.parseInt(text(offset + 124, offset + 136).trim(), 8);
    const type = tar[offset + 156];
    if (!Number.isSafeInteger(bytes) || bytes < 0 || offset + 512 + bytes > tar.length) throw new Error('speech runtime: invalid tar size');
    if (safeEntryPath(name) !== name || !name.startsWith('package/') || text(offset + 345, offset + 500)) throw new Error(`speech runtime: unexpected path ${name}`);
    if (type !== 0 && type !== 48) throw new Error(`speech runtime: expected a regular file: ${name}`);
    const file = name.slice(8);
    if (file.includes('/')) throw new Error(`speech runtime: unexpected nested file ${name}`);
    writeFileSync(join(target, file), tar.subarray(offset + 512, offset + 512 + bytes), { mode: 0o600 });
    offset += 512 + Math.ceil(bytes / 512) * 512;
    await new Promise<void>(done => setImmediate(done));
  }
}
