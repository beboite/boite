import {
  RpcErrorCode,
  type BrowserStatus,
  type BrowserTask,
  type PluginManifest,
  type PluginPool,
  type PluginPreview,
  type PluginState,
  type RpcEvents,
  type RpcMethodName,
  type RpcParams,
  type RpcResult,
} from '@boite/contracts';
import { RpcFailure } from '../client';
import { fakePluginPools, fakePlugins, PLUGIN_STEPS, poolCommands } from './plugins-seed';
import { INSTALL_STEP_MS } from './providers';
import { T0 } from './shared';

type PluginMethod = Extract<RpcMethodName, `plugins.${string}` | `browser.${string}`>;
type Handlers = { [M in PluginMethod]: (params: RpcParams<M>) => RpcResult<M> | Promise<RpcResult<M>> };

interface PluginHost {
  emit<E extends 'plugins.updated' | 'browser.updated'>(event: E, payload: RpcEvents[E]): void;
  now(): number;
  nextId(): number;
  delayMs(): number;
  requireThread(id: string): { archived: boolean };
}

/** Owns plugin state and installation cancellation for one in-memory client. */
export class FakePlugins {
  constructor(private readonly host: PluginHost) {}
  #browser: BrowserStatus = { config: { enabled: false, executablePath: null }, keyAvailable: true, tasks: [] };
  seedBrowserTask(): void {
    const plugin = this.#requirePlugin('jev-browser');
    plugin.version = plugin.availableVersion; plugin.status = 'installed';
    this.#browser.config.enabled = true;
    this.host.requireThread('t-trace');
    this.#browser.tasks = [{ id: 'browser-fixture', threadId: 't-trace', pluginId: plugin.id, goal: 'Save weekly notifications', url: 'https://example.org', status: 'running', step: 1, maxSteps: 20, startedAt: T0, finishedAt: null, message: 'Checking the page', inputTokens: 120 }];
  }
  close(): void { for (const [id, run] of this.#pluginRuns) this.#pluginRuns.set(id, run + 1); }
  stopThread(threadId: string): void {
    for (const task of this.#browser.tasks) {
      if (task.threadId === threadId && task.finishedAt === null) this.#cancelBrowserTask(task);
    }
  }
  handles(method: RpcMethodName): method is PluginMethod { return Object.hasOwn(this.handlers, method); }
  async call(method: PluginMethod, params: unknown): Promise<unknown> { return this.handlers[method](params as never); }
  private readonly handlers: Handlers = {
    'browser.status': () => structuredClone(this.#browser),
    'browser.configure': (params) => {
      this.#browser.config = structuredClone(params);
      if (!params.enabled) for (const task of this.#browser.tasks) if (task.finishedAt === null) this.#cancelBrowserTask(task);
      return structuredClone(this.#browser);
    },
    'browser.list': (params) => {
      this.host.requireThread(params.threadId);
      return structuredClone(this.#browser.tasks.filter(task => task.threadId === params.threadId));
    },
    'browser.start': (request) => {
      const plugin = this.#requirePlugin(request.pluginId);
      if (!this.#browser.config.enabled || plugin.status !== 'installed' || !plugin.browser) throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'Install the browser plugin and enable browser automation first.' });
      if (this.host.requireThread(request.threadId).archived) throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'Unarchive the thread before starting a browser task.' });
      const active = this.#browser.tasks.filter(task => task.finishedAt === null);
      if (active.length >= 2 || active.some(task => task.threadId === request.threadId)) throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'Wait for an active browser task or cancel it first.' });
      const task: BrowserTask = { id: `browser-${this.host.nextId()}`, threadId: request.threadId, pluginId: request.pluginId, goal: request.goal, url: request.url, status: 'running', step: 0, maxSteps: request.maxSteps ?? 20, startedAt: Date.now(), finishedAt: null, message: 'Starting the browser', inputTokens: 0 };
      this.#browser.tasks.unshift(task); this.host.emit('browser.updated', structuredClone(task)); return structuredClone(task);
    },
    'browser.cancel': (params) => {
      const task = this.#browser.tasks.find(task => task.id === params.id && task.threadId === params.threadId);
      if (!task) throw new RpcFailure({ code: RpcErrorCode.InvalidParams, message: 'browser task id must belong to the named thread' });
      this.#cancelBrowserTask(task); return structuredClone(task);
    },
    'plugins.list': (params) => { return structuredClone(this.#plugins).sort((a, b) => a.origin === b.origin ? (a.origin === 'url' ? a.id.localeCompare(b.id) : 0) : a.origin === 'recommended' ? -1 : 1); },
    'plugins.inspect': (params) => { return this.#inspectPlugin(params); },
    'plugins.add': (params) => { return this.#addPlugin(params.previewId); },
    'plugins.install': (params) => {
      const plugin = this.#requirePlugin(params.id);
      this.#requireIdleBrowser(plugin.id);
      if (plugin.status === 'installing') return structuredClone(plugin);
      if (plugin.status === 'rejected' && plugin.origin === 'url') {
        throw new RpcFailure({ code: RpcErrorCode.Refused, message: `${plugin.id} was refused (${plugin.rejected?.message ?? ''}). Remove it, then add it again from its URL.` });
      }
      Object.assign(plugin, { status: 'installing', progress: 0, error: null });
      this.host.emit('plugins.updated', structuredClone(plugin));
      void this.#runPluginInstall(plugin.id);
      return structuredClone(plugin);
    },
    'plugins.cancel': (params) => {
      const plugin = this.#requirePlugin(params.id);
      if (plugin.status !== 'installing') return structuredClone(plugin);
      this.#pluginRuns.set(plugin.id, (this.#pluginRuns.get(plugin.id) ?? 0) + 1);
      if (plugin.origin === 'url' && plugin.version === null) return this.#dropPlugin(plugin);
      Object.assign(plugin, { status: plugin.version ? 'installed' : 'not-installed', progress: 0 });
      this.host.emit('plugins.updated', structuredClone(plugin));
      return structuredClone(plugin);
    },
    'plugins.uninstall': (params) => {
      const plugin = this.#requirePlugin(params.id);
      this.#requireIdleBrowser(plugin.id);
      if (plugin.status === 'installing') throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'Wait for the current plugin operation before uninstalling.' });
      this.#pluginRuns.set(plugin.id, (this.#pluginRuns.get(plugin.id) ?? 0) + 1);
      if (plugin.origin === 'url') return this.#dropPlugin(plugin);
      Object.assign(plugin, { status: 'not-installed', version: null, progress: 0, error: null, rejected: null });
      this.host.emit('plugins.updated', structuredClone(plugin));
      return structuredClone(plugin);
    },
    'plugins.accounts': (params) => {
      const plugin = this.#requirePlugin(params.id);
      if (plugin.status !== 'installed') throw new RpcFailure({ code: RpcErrorCode.Refused, message: `Install ${plugin.id} first.` });
      return structuredClone(this.#pluginPools[plugin.id] ?? []);
    },
    'plugins.accountAction': (params) => {
      const pools = this.#pluginPools[this.#requirePlugin(params.id).id] ?? [];
      const pool = pools.find((pool) => pool.provider === params.provider);
      if (pool && params.action === 'switch') for (const account of pool.accounts) account.active = account.email === params.email;
      if (pool && params.action === 'remove') pool.accounts = pool.accounts.filter((a) => a.email !== params.email);
      return structuredClone(pools);
    },
  };

  #cancelBrowserTask(task: BrowserTask): void {
    Object.assign(task, { status: 'cancelled', message: 'The task was cancelled.', finishedAt: Date.now() });
    this.host.emit('browser.updated', structuredClone(task));
  }

  #requireIdleBrowser(id: string): void {
    if (this.#browser.tasks.some(task => task.pluginId === id && task.finishedAt === null)) throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'Cancel this plugin\'s browser tasks before installing or uninstalling.' });
  }

  #plugins: PluginState[] = fakePlugins();

  #pluginPools: Record<string, PluginPool[]> = fakePluginPools();

  #pluginPreviews = new Map<string, PluginPreview>();

  /** Bumped by cancel and uninstall, so a fake install in flight stops where it is. */
  #pluginRuns = new Map<string, number>();

  // -------------------------------------------------------------------------
  // Plugins
  // -------------------------------------------------------------------------

  #requirePlugin(id: string): PluginState {
    const plugin = this.#plugins.find((entry) => entry.id === id);
    if (plugin === undefined) throw new RpcFailure({ code: RpcErrorCode.InvalidParams, message: `unknown plugin ${id}; expected a plugin id from plugins.list` });
    return plugin;
  }

  /** A URL plugin leaves the list; the event carries it back `not-installed`, as the core's does. */
  #dropPlugin(plugin: PluginState): PluginState {
    this.#plugins = this.#plugins.filter((entry) => entry.id !== plugin.id);
    const gone: PluginState = { ...structuredClone(plugin), status: 'not-installed', version: null, progress: 0, error: null, rejected: null };
    this.host.emit('plugins.updated', structuredClone(gone));
    return gone;
  }

  async #runPluginInstall(id: string): Promise<void> {
    const run = (this.#pluginRuns.get(id) ?? 0) + 1;
    this.#pluginRuns.set(id, run);
    for (let step = 1; step <= PLUGIN_STEPS; step += 1) {
      await new Promise((resolve) => setTimeout(resolve, INSTALL_STEP_MS));
      const plugin = this.#plugins.find((entry) => entry.id === id);
      if (this.#pluginRuns.get(id) !== run || plugin === undefined) return;
      if (step < PLUGIN_STEPS) plugin.progress = Math.round((step / PLUGIN_STEPS) * 95);
      else Object.assign(plugin, { status: 'installed', version: plugin.availableVersion, progress: 0, error: null, rejected: null });
      this.host.emit('plugins.updated', structuredClone(plugin));
    }
  }

  /**
   * What the core's `plugins.inspect` answers, without git: https only, a URL
   * holding `broken` comes back refused, anything else reads as a Pi pool
   * plugin named after the repository.
   */
  async #inspectPlugin(params: RpcParams<'plugins.inspect'>): Promise<PluginPreview> {
    const text = params.url.trim().replace(/\/+$/, '');
    let url: URL | null = null;
    try { url = new URL(text); } catch { url = null; }
    if (url === null || url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
      throw new RpcFailure({ code: RpcErrorCode.InvalidParams, message: 'plugin url must be an https URL of a git repository, such as https://github.com/owner/repo' });
    }
    // The core takes a moment to fetch; the page shows it reading.
    await new Promise((resolve) => setTimeout(resolve, this.host.delayMs() * 10));
    const source = { url: `${url.origin}${url.pathname}`, ref: params.ref?.trim() || 'HEAD', commit: 'e7d1c9a35b2f4e6d8a0c1b3f5d7e9a2c4b6d8f0e' };
    const base: PluginPreview = { previewId: null, source, manifest: null, rejected: null, artifact: null, platform: 'win32-x64', commands: [], replaces: null, expiresAt: this.host.now() + 600_000 };
    if (text.includes('broken')) {
      return {
        ...base, rejected: {
          file: 'boite-plugin.json', field: 'artifacts.win32-x64.sha256', expected: '64 lowercase hexadecimal characters',
          message: 'boite-plugin.json: artifacts.win32-x64.sha256 must be 64 lowercase hexadecimal characters, found "TODO"'
        }
      };
    }
    const slug = (url.pathname.split('/').filter(Boolean).pop() ?? '').toLowerCase().replace(/\.git$/, '').replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'plugin';
    const manifest: PluginManifest = {
      schema: 1, id: slug, name: slug.charAt(0).toUpperCase() + slug.slice(1).replace(/-/g, ' '), version: '1.5.0',
      description: 'Saves Pi logins and switches the active one.', homepage: source.url, executable: slug,
      artifacts: { 'win32-x64': { url: `${source.url}/releases/download/v1.5.0/${slug}-win32-x64.exe`, sha256: '5a7c9e1b3d5f7a9c2e4b6d8f0a1c3e5b7d9f2a4c6e8b0d1f3a5c7e9b2d4f6a8c' } },
      provides: { accountPools: { providers: ['pi'] } }
    };
    const read: PluginPreview = { ...base, manifest, artifact: manifest.artifacts['win32-x64'] ?? null, commands: poolCommands(slug) };
    const existing = this.#plugins.find((entry) => entry.id === slug);
    if (existing?.origin === 'recommended') {
      const expected = 'an id no recommended plugin uses (kebacc-switcher)';
      return { ...read, rejected: { file: 'boite-plugin.json', field: 'id', expected, message: `boite-plugin.json: id must be ${expected}, found "${slug}"` } };
    }
    if (existing !== undefined && existing.source !== null && existing.source.url !== source.url) {
      const expected = `an id not already used by the plugin from ${existing.source.url}`;
      return { ...read, rejected: { file: 'boite-plugin.json', field: 'id', expected, message: `boite-plugin.json: id must be ${expected}, found "${slug}"` } };
    }
    const preview: PluginPreview = { ...read, previewId: `preview-${this.host.nextId()}`, replaces: existing?.version ?? null };
    this.#pluginPreviews.set(preview.previewId!, preview);
    return structuredClone(preview);
  }

  #addPlugin(previewId: string): PluginState {
    const preview = this.#pluginPreviews.get(previewId);
    const manifest = preview?.manifest;
    // A preview is read once and only within its ten minutes, as the core's is.
    if (preview !== undefined && preview.expiresAt <= this.host.now()) this.#pluginPreviews.delete(previewId);
    if (preview === undefined || manifest == null || preview.expiresAt <= this.host.now()) {
      throw new RpcFailure({ code: RpcErrorCode.InvalidParams, message: 'plugin preview is unknown or expired; inspect the URL again' });
    }
    this.#pluginPreviews.delete(previewId);
    const existing = this.#plugins.find((entry) => entry.id === manifest.id);
    const pools = manifest.provides.accountPools?.providers ?? [];
    const plugin: PluginState = {
      id: manifest.id, name: manifest.name, origin: 'url', description: manifest.description, homepage: manifest.homepage,
      version: existing?.version ?? null, availableVersion: manifest.version, status: 'installing', progress: 0, error: null,
      source: preview.source, artifact: preview.artifact, platform: preview.platform, commands: preview.commands, pools, rejected: null,
      ...(manifest.provides.browser ? { browser: manifest.provides.browser } : {})
    };
    if (existing !== undefined) Object.assign(existing, plugin);
    else this.#plugins.push(plugin);
    this.#pluginPools[manifest.id] ??= pools.map((provider) => ({ provider, accounts: [] }));
    this.host.emit('plugins.updated', structuredClone(plugin));
    void this.#runPluginInstall(manifest.id);
    return structuredClone(plugin);
  }
}
