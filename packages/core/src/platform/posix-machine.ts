import { readdirSync, readFileSync, statfsSync, statSync } from 'node:fs';
import type { MachineGpu, MachineVolume } from '@boite/contracts';

/** Filesystems that hold data on a local disk; tmpfs, overlays, squashfs snaps and network mounts are left out. */
const DISK_FILESYSTEMS = new Set(['ext2', 'ext3', 'ext4', 'xfs', 'btrfs', 'zfs', 'f2fs', 'bcachefs', 'jfs', 'reiserfs', 'vfat', 'exfat', 'ntfs', 'ntfs3', 'fuseblk', 'apfs', 'hfs']);
const NVIDIA_SMI_TIMEOUT_MS = 2_000;
const MIB = 1024 * 1024;

const readText = (path: string): string | null => {
  try { return readFileSync(path, 'utf8'); } catch { return null; }
};

/** `/proc/mounts` writes a space in a path as `\040`. */
const unescapeMount = (field: string) => field.replace(/\\([0-7]{3})/g, (_, code: string) => String.fromCharCode(parseInt(code, 8)));

function volume(name: string): MachineVolume | null {
  try {
    const stats = statfsSync(name);
    const totalBytes = stats.blocks * stats.bsize;
    return totalBytes > 0 ? { name, totalBytes, freeBytes: stats.bavail * stats.bsize } : null;
  } catch {
    return null;
  }
}

/**
 * One row per disk-backed device, at its shortest mount point: btrfs
 * subvolumes and bind mounts of one device are one volume. Boot partitions
 * and snaps are left out.
 */
export function linuxVolumes(mounts: string | null = readText('/proc/self/mounts'), measure: (point: string) => MachineVolume | null = volume): MachineVolume[] {
  if (mounts === null) return [];
  const byDevice = new Map<string, string>();
  for (const line of mounts.split('\n')) {
    const [device, rawPoint, type] = line.split(' ');
    if (device === undefined || rawPoint === undefined || type === undefined || !DISK_FILESYSTEMS.has(type)) continue;
    const point = unescapeMount(rawPoint);
    if (point === '/boot' || point.startsWith('/boot/') || point.startsWith('/snap/')) continue;
    const known = byDevice.get(device);
    if (known === undefined || point.length < known.length) byDevice.set(device, point);
  }
  return [...byDevice.values()].sort().flatMap(point => measure(point) ?? []);
}

const mountedVolumes = (): string[] => {
  try { return readdirSync('/Volumes').map(name => `/Volumes/${name}`); } catch { return []; }
};

const deviceOf = (point: string): number | null => {
  try { return statSync(point).dev; } catch { return null; }
};

/**
 * The startup volume and every disk mounted under `/Volumes`, once per device:
 * `/Volumes/Macintosh HD` leads back to `/`, while two identical sticks stay two rows.
 */
export function macosVolumes(mounted: string[] = mountedVolumes(), device: (point: string) => number | null = deviceOf, measure: (point: string) => MachineVolume | null = volume): MachineVolume[] {
  const seen = new Set<number>();
  return ['/', ...mounted].flatMap(point => {
    const dev = device(point);
    if (dev === null || seen.has(dev)) return [];
    seen.add(dev);
    return measure(point) ?? [];
  });
}

const number = (text: string | undefined): number | null => {
  const value = Number(text?.trim());
  return text !== undefined && text.trim() !== '' && Number.isFinite(value) ? value : null;
};

/** `nvidia-smi --query-gpu=name,utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits`, in MiB. */
export function parseNvidiaSmi(output: string): MachineGpu[] {
  return output.split('\n').map(line => line.split(',')).filter(fields => fields.length >= 4 && fields[0]!.trim() !== '').map(fields => {
    const used = number(fields[2]);
    const total = number(fields[3]);
    return { name: fields[0]!.trim(), percent: number(fields[1]), memoryUsedBytes: used === null ? null : used * MIB, memoryTotalBytes: total === null ? null : total * MIB };
  });
}

async function nvidiaSmi(): Promise<MachineGpu[]> {
  const executable = Bun.which('nvidia-smi');
  if (executable === null) return [];
  try {
    // A helper of the core's own, not an agent's: it is never traced or capped.
    const child = Bun.spawn({ cmd: [executable, '--query-gpu=name,utilization.gpu,memory.used,memory.total', '--format=csv,noheader,nounits'], stdin: 'ignore', stdout: 'pipe', stderr: 'ignore', timeout: NVIDIA_SMI_TIMEOUT_MS });
    const output = await new Response(child.stdout).text();
    return (await child.exited) === 0 ? parseNvidiaSmi(output) : [];
  } catch {
    return [];
  }
}

const VENDORS: Record<string, string> = { '0x1002': 'AMD', '0x8086': 'Intel', '0x10de': 'NVIDIA' };

/**
 * DRM cards from sysfs: amdgpu reports its load and VRAM there, other drivers
 * only that the card exists. NVIDIA cards come from nvidia-smi when it answers.
 */
export function drmGpus(root = '/sys/class/drm', skipNvidia = false): MachineGpu[] {
  let cards: string[] = [];
  try { cards = readdirSync(root).filter(name => /^card\d+$/.test(name)).sort(); } catch { return []; }
  return cards.flatMap(card => {
    const device = `${root}/${card}/device`;
    const vendor = readText(`${device}/vendor`)?.trim().toLowerCase();
    if (vendor === undefined || VENDORS[vendor] === undefined || (skipNvidia && vendor === '0x10de')) return [];
    const product = readText(`${device}/product_name`)?.trim();
    return [{
      name: product || `${VENDORS[vendor]} GPU`,
      percent: number(readText(`${device}/gpu_busy_percent`) ?? undefined),
      memoryUsedBytes: number(readText(`${device}/mem_info_vram_used`) ?? undefined),
      memoryTotalBytes: number(readText(`${device}/mem_info_vram_total`) ?? undefined),
    }];
  });
}

export async function linuxGpus(): Promise<{ gpus: MachineGpu[]; pids: null }> {
  const nvidia = await nvidiaSmi();
  return { gpus: [...nvidia, ...drmGpus('/sys/class/drm', nvidia.length > 0)], pids: null };
}

export function linuxOsLabel(release: string | null = readText('/etc/os-release')): string | null {
  const match = release === null ? null : /^PRETTY_NAME=("?)(.*)\1$/m.exec(release);
  return match?.[2]?.trim() || null;
}

export function macosOsLabel(): string | null {
  const plist = readText('/System/Library/CoreServices/SystemVersion.plist');
  const version = plist === null ? null : /<key>ProductVersion<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1];
  return version ? `macOS ${version}` : 'macOS';
}
