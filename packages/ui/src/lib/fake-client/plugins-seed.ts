import { type PluginPool, type PluginState } from '@boite/contracts';
import { DATA_DIR } from './shared.ts';

/** A fake plugin install ticks this many times, INSTALL_STEP_MS apart. */
export const PLUGIN_STEPS = 8;

const KEBACC_RELEASE = 'https://github.com/kebab1337420/kebacc-switch/releases/download/kebacc-v2.0.1';

/** The account pool command lines the core shows, `<pool>` and `<email>` standing for the values. */
export function poolCommands(executable: string): string[] {
  return [
    `${executable} list -<pool> -Json`,
    `${executable} list -<pool> -Json -Refresh`,
    `${executable} add -<pool>`,
    `${executable} switch -<pool> -Email <email> -Yes`,
    `${executable} remove -<pool> -Email <email> -Yes`
  ];
}

/**
 * Every state the Plugins page draws: the recommended one not installed yet,
 * one added from a URL and installed, one stuck mid-download, and one whose
 * installed.json the core refuses.
 */
export function fakePlugins(): PluginState[] {
  const base = { platform: 'win32-x64', progress: 0, error: null, rejected: null };
  const legacy = `${DATA_DIR}\\plugins\\pool-legacy\\installed.json`;
  return [
    {
      ...base, id: 'kebacc-switcher', name: 'kebacc-switcher', origin: 'recommended',
      description: 'Save and switch Claude, Codex and Antigravity CLI logins, with quota readings for each saved account.',
      homepage: 'https://github.com/kebab1337420/kebacc-switch', version: null, availableVersion: '2.0.1', status: 'not-installed', source: null,
      artifact: { url: `${KEBACC_RELEASE}/kebacc-x86_64-pc-windows-msvc.exe`, sha256: '9edc5c3af1db76e97a9c07e2fd1c3399ad8c9db22e0ad2684a1b885e33acc538' },
      commands: poolCommands('kebacc'), pools: ['claude', 'codex', 'antigravity']
    },
    {
      ...base, id: 'seat-pool', name: 'Seat pool', origin: 'url',
      description: 'Keeps several OpenCode logins and switches the active one.',
      homepage: 'https://github.com/example/seat-pool', version: '1.4.0', availableVersion: '1.4.0', status: 'installed',
      source: { url: 'https://github.com/example/seat-pool', ref: 'v1.4.0', commit: '3f9c2a7e5b1d4c6a8e0f2b4d6c8a0e2f4b6d8c0a' },
      artifact: { url: 'https://github.com/example/seat-pool/releases/download/v1.4.0/seat-pool-win32-x64.exe', sha256: 'c41e9b0a7d3f5e2b8a6c4d1f0e9b7a5c3d2e1f0a9b8c7d6e5f4a3b2c1d0e9f8a' },
      commands: poolCommands('seat-pool'), pools: ['opencode']
    },
    {
      ...base, id: 'grok-seats', name: 'Grok seats', origin: 'url',
      description: 'Saves Grok CLI logins and reads the quota of each one.',
      homepage: 'https://github.com/example/grok-seats', version: null, availableVersion: '0.3.0', status: 'installing', progress: 45,
      source: { url: 'https://github.com/example/grok-seats', ref: 'HEAD', commit: '8a1c3e5f7b9d0f2a4c6e8b0d2f4a6c8e0b2d4f6a' },
      artifact: { url: 'https://github.com/example/grok-seats/releases/download/v0.3.0/grok-seats-win32-x64.exe', sha256: '0d2f4b6a8c1e3f5a7b9c2d4e6f8a0b1c3d5e7f9a2b4c6d8e0f1a3b5c7d9e2f4a' },
      commands: poolCommands('grok-seats'), pools: ['grok']
    },
    {
      ...base, id: 'pool-legacy', name: 'pool-legacy', origin: 'url', description: '', homepage: null,
      version: null, availableVersion: null, status: 'rejected', source: null, artifact: null, commands: [], pools: [],
      rejected: { file: legacy, field: 'manifest.schema', expected: '1', message: `${legacy}: manifest.schema must be 1, found number 0` }
    }
  ];
}

export function fakePluginPools(): Record<string, PluginPool[]> {
  return {
    'kebacc-switcher': ['claude', 'codex', 'antigravity'].map((provider) => ({
      provider, accounts: [
        { email: 'work@example.com', active: true, checkedSecondsAgo: 10, windows: [{ id: 'fiveHour', label: '5 hours', usedPercent: 32, resetsAt: null }, { id: 'sevenDay', label: 'Weekly', usedPercent: 74, resetsAt: null }] },
        { email: 'personal@example.com', active: false, checkedSecondsAgo: 10, windows: [{ id: 'fiveHour', label: '5 hours', usedPercent: 8, resetsAt: null }] },
      ]
    })),
    'seat-pool': [{
      provider: 'opencode', accounts: [
        { email: 'team@example.com', active: true, checkedSecondsAgo: 42, windows: [{ id: 'fiveHour', label: '5 hours', usedPercent: 18, resetsAt: null }, { id: 'sevenDay', label: 'Weekly', usedPercent: 51, resetsAt: null }] },
        { email: 'side@example.com', active: false, checkedSecondsAgo: null, windows: [] },
      ]
    }],
    'grok-seats': [{ provider: 'grok', accounts: [] }]
  };
}
