import {createHash} from 'node:crypto';
import {chmodSync, closeSync, constants, existsSync, fstatSync, ftruncateSync, lstatSync, mkdirSync, mkdtempSync, openSync, readSync, readdirSync, realpathSync, rmSync, unlinkSync, writeSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join, relative, resolve, sep} from 'node:path';
import {inside, policyIdentity, secretPath, secretText} from '../contacts/file-policy.ts';
import {assertExecutionPolicy, executionIdentity, type ExecutionPolicy} from '../execution-policy.ts';

interface FileState {identity: string; digest: string; mode: number; override: boolean}
const safeName = (name: string): boolean => !/[\\:\x00-\x1f]/.test(name) && !/[. ]$/.test(name);

/** A private, link-free tool filesystem. No writable bind ever points at the host checkout. */
export class ProtectedCheckout {
  readonly scratch: string;
  readonly root: string;
  private readonly files = new Map<string, FileState>();
  private readonly directories = new Map<string, string>();
  private closed = false;

  constructor(readonly policy: ExecutionPolicy, temporary = tmpdir()) {
    this.scratch = mkdtempSync(join(temporary, `boite-protected-${policy.capabilityId}-`));
    this.root = join(this.scratch, 'checkout');
    try {
      mkdirSync(this.root, {mode: 0o700});
      this.capture('');
      this.checkOverrides();
      assertExecutionPolicy(policy);
    } catch (error) { this.close(); throw error; }
  }

  private credential(path: string): boolean { return this.policy.credentialPaths.some(c => inside(c, path)); }
  private override(path: string, identity: string): boolean {
    return this.policy.readOverrides.some(o => o.path === path && o.identity === identity && o.expiresAt > Date.now());
  }
  private overrideParent(path: string): boolean { return this.policy.readOverrides.some(o => o.path.startsWith(`${path}/`)); }

  private capture(path: string): void {
    const source = join(this.policy.checkout, path);
    this.directories.set(path, executionIdentity(source));
    for (const entry of readdirSync(source, {withFileTypes: true})) {
      const rel = path ? `${path}/${entry.name}` : entry.name;
      const from = join(source, entry.name), to = join(this.root, rel);
      if (!safeName(entry.name) || this.credential(from)) continue;
      // No symlink or special file is followed. Hard links cannot attest a secret-free origin.
      const stat = lstatSync(from, {bigint: true});
      if (stat.isDirectory()) {
        if (secretPath(rel) && !this.overrideParent(rel)) continue;
        mkdirSync(to, {mode: 0o700});
        this.capture(rel);
      } else if (stat.isFile()) {
        const identity = policyIdentity(from, stat), override = this.override(rel, identity);
        if ((secretPath(rel) || stat.nlink !== 1n) && !override) continue;
        const file = this.copy(from, to, override);
        if (file) this.files.set(rel, {...file, identity, override});
      }
    }
  }

  /** Scan and copy from one no-follow descriptor, then verify it did not change while read. */
  private copy(from: string, to: string, allowSecret: boolean): Omit<FileState, 'identity' | 'override'> | null {
    const fd = openSync(from, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let output: number | undefined;
    try {
      const before = fstatSync(fd, {bigint: true});
      if (!before.isFile() || before.nlink !== 1n && !allowSecret) throw new Error('execution.file: expected a regular file without unauthorized hard links');
      output = openSync(to, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600 | Number(before.mode & 0o111n));
      const buffer = Buffer.alloc(65536), digest = createHash('sha256');
      let tail = '', secret = false;
      for (;;) {
        const count = readSync(fd, buffer, 0, buffer.length, null);
        if (!count) break;
        const bytes = buffer.subarray(0, count);
        const text = tail + bytes.toString('utf8');
        secret ||= secretText(text) !== null;
        tail = text.slice(-1024);
        digest.update(bytes);
        let offset = 0;
        while (offset < count) offset += writeSync(output, bytes, offset, count - offset);
      }
      if (policyIdentity(from, before) !== policyIdentity(from, fstatSync(fd, {bigint: true}))) throw new Error('execution.file: source changed during capture');
      if (secret && !allowSecret) { unlinkSync(to); return null; }
      return {digest: digest.digest('hex'), mode: Number(before.mode & 0o777n)};
    } finally { closeSync(fd); if (output !== undefined) closeSync(output); }
  }

  checkOverrides(): void {
    for (const override of this.policy.readOverrides) {
      const source = join(this.policy.checkout, override.path);
      const state = this.files.get(override.path);
      if (!state?.override || Date.now() >= override.expiresAt || this.credential(source)
        || realpathSync(source) !== source || policyIdentity(source, lstatSync(source, {bigint: true})) !== override.identity) {
        throw new Error('execution.readOverrides: expected the same authorized file and live expiry');
      }
    }
  }

  /** Verify the whole candidate before writing. Host changes conflict rather than overwrite newer work. */
  flush(): readonly string[] {
    if (this.closed) throw new Error('execution.checkout: private view is closed');
    assertExecutionPolicy(this.policy);
    this.checkOverrides();
    const publication = mkdtempSync(join(this.scratch, 'publish-'));
    const next = new Map<string, Omit<FileState, 'identity' | 'override'>>();
    try {
      const walk = (path: string): void => {
        for (const entry of readdirSync(join(this.root, path), {withFileTypes: true})) {
          const rel = path ? `${path}/${entry.name}` : entry.name;
          const from = join(this.root, rel), dest = join(publication, rel);
          const stat = lstatSync(from, {bigint: true});
          const previous = this.files.get(rel);
          if (!safeName(entry.name) || this.credential(join(this.policy.checkout, rel)) || secretPath(rel) && !(stat.isDirectory() ? this.overrideParent(rel) : previous?.override)
            || stat.isSymbolicLink() || !stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1n)) throw new Error('execution.result: secret, linked or special project output is not publishable');
          if (stat.isDirectory()) { mkdirSync(dest); walk(rel); }
          else {
            const file = this.copy(from, dest, previous?.override ?? false);
            if (!file) throw new Error('execution.result: credential-like output is not publishable');
            if (previous?.override && file.digest !== previous.digest) throw new Error('execution.readOverrides: read exceptions cannot modify the authorized file');
            next.set(rel, file);
          }
        }
      };
      walk('');
      const changed = [...next].filter(([path, state]) => this.files.get(path)?.digest !== state.digest).map(([path]) => path);
      changed.push(...[...this.files.keys()].filter(path => !next.has(path)));
      for (const [path, identity] of this.directories) {
        const host = join(this.policy.checkout, path);
        if (!lstatSync(host).isDirectory() || realpathSync(host) !== host || executionIdentity(host) !== identity) throw new Error('execution.checkout: captured directory was replaced');
      }
      for (const [path, file] of this.files) {
        const host = join(this.policy.checkout, path);
        if (policyIdentity(host, lstatSync(host, {bigint: true})) !== file.identity) throw new Error('execution.result: host file changed since capture');
        if (file.override && !next.has(path)) throw new Error('execution.readOverrides: read exceptions cannot delete the authorized file');
      }
      // Validate every new target and its parents, including paths absent from the original view.
      for (const path of next.keys()) this.checkDestination(path);
      assertExecutionPolicy(this.policy);
      this.checkOverrides();
      for (const [path, state] of next) {
        if (this.files.get(path)?.digest === state.digest) continue;
        const host = join(this.policy.checkout, path);
        this.makeParents(dirname(path));
        const existed = this.files.has(path);
        // No truncation until the captured inode is checked through its held descriptor.
        const fd = openSync(host, (process.platform === 'win32' ? constants.O_RDWR : constants.O_WRONLY)
          | constants.O_NOFOLLOW | (existed ? 0 : constants.O_CREAT | constants.O_EXCL), 0o600 | (state.mode & 0o111));
        try {
          if (existed && !this.sameWriteTarget(host, fd, this.files.get(path)!)) throw new Error('execution.result: host file changed before write');
          const input = openSync(join(publication, path), constants.O_RDONLY | constants.O_NOFOLLOW);
          try {
            const bytes = Buffer.alloc(65536);
            let offset = 0;
            for (;;) {
              const count = readSync(input, bytes, 0, bytes.length, null);
              if (!count) break;
              let written = 0;
              while (written < count) written += writeSync(fd, bytes, written, count - written, offset + written);
              offset += count;
            }
            // Use the descriptor, not a path which could have been replaced.
            ftruncateSync(fd, offset);
          } finally { closeSync(input); }
        } finally { closeSync(fd); }
      }
      for (const path of this.files.keys()) if (!next.has(path)) unlinkSync(join(this.policy.checkout, path));
      this.files.clear();
      for (const [path, state] of next) {
        const host = join(this.policy.checkout, path);
        this.files.set(path, {...state, identity: policyIdentity(host, lstatSync(host, {bigint: true})), override: this.policy.readOverrides.some(o => o.path === path)});
      }
      return changed;
    } finally { rmSync(publication, {recursive: true, force: true}); }
  }

  private sameWriteTarget(path: string, fd: number, expected: FileState): boolean {
    const opened = fstatSync(fd, {bigint: true});
    if (policyIdentity(path, opened) === expected.identity) return true;
    if (process.platform !== 'win32') return false;
    // NTFS can update ChangeTime just by opening an existing file for writing.
    // Retain the file object, size and LastWriteTime check, and compare the actual
    // captured bytes through that same descriptor before allowing any write.
    const withoutChangeTime = (identity: string) => identity.slice(0, identity.lastIndexOf('|'));
    if (!opened.isFile() || withoutChangeTime(policyIdentity(path, opened)) !== withoutChangeTime(expected.identity)) return false;
    const digest = createHash('sha256'), bytes = Buffer.alloc(65536);
    let offset = 0;
    for (;;) {
      const count = readSync(fd, bytes, 0, bytes.length, offset);
      if (!count) break;
      digest.update(bytes.subarray(0, count)); offset += count;
    }
    return digest.digest('hex') === expected.digest;
  }

  private checkDestination(path: string): void {
    const target = resolve(this.policy.checkout, path);
    if (!inside(this.policy.checkout, target)) throw new Error('execution.result: output must stay in checkout');
    let current = this.policy.checkout;
    const parts = relative(this.policy.checkout, target).split(sep);
    for (let i = 0; i < parts.length; i++) {
      current = join(current, parts[i]!);
      let s;
      try { s = lstatSync(current); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      if (s.isSymbolicLink() || i < parts.length - 1 && !s.isDirectory() || i === parts.length - 1 && !this.files.has(path)) {
        throw new Error('execution.result: output would replace a hidden or linked host path');
      }
    }
  }

  private makeParents(path: string): void {
    if (path === '.') return;
    let rel = '';
    for (const part of path.split('/')) {
      rel = rel ? `${rel}/${part}` : part;
      const host = join(this.policy.checkout, rel);
      try { mkdirSync(host, {mode: 0o700}); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      if (!lstatSync(host).isDirectory() || realpathSync(host) !== host) throw new Error('execution.result: expected a real checkout directory');
      this.directories.set(rel, executionIdentity(host));
    }
  }

  close(): void {
    this.closed = true;
    // Tools can chmod their private directories to 000. Restore only owned,
    // non-link directories after the namespace roots have been terminated.
    const writable = (path: string): void => {
      if (!lstatSync(path).isDirectory()) return;
      chmodSync(path, 0o700);
      for (const entry of readdirSync(path)) writable(join(path, entry));
    };
    if (existsSync(this.scratch)) writable(this.scratch);
    rmSync(this.scratch, {recursive: true, force: true});
  }
}
