import {expect} from 'bun:test';
import type {Captured} from './capture.ts';

/** Shared assertions for the original and stdout cleanup DEBUG pairs. */
export function verifyDebugRouting(label:string,result:Captured,marker:string,peerMarker:string,verify:(label:string,assertion:()=>void)=>boolean):void {
  // Every generation must correspond to a verified exact target image,
  // not a count padded by an auxiliary created before inspector output.
  const targets = [...result.out.matchAll(new RegExp(`^inspect-start=${marker}\\.generation-[012] pid=(\\d+)\\r?$`, 'gm'))].map(match => match[1]!);
  verify(`${label} target identities`, () => {
    expect(new Set(targets).size).toBe(3);
    expect(result.err.match(/debug-image .*role=target identity=1 .*error=0/g)).toHaveLength(3);
    for (const pid of targets) {
      expect(result.err).toMatch(new RegExp(`debug-image pid=${pid} tid=\\d+ handle-tid=\\d+ thread-owner=${pid} root=[01] role=target identity=1 .*error=0`));
      expect(result.err).toMatch(new RegExp(`debug-event-boundary pid=${pid} tid=\\d+ verified=1 error=0`));
      expect(result.err).toContain(`token-cleanup role=boundary pid=${pid} success=1 error=0`);
    }
    for (let depth = 1; depth < 3; depth++) {
      expect(result.err).toMatch(new RegExp(`debug-parent pid=${targets[depth]} query=0x00000000 bytes=48 known=1 reported-pid=${targets[depth]} parent=${targets[depth - 1]}(?:\\r?\\n|$)`));
    }
  });
  const auxiliary = [...result.err.matchAll(/debug-image pid=(\d+) tid=\d+ handle-tid=\d+ thread-owner=\d+ root=0 role=auxiliary identity=1 .*error=0/g)];
  verify(`${label} one exact console auxiliary per target`, () => {
    expect(auxiliary).toHaveLength(3);
    expect(new Set(auxiliary.map(match => match[1]!)).size).toBe(3);
    expect(result.err).not.toContain('role=unknown');
    expect(result.err).toContain('debug-file label=trusted-conhost');
    const parents: string[] = [];
    for (const match of auxiliary) {
      const pid = match[1]!;
      expect(targets).not.toContain(pid);
      expect(result.err).toMatch(new RegExp(`debug-event-boundary pid=${pid} tid=\\d+ verified=1 error=0`));
      expect(result.err).toContain(`token-cleanup role=boundary pid=${pid} success=1 error=0`);
      const parent = result.err.match(new RegExp(`debug-parent pid=${pid} query=0x00000000 bytes=48 known=1 reported-pid=${pid} parent=(\\d+)(?:\\r?\\n|$)`));
      expect(parent).not.toBeNull();
      parents.push(parent![1]!);
    }
    expect(new Set(parents)).toEqual(new Set(targets));
    expect(result.err).toContain('target-count=3 auxiliary-count=3 error=0');
  });
  verify(`${label} pinned native startup rule`, () => expect(result.err)
    .toContain('debug-startup-rule pinned=1 site-rva=0x0011ee1d symbol=LdrpDoDebuggerBreak+0x35 code-bytes=62'));
  for (let depth = 0; depth < 3; depth++) {
    verify(`${label} generation ${depth} routing`, () => expect(result.out)
      .toContain(`${marker}.generation-${depth} appcontainer=1 in-job=1 routing=1`));
    verify(`${label} generation ${depth} exit`, () => expect(result.out)
      .toContain(`${marker}.generation-${depth} inspect-exit=0 child-exit=0 forced=0`));
    verify(`${label} generation ${depth} application exception`, () => expect(result.out)
      .toContain(`${marker}.generation-${depth} application-exception-forwarded=1 handler-removed=1`));
  }
  verify(`${label} distinct marker`, () => expect(result.out).not.toContain(peerMarker));
  for (const pid of [...targets, ...auxiliary.map(match => match[1]!)]) {
    verify(`${label} process ${pid} loader breakpoint`, () => expect(result.err).toMatch(new RegExp(
      `debug-exception pid=${pid} code=0x80000003 first=1 .*consumed=1 .*native-identity=1 in-native=1 native-rva=0x11ee1d continuation=0x00010002`)));
    if (targets.includes(pid)) verify(`${label} process ${pid} application exception forwarded`, () => expect(result.err).toMatch(new RegExp(
      `debug-exception pid=${pid} code=0xe0424f49 first=1 .*consumed=0 .*continuation=0x80010001 parameters=2 payload=0x626f6974 owner=${pid}(?:\\r?\\n|$)`)));
  }
  // Three target generations, each with its own file-identified, confined
  // console helper. Unknown images and a second helper per target fail.
  verify(`${label} mapped processes`, () => expect(result.err.match(/private-map pid=\d+ set=0x00000000/g)).toHaveLength(6));
  verify(`${label} loader breakpoints`, () => expect(result.err.match(/debug-exception .*consumed=1/g)).toHaveLength(6));
  verify(`${label} process exit events`, () => expect(result.err.match(/debug-exit pid=\d+ status=0 active=\d+/g)).toHaveLength(6));
  verify(`${label} normal drain`, () => expect(result.err).toContain('debug-drain cleanup=0 captured=6 remaining=0 error=0'));
  verify(`${label} cleanup drain`, () => expect(result.err).toContain('debug-drain cleanup=1 captured=6 remaining=0 error=0'));
}
