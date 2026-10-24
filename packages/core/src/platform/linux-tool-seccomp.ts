/** Classic seccomp BPF, installed by bubblewrap before exec and inherited across fork/exec.
 * Namespace creation is denied in the kernel. This also works inside LXC where
 * bubblewrap's --disable-userns cannot write the read-only user namespace sysctl.
 */
export function linuxToolSeccomp(arch: string = process.arch): Buffer {
  const numbers = arch === 'x64'
    ? {audit: 0xc000003e, clone: 56, socket: 41, denied: [101, 155, 161, 165, 166, 169, 175, 176, 246, 248, 249, 250, 272, 298, 303, 304, 308, 310, 311, 313, 321, 323]}
    : arch === 'arm64'
      ? {audit: 0xc00000b7, clone: 220, socket: 198, denied: [39, 40, 41, 51, 97, 104, 105, 106, 117, 142, 217, 218, 219, 241, 264, 265, 268, 270, 271, 273, 280, 282]}
      : null;
  if (!numbers) throw new Error('execution.linux.arch: seccomp protection supports x64 and arm64 only');
  const instructions: [number, number, number, number][] = [];
  const add = (code: number, jt: number, jf: number, k: number) => instructions.push([code, jt, jf, k]);
  const deny = 0x00050000 | 1; // SECCOMP_RET_ERRNO | EPERM
  add(0x20, 0, 0, 4); // seccomp_data.arch
  add(0x15, 1, 0, numbers.audit);
  add(0x06, 0, 0, 0x80000000); // KILL_PROCESS on a foreign syscall ABI
  add(0x20, 0, 0, 0); // seccomp_data.nr
  if (arch === 'x64') { add(0x45, 0, 1, 0x40000000); add(0x06, 0, 0, 0x80000000); } // no x32 bypass
  add(0x15, 0, 1, 435); // clone3 is opaque; libc must use its ordinary clone fallback.
  add(0x06, 0, 0, 0x00050000 | 38); // ENOSYS
  for (const syscall of [...numbers.denied, 425, 426, 427, 428, 429, 430, 431, 432, 433, 442]) {
    add(0x15, 0, 1, syscall); add(0x06, 0, 0, deny);
  }
  // Pathname UNIX sockets can cross network namespaces through public runtime mounts.
  // Fresh socketpair descriptors remain usable for ordinary local tool IPC.
  add(0x15, 0, 4, numbers.socket);
  add(0x20, 0, 0, 16);
  add(0x15, 0, 1, 1); // AF_UNIX
  add(0x06, 0, 0, deny);
  add(0x20, 0, 0, 0);
  add(0x15, 0, 3, numbers.clone);
  add(0x20, 0, 0, 16); // clone flags, low 32 bits on both supported little-endian ABIs
  add(0x45, 0, 1, 0x7e020000); // CLONE_NEW{NS,CGROUP,UTS,IPC,USER,PID,NET}
  add(0x06, 0, 0, deny);
  add(0x06, 0, 0, 0x7fff0000); // ALLOW ordinary project tools and threads
  const bytes = Buffer.alloc(instructions.length * 8);
  instructions.forEach(([code, jt, jf, k], i) => {
    bytes.writeUInt16LE(code, i * 8); bytes[i * 8 + 2] = jt; bytes[i * 8 + 3] = jf; bytes.writeUInt32LE(k, i * 8 + 4);
  });
  return bytes;
}
