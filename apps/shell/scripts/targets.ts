/** Native builds only: the sidecar and Rust shell must use the same architecture. */
export function nativeTarget(platform = process.platform, arch = process.arch) {
  const triples: Record<string, Record<string, string>> = {
    win32: { x64: 'x86_64-pc-windows-msvc' },
    linux: { x64: 'x86_64-unknown-linux-gnu', arm64: 'aarch64-unknown-linux-gnu' },
    darwin: { x64: 'x86_64-apple-darwin', arm64: 'aarch64-apple-darwin' },
  };
  const triple = triples[platform]?.[arch];
  if (!triple) throw new Error(`Unsupported native shell target: ${platform} ${arch}`);
  return { triple, suffix: platform === 'win32' ? '.exe' : '' };
}
