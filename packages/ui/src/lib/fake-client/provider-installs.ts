/** Managed installs and agent updates: what Boite downloads and updates itself. */
import { RpcErrorCode, type HarnessUpdate, type ProviderInstallState, type ProviderSummary, type RpcResult } from '@boite/contracts';
import { RpcFailure } from '../client';
import { INSTALL_STEP_MS, INSTALL_STEPS, MANAGED_ARCHIVE_BYTES, MANAGED_EXE, MANAGED_ID, MANAGED_VERSION, RELEASES } from './providers';
import { DATA_DIR } from './shared';
import type { FakeContext, FakeMethods } from './context';

/** Keep update notices out of ordinary demo fixtures. */
function quietUpdates(): boolean {
  if (typeof location === 'undefined') return false;
  const query = new URLSearchParams(location.search);
  return query.get('fake') === '1' && query.get('updates') !== '1';
}

/**
 * Two agents behind their newest release, one by each route, so the notices
 * have a subject. The fake page shows them on `?updates=1` only: a card
 * pinned to a corner would sit in every other capture.
 */
export function initialHarnessUpdates(): HarnessUpdate[] {
  return ([
    { providerId: 'claude', name: 'Claude Code', route: 'self', current: '2.1.267', latest: '2.1.278', pending: true, skipped: null, state: 'idle', message: null, checkedAt: Date.now() },
    { providerId: 'codex', name: 'Codex', route: 'managed', current: '0.154.0', latest: '0.155.1', pending: true, skipped: null, state: 'idle', message: null, checkedAt: Date.now() },
    { providerId: 'opencode', name: 'OpenCode', route: 'self', current: '1.18.31', latest: '1.18.31', pending: false, skipped: null, state: 'idle', message: null, checkedAt: Date.now() },
    // No way to name its newest release: the row that offers the updater itself.
    { providerId: 'antigravity', name: 'Antigravity', route: 'self', current: '1.2.7', latest: null, pending: false, skipped: null, state: 'idle', message: null, checkedAt: Date.now() }
  ] satisfies HarnessUpdate[]).map((update) => (quietUpdates() ? { ...update, current: update.latest ?? update.current, pending: false } : update));
}

function harnessUpdate(ctx: FakeContext, providerId: string): HarnessUpdate {
  const update = ctx.harnessUpdates.find((entry) => entry.providerId === providerId);
  if (!update) throw new RpcFailure({ code: RpcErrorCode.Refused, message: `${providerId} has no update Boite can run on this machine` });
  return update;
}

function updateHarness(ctx: FakeContext, providerId: string): RpcResult<'providers.update'> {
  const update = harnessUpdate(ctx, providerId);
  if (update.state === 'updating') throw new RpcFailure({ code: RpcErrorCode.Refused, message: `${update.name} is already updating` });
  if (update.latest !== null && update.current === update.latest) {
    throw new RpcFailure({ code: RpcErrorCode.Refused, message: `${update.name} is already on its newest known version` });
  }
  update.state = 'updating';
  update.pending = false;
  ctx.emit('providers.updatesChanged', structuredClone(ctx.harnessUpdates));
  setTimeout(() => {
    update.state = 'idle';
    update.current = update.latest ?? update.current;
    update.checkedAt = Date.now();
    ctx.emit('providers.updatesChanged', structuredClone(ctx.harnessUpdates));
  }, 1200);
  return structuredClone(update);
}

function managed(ctx: FakeContext, providerId: string): ProviderSummary {
  const provider = ctx.providers.find((p) => p.id === providerId);
  if (!provider || provider.install === null) {
    throw new RpcFailure({
      code: RpcErrorCode.Refused,
      message: `${providerId} has nothing for Boite to install`
    });
  }
  return provider;
}

function setInstall(ctx: FakeContext, provider: ProviderSummary, state: ProviderInstallState): void {
  provider.install = state;
  ctx.emit('providers.installProgress', { ...state, providerId: provider.id });
}

/** The release one install would fetch on this provider, and what it weighs. */
function releaseOf(providerId: string): { version: string; archiveBytes: number } {
  return RELEASES[providerId] ?? { version: MANAGED_VERSION, archiveBytes: MANAGED_ARCHIVE_BYTES };
}

function startInstall(ctx: FakeContext, providerId: string): ProviderInstallState {
  const provider = managed(ctx, providerId);
  const before = provider.install;
  if (
    before !== null &&
    before.state !== 'absent' &&
    before.state !== 'installed' &&
    before.state !== 'failed'
  ) {
    throw new RpcFailure({
      code: RpcErrorCode.Refused,
      message: `an install of ${providerId} is already running`
    });
  }
  if (before?.state === 'installed' && before.available === before.version) {
    throw new RpcFailure({
      code: RpcErrorCode.Refused,
      message: `${providerId} is up to date on ${before.version}`
    });
  }
  // An update that is cancelled goes back to the release already on disk.
  if (before !== null) ctx.installBefore.set(providerId, before);

  const release = releaseOf(providerId);
  const operationId = `inst_${(ctx.seq += 1)}`;
  const state: ProviderInstallState = {
    state: 'downloading',
    version: release.version,
    receivedBytes: 0,
    totalBytes: release.archiveBytes,
    operationId
  };
  setInstall(ctx, provider, state);
  void runInstall(ctx, provider, release, operationId);
  return state;
}

/** The download ticks, then the two short states, then the files are there. */
async function runInstall(
  ctx: FakeContext,
  provider: ProviderSummary,
  release: { version: string; archiveBytes: number },
  operationId: string
): Promise<void> {
  const running = (): boolean =>
    provider.install !== null &&
    provider.install.state !== 'absent' &&
    provider.install.state !== 'installed' &&
    provider.install.state !== 'failed' &&
    provider.install.operationId === operationId;

  for (let step = 1; step <= INSTALL_STEPS; step += 1) {
    await new Promise((resolve) => setTimeout(resolve, INSTALL_STEP_MS));
    if (!running()) return;
    setInstall(ctx, provider, {
      state: 'downloading',
      version: release.version,
      receivedBytes: Math.round((release.archiveBytes * step) / INSTALL_STEPS),
      totalBytes: release.archiveBytes,
      operationId
    });
  }
  for (const state of ['verifying', 'extracting'] as const) {
    await new Promise((resolve) => setTimeout(resolve, INSTALL_STEP_MS));
    if (!running()) return;
    setInstall(ctx, provider, { state, version: release.version, operationId });
  }
  await new Promise((resolve) => setTimeout(resolve, INSTALL_STEP_MS));
  if (!running()) return;
  ctx.installBefore.delete(provider.id);
  provider.available = true;
  provider.executable = provider.id === MANAGED_ID ? MANAGED_EXE : provider.executable ?? `${DATA_DIR}/agents/${provider.id}/current/${provider.id}.exe`;
  // Same order as the core: the provider list first, so no client sees
  // `installed` on a provider it still believes is missing.
  const installed: ProviderInstallState = {
    state: 'installed',
    version: release.version,
    installedAt: ctx.now(),
    available: release.version
  };
  provider.install = installed;
  ctx.emit('providers.updated', { loaded: structuredClone(ctx.providers), rejected: [] });
  setInstall(ctx, provider, installed);
}

function cancelInstall(ctx: FakeContext, providerId: string, operationId: string): ProviderInstallState {
  const provider = managed(ctx, providerId);
  const current = provider.install;
  if (
    current === null ||
    current.state === 'absent' ||
    current.state === 'installed' ||
    current.state === 'failed'
  ) {
    throw new RpcFailure({ code: RpcErrorCode.Refused, message: `no install of ${providerId} is running` });
  }
  if (current.operationId !== operationId) {
    throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'that operation is not the one running' });
  }
  const release = releaseOf(providerId);
  const back = ctx.installBefore.get(providerId);
  ctx.installBefore.delete(providerId);
  const state: ProviderInstallState = back ?? {
    state: 'absent',
    version: release.version,
    archiveBytes: release.archiveBytes
  };
  setInstall(ctx, provider, state);
  return state;
}

function uninstall(ctx: FakeContext, providerId: string): ProviderInstallState {
  const provider = managed(ctx, providerId);
  const release = releaseOf(providerId);
  ctx.installBefore.delete(providerId);
  provider.available = false;
  provider.executable = null;
  const state: ProviderInstallState = {
    state: 'absent',
    version: release.version,
    archiveBytes: release.archiveBytes
  };
  setInstall(ctx, provider, state);
  ctx.emit('providers.updated', { loaded: structuredClone(ctx.providers), rejected: [] });
  return state;
}

export function providerInstallMethods(ctx: FakeContext) {
  return {
    'providers.install': async (params) => {
      return startInstall(ctx, params.providerId);
    },
    'providers.installCancel': async (params) => {
      return cancelInstall(ctx, params.providerId, params.operationId);
    },
    'providers.uninstall': async (params) => {
      return uninstall(ctx, params.providerId);
    },
    'providers.updates': async (params) => {
      return structuredClone(ctx.harnessUpdates);
    },
    'providers.update': async (params) => {
      return updateHarness(ctx, params.providerId);
    },
    'providers.updateSkip': async (params) => {
      const update = harnessUpdate(ctx, params.providerId);
      update.skipped = params.version;
      update.pending = update.latest !== update.current && update.skipped !== update.latest;
      ctx.emit('providers.updatesChanged', structuredClone(ctx.harnessUpdates));
      return structuredClone(update);
    },
  } satisfies Partial<FakeMethods>;
}
