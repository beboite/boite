/**
 * What one walk of the audio mute costs: the default render endpoint's
 * sessions read for their pid and mute, then released, as `MuteLogic.tick`
 * does with a traced pid that owns none of them, so nothing is muted. `extra`
 * copies of the silent-tone fixture add sessions of zeroed PCM, which nobody
 * hears for about eight seconds, so the walks measured fit inside that. Windows
 * only. Prints the fewest and most sessions a measured walk met, and CPU and wall
 * time per walk.
 *
 *   bun bench/audio-walk.ts [extra=0] [walks=200]
 */
import { join } from 'node:path';
import { coInitialize, coUninitialize, openSessions } from '../packages/core/src/platform/windows/audio-sessions.ts';
import { AudioEndpoint } from '../packages/core/src/platform/windows/audio-endpoint.ts';
import { MuteLogic } from '../packages/core/src/platform/windows/mute-logic.ts';

if (process.platform !== 'win32') throw new Error('audio-walk: Windows only');
const extra = Number(process.argv[2] ?? 0);
const walks = Number(process.argv[3] ?? 200);
const FIXTURE = join(import.meta.dir, '../packages/core/test/fixtures/silent-tone.ts');
/** A pid no process has: every session the walk meets is someone else's. */
const NOBODY = 0x7ffffff0;

coInitialize();
const endpoint = new AudioEndpoint(openSessions);
let sessions = 0;
const mute = new MuteLogic((skipped) => {
  const list = endpoint.list(skipped);
  sessions = list.length;
  return list;
}, true);
mute.addPid('bench', NOBODY);
mute.tick();
const before = sessions;
const tones = Array.from({ length: extra }, () => Bun.spawn(['bun', FIXTURE], { stdout: 'ignore', stderr: 'inherit' }));
try {
  const deadline = Date.now() + 5000;
  while (sessions < before + extra && Date.now() < deadline) {
    await Bun.sleep(100);
    mute.tick();
  }
  for (let i = 0; i < 20; i++) mute.tick();
  const cpu = process.cpuUsage();
  const start = Bun.nanoseconds();
  let fewest = Infinity;
  let most = 0;
  for (let i = 0; i < walks; i++) {
    mute.tick();
    fewest = Math.min(fewest, sessions);
    most = Math.max(most, sessions);
  }
  const wall = (Bun.nanoseconds() - start) / 1e6;
  const used = process.cpuUsage(cpu);
  console.log(JSON.stringify({
    date: new Date().toISOString(),
    sessions: { fewest, most },
    walks,
    cpuMsPerWalk: Number(((used.user + used.system) / 1000 / walks).toFixed(3)),
    wallMsPerWalk: Number((wall / walks).toFixed(3)),
    muted: mute.mutedPids().length,
  }));
} finally {
  for (const tone of tones) tone.kill();
  await Promise.all(tones.map((tone) => tone.exited));
  endpoint.release();
  coUninitialize();
}
