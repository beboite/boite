import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync } from 'node:fs';
import { chmod, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { PluginPool, PluginState, RpcParams } from '@boite/contracts';
import type { Core } from './core.ts';
import { invalidParams, messageOf, refused } from './errors.ts';
import { getDriver } from './drivers/index.ts';

const ID = 'kebacc-switcher';
const VERSION = '2.0.1';
const REPO = 'https://github.com/kebab1337420/kebacc-switch';
const POOLS = ['claude', 'codex', 'antigravity'] as const;
/** Published release assets, pinned with their GitHub sha256 digests. */
const ASSETS: Record<string, [string, string]> = {
  'win32-x64': ['x86_64-pc-windows-msvc.exe', '9edc5c3af1db76e97a9c07e2fd1c3399ad8c9db22e0ad2684a1b885e33acc538'],
  'win32-arm64': ['aarch64-pc-windows-msvc.exe', 'ed5a23820361e47d88540b5cf30bf6c90ee0739c23fba937463d2f5716986f6e'],
  'darwin-x64': ['x86_64-apple-darwin', '7d1f32dfb73b094a6b9c8111fbab2b0d2b743dc224f6c5bd8e551d2acaf35c36'],
  'darwin-arm64': ['aarch64-apple-darwin', '85951d81d5db5e676b5950ece8a818673eecb5d1f46ff980236c9e40c3cf8ef6'],
  'linux-x64': ['x86_64-unknown-linux-gnu', 'b683ac5b491bc45e94cb1392e9a1743e8ac9e244d71ed7c024809ac4ddb82500'],
  'linux-arm64': ['aarch64-unknown-linux-gnu', '258dd96565bad8c4194b1fdaf182d784d8a617cef0a397c1210a9a4cb9e2df17'],
};
export function verifyPluginDownload(bytes: Uint8Array, digest: string): void {
  if (createHash('sha256').update(bytes).digest('hex') !== digest) throw new Error('kebacc-switcher download sha256 does not match the published release.');
}

export function parsePluginPool(provider: string, text: string): PluginPool {
  let raw: { accounts?: unknown };
  try { raw = JSON.parse(text) as { accounts?: unknown }; }
  catch { throw new Error(`kebacc ${provider} returned invalid JSON.`); }
  if (!raw || typeof raw !== 'object') throw new Error(`kebacc ${provider} JSON must be an object.`);
  if (!Array.isArray(raw.accounts)) throw new Error(`kebacc ${provider} JSON must contain an accounts array.`);
  return { provider, accounts: raw.accounts.map((value: unknown) => {
    if (!value || typeof value !== 'object') throw new Error(`kebacc ${provider} account must be an object.`);
    const row = value as Record<string, unknown>;
    if (typeof row['email'] !== 'string' || !row['email']) throw new Error(`kebacc ${provider} account.email must be a nonempty string.`);
    return { email: row['email'], active: row['live'] === true,
      checkedSecondsAgo: typeof row['checkedSecondsAgo'] === 'number' ? row['checkedSecondsAgo'] : null,
      windows: [['fiveHour', '5 hours'], ['sevenDay', 'Weekly']].flatMap(([key, label]) => {
        const percent = row[key!];
        // The CLI's list JSON reports percentages but no per-window reset time.
        return typeof percent === 'number' && Number.isFinite(percent) ? [{ id: key!, label: label!, usedPercent: Math.max(0, Math.min(100, percent)), resetsAt: null }] : [];
      }),
    };
  }) };
}

export class PluginStore {
  private installing: Promise<void> | null = null;
  private abort: AbortController | null = null;
  private progress = 0;
  private error: string | null = null;
  private running = new Set<string>();
  private actionProvider: string | null = null;
  private listing: Promise<PluginPool[]> | null = null;
  private cached: { pools: PluginPool[]; at: number } | null = null;
  private sequence = 0;
  private closing = false;
  private exits = new Set<Promise<number>>();
  constructor(private core: Core) {}
  private directory(): string {
    const root = resolve(this.core.dataDir, 'plugins');
    const dir = resolve(root, ID);
    for (const path of [root, dir]) if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw refused(`plugin path ${path} must not be a symbolic link`);
    return dir;
  }
  private binary(): string { return join(this.directory(), process.platform === 'win32' ? 'kebacc.exe' : 'kebacc'); }
  private check(id: string): void { if (id !== ID) throw invalidParams(`unknown plugin ${id}; expected ${ID}`); }
  /**
   * A manifest a power loss truncated must not take the Plugins page with it:
   * the state carries the file, the field and what was expected, and the page
   * can still reinstall or remove.
   */
  private version(): string | null {
    const manifest = join(this.directory(), 'installed.json');
    if (!existsSync(manifest) || !existsSync(this.binary())) return null;
    let data: { version?: unknown };
    try {
      data = JSON.parse(readFileSync(manifest, 'utf8')) as { version?: unknown };
    } catch (error) {
      this.error = `${manifest} is not readable JSON (${messageOf(error)}). Reinstall kebacc-switcher.`;
      return null;
    }
    if (typeof data.version !== 'string') {
      this.error = `${manifest} must carry a "version" string, found ${typeof data.version}. Reinstall kebacc-switcher.`;
      return null;
    }
    return data.version;
  }
  state(): PluginState {
    const version = this.version();
    return { id: ID, name: 'kebacc-switcher', version, availableVersion: VERSION,
      status: this.installing ? 'installing' : this.error ? 'error' : version ? 'installed' : 'not-installed', progress: this.progress, error: this.error };
  }
  private emit(): void { this.core.bus.emit('plugins.updated', this.state()); }
  install(id: string): PluginState {
    this.check(id);
    if (this.installing) return this.state();
    if (this.running.size) throw refused('Wait for the current plugin operation before installing.');
    const asset = ASSETS[`${process.platform}-${process.arch}`];
    if (!asset) throw refused(`kebacc-switcher has no binary for ${process.platform}-${process.arch}`);
    this.error = null; this.progress = 0;
    const controller = new AbortController(); this.abort = controller;
    this.installing = this.download(asset, controller.signal).catch((error: unknown) => {
      if (!controller.signal.aborted) this.error = error instanceof Error ? error.message : 'Plugin install failed.';
    }).finally(() => { this.installing = null; this.abort = null; this.emit(); });
    this.emit();
    return this.state();
  }
  private async download(asset: [string, string], signal: AbortSignal): Promise<void> {
    const dir = this.directory(); mkdirSync(dir, { recursive: true });
    const temporary = join(dir, 'download.part');
    try {
      const response = await fetch(`${REPO}/releases/download/kebacc-v${VERSION}/kebacc-${asset[0]}`, { signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]) });
      if (!response.ok || !response.body) throw new Error(`kebacc-switcher download returned HTTP ${response.status}.`);
      const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
      const total = Number(response.headers.get('content-length')) || 3_000_000;
      try {
        for (;;) {
          const chunk = await reader.read(); if (chunk.done) break;
          size += chunk.value.length;
          if (size > 16 * 1024 * 1024) throw new Error('kebacc-switcher download exceeds 16 MB.');
          chunks.push(chunk.value); this.progress = Math.min(95, Math.floor(size / total * 95)); this.emit();
        }
      } finally { await reader.cancel(); }
      const bytes = Buffer.concat(chunks); verifyPluginDownload(bytes, asset[1]); signal.throwIfAborted();
      await writeFile(temporary, bytes, { mode: 0o700 });
      if (process.platform !== 'win32') await chmod(temporary, 0o700);
      signal.throwIfAborted();
      await rename(temporary, this.binary());
      await writeFile(join(dir, 'installed.json'), JSON.stringify({ version: VERSION }), 'utf8');
      this.progress = 100;
    } finally { await rm(temporary, { force: true }); }
  }
  async cancel(id: string): Promise<PluginState> { this.check(id); this.abort?.abort(); await this.installing; return this.state(); }
  async uninstall(id: string): Promise<PluginState> {
    this.check(id);
    if (this.installing || this.running.size || this.actionProvider || this.listing) throw refused('Wait for the current plugin operation before uninstalling.');
    await rm(this.directory(), { recursive: true, force: true });
    this.error = null; this.progress = 0; this.cached = null; this.emit(); return this.state();
  }
  private async run(args: string[]): Promise<string> {
    if (this.closing) throw refused('Boite is shutting down.');
    if (!this.version()) throw refused('Install kebacc-switcher first.');
    if (this.installing) throw refused('Wait for kebacc-switcher installation to finish.');
    const threadId = `plugin:${ID}:${++this.sequence}`;
    const spawned = this.core.procs.spawn(threadId, this.binary(), args, { cwd: this.directory() });
    this.running.add(threadId); this.exits.add(spawned.exited);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async (stream: ReadableStream<Uint8Array>): Promise<string> => {
      const reader = stream.getReader(); const chunks: Uint8Array[] = []; let size = 0;
      for (;;) {
        const chunk = await reader.read(); if (chunk.done) break;
        size += chunk.value.length;
        if (size > 4 * 1024 * 1024) throw new Error('kebacc output exceeds 4 MB.');
        chunks.push(chunk.value);
      }
      return Buffer.concat(chunks).toString('utf8');
    };
    try {
      const output = Promise.all([read(spawned.proc.stdout), read(spawned.proc.stderr), spawned.exited]);
      const expired = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('kebacc did not finish within 60 seconds.')), 60_000); });
      const [stdout, , code] = await Promise.race([output, expired]);
      // Do not forward arbitrary CLI output: it may carry login material.
      if (code !== 0) throw new Error(`kebacc ${args[0]} failed with exit code ${code}. Check the saved login with kebacc doctor.`);
      return stdout;
    } finally { clearTimeout(timer); this.core.procs.killTree(threadId); await spawned.exited; this.running.delete(threadId); this.exits.delete(spawned.exited); }
  }
  async accounts(id: string, refresh = false): Promise<PluginPool[]> {
    this.check(id);
    if (this.listing) return this.listing;
    if (this.cached && Date.now() - this.cached.at < (refresh ? 10_000 : 60_000)) return this.cached.pools;
    this.listing = (async () => {
      const pools: PluginPool[] = [];
      for (const provider of POOLS) pools.push(parsePluginPool(provider, await this.run(['list', `-${provider}`, '-Json', ...(refresh ? ['-Refresh'] : [])])));
      this.cached = { pools, at: Date.now() }; return pools;
    })();
    try { return await this.listing; } finally { this.listing = null; }
  }
  blocksAccount(accountId: string): boolean {
    if (!this.actionProvider) return false;
    const account = this.core.journal.getAccount(accountId);
    return account?.providerId === this.actionProvider && account.isolationDir === null;
  }
  async accountAction(params: RpcParams<'plugins.accountAction'>): Promise<PluginPool[]> {
    this.check(params.id);
    if (!POOLS.includes(params.provider as typeof POOLS[number])) throw invalidParams('plugin provider must be claude, codex or antigravity');
    if (!['add', 'switch', 'remove'].includes(params.action)) throw invalidParams('plugin action must be add, switch or remove');
    if (params.action !== 'add' && (typeof params.email !== 'string' || !/^[^\s@]+@[^\s@]+$/.test(params.email))) throw invalidParams('plugin email must be an email address');
    if (this.actionProvider || this.listing || this.installing) throw refused('Wait for the current plugin operation to finish.');
    this.actionProvider = params.provider;
    try {
      const affected = this.core.journal.listThreads().filter((thread) => this.blocksAccount(thread.accountId));
      if (this.core.scheduler.activeAccountIds().some((accountId) => this.blocksAccount(accountId))) throw refused('Stop this provider\'s default-account turns before changing its saved login.');
      if (affected.some((thread) => ['running', 'queued', 'waiting'].includes(thread.status))) throw refused('Stop this provider\'s default-account turns before changing its saved login.');
      for (const thread of affected) {
        const provider = this.core.providers.require(thread.providerId);
        getDriver(provider.protocol).releaseThread?.(thread.id);
      }
      await this.run([params.action, `-${params.provider}`, ...(params.action === 'add' ? [] : ['-Email', params.email!, '-Yes'])]);
      if (this.closing) throw refused('Boite is shutting down.');
      this.cached = null; this.core.quotas.invalidate();
      for (const account of this.core.accounts.list()) if (this.blocksAccount(account.id)) this.core.accounts.check(account.id);
      return await this.accounts(ID);
    } finally { this.actionProvider = null; if (!this.closing) this.core.scheduler.onSettingsChanged(); }
  }
  async close(): Promise<void> {
    this.closing = true;
    this.abort?.abort(); await this.installing;
    for (const threadId of this.running) this.core.procs.killTree(threadId);
    await Promise.all(this.exits);
    await this.listing?.catch(() => undefined);
  }
}
