import { expect, test } from 'bun:test';
import { MachineResources } from '../src/machine-resources.ts';
import { linuxOsLabel, linuxVolumes, macosVolumes, parseNvidiaSmi } from '../src/platform/posix-machine.ts';
import { engineLoads } from '../src/platform/windows/gpu.ts';
import type { ProcessPlatform } from '../src/platform/types.ts';
import { connect } from '../src/client.ts';
import { echoThread, startTestCore } from './harness.ts';
import { thrown } from './settle.ts';

test('a paired phone reads the whole machine; an agent token cannot', async () => {
  const harness = await startTestCore();
  let phone: Awaited<ReturnType<typeof connect>> | undefined;
  let agent: Awaited<ReturnType<typeof connect>> | undefined;
  let threadId = '';
  try {
    const owner = await harness.connect();
    ({ threadId } = await echoThread(harness, owner));
    harness.core.procs.spawn(threadId, process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { cwd: harness.dataDir });
    const { grant } = await owner.call('pairing.grant', {});
    phone = await connect(harness.url, '', { grant, client: { name: 'machine-test', version: 'test' } });
    const machine = await phone.call('resources.machine', {});
    expect(machine.cpu.cores).toBeGreaterThan(0);
    expect(machine.cpu.percent).toBeGreaterThanOrEqual(0);
    expect(machine.cpu.percent).toBeLessThanOrEqual(100);
    expect(machine.memory.totalBytes).toBeGreaterThan(0);
    if (process.platform !== 'darwin') expect(machine.volumes.length).toBeGreaterThan(0);
    for (const volume of machine.volumes) expect(volume.freeBytes).toBeLessThanOrEqual(volume.totalBytes);
    // Windows names each agent's GPU share, a measured zero included; elsewhere there is no per-process reading.
    if (process.platform === 'win32' && machine.gpus?.length) expect(machine.agentGpu?.map(row => row.threadId)).toContain(threadId);
    else expect(machine.agentGpu).toBeNull();
    expect(JSON.stringify(machine)).not.toContain(harness.dataDir);
    expect(await thrown(phone.call('resources.machine', [] as never))).toThrow('resources.machine: expected an object');
    agent = await connect(harness.url, harness.core.agents.tokenFor(threadId));
    expect(await thrown(agent.call('resources.machine', {}))).toThrow("not one of the agent's methods");
  } finally {
    if (threadId) harness.core.procs.killTree(threadId);
    phone?.close(); agent?.close(); await harness.stop();
  }
}, 20000);

test('callers within a second share one reading, a slow one is waited for, and an agent takes its busiest process', async () => {
  let now = 1000;
  let reads = 0;
  let gate: Promise<void> | null = null;
  const platform = {
    machineMemory: () => ({ totalBytes: 100, availableBytes: 40 }),
    machineGpus: async (pids: ReadonlySet<number>) => {
      reads++;
      expect([...pids].sort()).toEqual([11, 12]);
      if (gate !== null) await gate;
      return { gpus: [{ name: 'GPU', percent: 50, memoryUsedBytes: 1, memoryTotalBytes: 2 }], pids: new Map([[11, 5], [12, 30]]) };
    },
  } as unknown as ProcessPlatform;
  const machine = new MachineResources(platform, 'windows', () => ({ pids: new Map([['agent', [11, 12]], ['idle', []]]), memoryBytes: 7 }), () => now);
  const [first, second] = await Promise.all([machine.read(), machine.read()]);
  expect(second).toBe(first);
  expect(reads).toBe(1);
  expect(first.agentGpu).toEqual([{ threadId: 'agent', percent: 30 }, { threadId: 'idle', percent: 0 }]);
  expect(first.memory).toEqual({ totalBytes: 100, availableBytes: 40, agentBytes: 7 });
  now += 1000;
  await machine.read();
  expect(reads).toBe(2);
  // A sample still running after a second is shared, not overlapped by a second reader.
  let release!: () => void;
  gate = new Promise(resolve => { release = resolve; });
  now += 1000;
  const slow = machine.read();
  now += 5000;
  expect(machine.read()).toBe(slow);
  release();
  await slow;
  expect(reads).toBe(3);
  now += 1000;
  await machine.read();
  expect(reads).toBe(4);
});

test('the busiest engine is the sum of its processes, as Task Manager counts it', () => {
  const luid = 'luid_0x00000000_0x0001409B_phys_0';
  const items = [
    { name: `pid_11_${luid}_eng_0_engtype_3D`, value: 20 },
    { name: `pid_12_${luid}_eng_0_engtype_3D`, value: 25 },
    { name: `pid_12_${luid}_eng_14_engtype_VideoDecode`, value: 40 },
    { name: `pid_13_${luid}_eng_14_engtype_VideoDecode`, value: 80 },
  ];
  const loads = engineLoads(items, new Set([11, 12, 99]));
  expect(loads?.adapters.get('0x00000000_0x0001409b')).toBe(100);
  expect(Object.fromEntries(loads!.pids)).toEqual({ 11: 20, 12: 40, 99: 0 });
  // PDH with no engine counter is no reading, never an idle GPU.
  expect(engineLoads([], new Set([11]))).toBeNull();
});

test('Linux and macOS list each disk once, and nvidia-smi reads in MiB', () => {
  const mounts = [
    '/dev/nvme0n1p2 / btrfs rw 0 0',
    '/dev/nvme0n1p2 /home btrfs rw 0 0',
    '/dev/nvme0n1p1 /boot/efi vfat rw 0 0',
    '/dev/sda1 /mnt/big\\040disk ext4 rw 0 0',
    'tmpfs /tmp tmpfs rw 0 0',
    '/dev/loop3 /snap/core/1 squashfs ro 0 0',
  ].join('\n');
  expect(linuxVolumes(mounts, point => ({ name: point, totalBytes: 10, freeBytes: 4 })).map(row => row.name)).toEqual(['/', '/mnt/big disk']);
  // /Volumes/Macintosh HD is / again; two identical sticks are two disks.
  const devices: Record<string, number> = { '/': 1, '/Volumes/Macintosh HD': 1, '/Volumes/STICK': 2, '/Volumes/STICK 1': 3 };
  expect(macosVolumes(Object.keys(devices).slice(1), point => devices[point] ?? null, point => ({ name: point, totalBytes: 10, freeBytes: 4 })).map(row => row.name)).toEqual(['/', '/Volumes/STICK', '/Volumes/STICK 1']);
  expect(parseNvidiaSmi('NVIDIA GeForce RTX 4070, 12, 2048, 12282\n')).toEqual([{ name: 'NVIDIA GeForce RTX 4070', percent: 12, memoryUsedBytes: 2048 * 1048576, memoryTotalBytes: 12282 * 1048576 }]);
  expect(parseNvidiaSmi('NVIDIA T4, [N/A], 10, 15360\n')[0]!.percent).toBeNull();
  expect(linuxOsLabel('NAME="Debian"\nPRETTY_NAME="Debian GNU/Linux 12 (bookworm)"\n')).toBe('Debian GNU/Linux 12 (bookworm)');
});
