/**
 * Runs a macOS bundling command again when hdiutil reports "Resource busy".
 * On GitHub's macOS runners a background scan sometimes holds a disk image
 * while hdiutil creates, attaches or detaches it (actions/runner-images#7522);
 * on 2026-10-04 it failed a nightly's Apple Silicon DMG and cost a whole rerun.
 * Any other failure ends at once with the command's own exit code.
 *
 * Usage: bun scripts/ci/hdiutil-retry.ts <bundle directory> -- <command...>
 */
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

export const BUSY = /hdiutil: (create|attach|detach|convert) failed - Resource busy/;
export const ATTEMPTS = 3;
const KEPT_OUTPUT = 256 * 1024;

export type Attempt = () => Promise<{ code: number; output: string }>;

/** Runs `attempt` until it succeeds, fails for another reason, or busy hdiutil used every attempt. */
export async function withRetry(attempt: Attempt, beforeRetry: (next: number) => Promise<void>, attempts = ATTEMPTS): Promise<number> {
  for (let number = 1; ; number++) {
    const { code, output } = await attempt();
    if (code === 0 || !BUSY.test(output) || number >= attempts) return code;
    console.log(`::warning::hdiutil reported Resource busy; bundling again (attempt ${number + 1} of ${attempts})`);
    await beforeRetry(number + 1);
  }
}

type HdiutilInfo = { images?: { 'image-path'?: string; 'system-entities'?: { 'dev-entry'?: string; 'mount-point'?: string }[] }[] };

/** The devices of disk images still attached from under `directory`: what a failed attempt left mounted. */
export function attachedUnder(info: HdiutilInfo, directory: string): string[] {
  const root = resolve(directory) + sep;
  return (info.images ?? [])
    .filter((image) => image['image-path'] && resolve(image['image-path']).startsWith(root))
    .flatMap((image) => {
      const entities = image['system-entities'] ?? [];
      // Detaching the whole disk detaches its slices; the first entry is that disk.
      const disk = entities.find((entity) => entity['dev-entry'] && !/s\d+$/.test(entity['dev-entry']))?.['dev-entry'];
      return disk ? [disk] : [];
    });
}

/** What a busy attempt can leave behind: an attached scratch image and partial `.dmg` files Tauri would publish. */
async function clean(bundle: string): Promise<void> {
  Bun.spawnSync(['sync']);
  const info = Bun.spawnSync(['sh', '-c', 'hdiutil info -plist | plutil -convert json -o - -'], { stdout: 'pipe', stderr: 'pipe' });
  if (info.exitCode === 0) {
    for (const device of attachedUnder(JSON.parse(info.stdout.toString()), bundle)) {
      console.log(`hdiutil-retry: detaching ${device}`);
      Bun.spawnSync(['hdiutil', 'detach', device, '-force'], { stdout: 'inherit', stderr: 'inherit' });
    }
  }
  for (const kind of ['dmg', 'macos']) {
    const directory = join(bundle, kind);
    if (!existsSync(directory)) continue;
    for (const name of readdirSync(directory)) {
      if (name.endsWith('.dmg')) {
        console.log(`hdiutil-retry: removing ${join(directory, name)}`);
        rmSync(join(directory, name), { force: true });
      }
    }
  }
}

/** Streams the command's output as it comes and keeps its tail for the busy check. */
async function run(command: string[]): Promise<{ code: number; output: string }> {
  const child = Bun.spawn(command, { stdout: 'pipe', stderr: 'pipe', stdin: 'inherit' });
  let output = '';
  const pump = async (stream: ReadableStream<Uint8Array>, sink: NodeJS.WriteStream) => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      sink.write(chunk);
      output = (output + decoder.decode(chunk, { stream: true })).slice(-KEPT_OUTPUT);
    }
  };
  await Promise.all([pump(child.stdout, process.stdout), pump(child.stderr, process.stderr)]);
  return { code: await child.exited, output };
}

if (import.meta.main) {
  const [bundle, separator, ...command] = process.argv.slice(2);
  if (!bundle || separator !== '--' || command.length === 0) throw new Error('usage: hdiutil-retry.ts <bundle directory> -- <command...>');
  const code = await withRetry(() => run(command), async (next) => {
    await clean(bundle);
    await Bun.sleep(15_000 * (next - 1));
  });
  process.exit(code);
}
