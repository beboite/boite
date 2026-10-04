const TRIPLES: Record<string, Record<string, string>> = {
  win32: { x64: 'x86_64-pc-windows-msvc' },
  linux: { x64: 'x86_64-unknown-linux-gnu', arm64: 'aarch64-unknown-linux-gnu' },
  darwin: { x64: 'x86_64-apple-darwin', arm64: 'aarch64-apple-darwin' },
};

/** Native builds only: the sidecar and Rust shell must use the same architecture. */
export function nativeTarget(platform = process.platform, arch = process.arch) {
  const triple = TRIPLES[platform]?.[arch];
  if (!triple) throw new Error(`Unsupported native shell target: ${platform} ${arch}`);
  return { triple, suffix: platform === 'win32' ? '.exe' : '' };
}

/**
 * The shell's target: native, or the other architecture of the same OS named by
 * `BOITE_TARGET`, which CI sets to build Intel macOS on an Apple Silicon runner.
 * `bun` is the `bun build --compile` target producing the matching core.
 */
export function shellTarget(requested = process.env.BOITE_TARGET, platform = process.platform, arch = process.arch) {
  const native = nativeTarget(platform, arch);
  if (!requested || requested === native.triple) return { ...native, cross: false, arch };
  const cross = Object.entries(TRIPLES[platform] ?? {}).find(([, triple]) => triple === requested);
  if (!cross) {
    throw new Error(`BOITE_TARGET=${requested}: expected one of ${Object.values(TRIPLES[platform] ?? {}).join(', ')} on ${platform}`);
  }
  return { ...native, triple: requested, cross: true, arch: cross[0] };
}

/** The `bun build --target` producing a core for `platform` and `arch`. */
export function bunTarget(platform: string, arch: string): string {
  const os = { win32: 'windows', linux: 'linux', darwin: 'darwin' }[platform];
  if (!os || !TRIPLES[platform]?.[arch]) throw new Error(`Unsupported core target: ${platform} ${arch}`);
  // Windows and Linux x64 embed the baseline runtime, which runs on CPUs without AVX2.
  return `bun-${os}-${arch}${arch === 'x64' && platform !== 'darwin' ? '-baseline' : ''}`;
}
