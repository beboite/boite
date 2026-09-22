import {
  type Account,
  type ProviderSummary
} from '@boite/contracts';
import {
  MANAGED_ARCHIVE_BYTES,
  MANAGED_ID,
  MANAGED_VERSION,
  PROBE_PROVIDERS,
  UPDATABLE_AVAILABLE,
  UPDATABLE_ID,
  UPDATABLE_VERSION
} from './providers.ts';
import {
  DATA_DIR,
  T0
} from './shared.ts';

/** Every call creates independent provider and account records. */
export function seedAccounts() {
  const providers: ProviderSummary[] = [
    {
      id: 'claude',
      name: 'Claude',
      shortName: 'Claude',
      protocol: 'claude-sdk',
      login: { kind: 'command' },
      alwaysIsolated: false,
      source: 'shipped',
      available: true,
      executable: 'C:\\Users\\you\\.local\\bin\\claude.exe',
      models: [
        {
          id: 'claude-fable-5-1', name: 'Claude Fable 5.1', badge: 'new', effort: {
            levels: [
              { id: 'low', label: 'Low' },
              { id: 'medium', label: 'Medium' },
              { id: 'high', label: 'High' },
              { id: 'xhigh', label: 'Extra high' },
              { id: 'max', label: 'Max' },
              { id: 'ultrathink', label: 'Ultrathink', description: 'Extended thinking, asked for in the prompt' }
            ],
            default: 'high'
          }
        },
        {
          id: 'claude-opus-5', name: 'Claude Opus 5', speeds: [{ id: 'fast', label: 'Fast' }], effort: {
            levels: [
              { id: 'low', label: 'Low' },
              { id: 'medium', label: 'Medium' },
              { id: 'high', label: 'High' },
              { id: 'xhigh', label: 'Extra high' },
              { id: 'max', label: 'Max' },
              { id: 'ultrathink', label: 'Ultrathink', description: 'Extended thinking, asked for in the prompt' }
            ],
            default: 'high'
          }
        },
        {
          id: 'claude-sonnet-5', name: 'Claude Sonnet 5', default: true, effort: {
            levels: [
              { id: 'low', label: 'Low' },
              { id: 'medium', label: 'Medium' },
              { id: 'high', label: 'High' },
              { id: 'xhigh', label: 'Extra high' },
              { id: 'max', label: 'Max' },
              { id: 'ultrathink', label: 'Ultrathink', description: 'Extended thinking, asked for in the prompt' }
            ],
            default: 'high'
          }
        },
        {
          id: 'claude-fable-5', name: 'Claude Fable 5', legacy: true, effort: {
            levels: [
              { id: 'low', label: 'Low' },
              { id: 'medium', label: 'Medium' },
              { id: 'high', label: 'High' }
            ],
            default: 'high'
          }
        },
        {
          id: 'claude-opus-4-8', name: 'Claude Opus 4.8', legacy: true, effort: {
            levels: [
              { id: 'low', label: 'Low' },
              { id: 'medium', label: 'Medium' },
              { id: 'high', label: 'High' }
            ],
            default: 'high'
          }
        },
        {
          id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', legacy: true, effort: {
            levels: [
              { id: 'low', label: 'Low' },
              { id: 'medium', label: 'Medium' },
              { id: 'high', label: 'High' }
            ],
            default: 'high'
          }
        },
        { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5', legacy: true }
      ],
      install: null,
      capabilities: {
        approvals: true,
        hooks: true,
        checkpoint: true,
        images: true,
        planMode: true,
        resume: true
      }
    },
    {
      id: 'echo',
      name: 'Echo',
      shortName: 'Echo',
      protocol: 'echo',
      login: false,
      alwaysIsolated: false,
      source: 'shipped',
      available: true,
      executable: null,
      models: [
        {
          id: 'echo-1',
          name: 'Echo',
          default: true,
          effort: {
            levels: [
              { id: 'low', label: 'Low' },
              { id: 'high', label: 'High' }
            ],
            default: 'high'
          }
        }
      ],
      install: null,
      // The shipped echo descriptor reads images too: the fake agent names
      // back what it was sent, which is what the attachment capture proves.
      capabilities: {
        approvals: true,
        hooks: false,
        checkpoint: false,
        images: true,
        planMode: false,
        resume: true
      }
    },
    {
      id: UPDATABLE_ID,
      name: 'OpenCode',
      shortName: 'OpenCode',
      protocol: 'acp',
      login: { kind: 'command' },
      alwaysIsolated: false,
      source: 'shipped',
      available: true,
      executable: 'C:\\Users\\you\\AppData\\Roaming\\npm\\opencode.exe',
      // One model in the descriptor: the agent owns the rest, and a probe reads them.
      models: [{ id: 'default', name: 'OpenCode default', default: true }],
      // Its files are down and one version behind: the Providers page offers Update.
      install: {
        state: 'installed',
        version: UPDATABLE_VERSION,
        installedAt: T0,
        available: UPDATABLE_AVAILABLE
      },
      capabilities: {
        approvals: true,
        hooks: false,
        checkpoint: false,
        images: false,
        planMode: false,
        resume: true
      }
    },
    {
      id: MANAGED_ID,
      name: 'Antigravity',
      shortName: 'Antigravity',
      protocol: 'acp',
      login: { kind: 'acp' },
      alwaysIsolated: true,
      source: 'shipped',
      // Nothing runs until the release lands: the picker row offers the download.
      available: false,
      executable: null,
      models: [{ id: 'default', name: 'Antigravity default', default: true }],
      install: {
        state: 'absent',
        version: MANAGED_VERSION,
        archiveBytes: MANAGED_ARCHIVE_BYTES
      },
      capabilities: {
        approvals: true,
        hooks: false,
        checkpoint: false,
        images: false,
        planMode: false,
        resume: true
      }
    }
  ];
  providers.push(...PROBE_PROVIDERS.map((provider): ProviderSummary => ({
    ...provider,
    shortName: provider.name,
    source: 'shipped',
    available: true,
    executable: `${DATA_DIR}\\demo\\${provider.id}.exe`,
    models: [{ id: 'default', name: `${provider.name} default`, default: true }],
    capabilities: {
      approvals: provider.protocol !== 'pi', hooks: false, checkpoint: false,
      images: false, planMode: provider.protocol !== 'pi', resume: true
    },
    install: null,
    alwaysIsolated: false
  })));
  const accounts: Account[] = [
    {
      id: 'a-echo',
      providerId: 'echo',
      label: 'Echo',
      isolationDir: `${DATA_DIR}\\accounts\\a-echo`,
      status: 'ok',
      identity: 'echo',
      createdAt: T0
    },
    {
      id: 'a-antigravity',
      providerId: MANAGED_ID,
      label: 'Antigravity',
      isolationDir: `${DATA_DIR}\\accounts\\a-antigravity`,
      // A managed provider is signed into from the Accounts page, once its
      // files are down: nothing on this machine has logged it in yet.
      status: 'unauthenticated',
      identity: null,
      createdAt: T0
    },
    {
      id: 'a-claude-main',
      providerId: 'claude',
      label: 'Default login',
      isolationDir: null,
      status: 'ok',
      identity: 'you@example.com',
      createdAt: T0
    },
    {
      id: 'a-claude-side',
      providerId: 'claude',
      label: 'Second seat',
      isolationDir: `${DATA_DIR}\\accounts\\a-claude-side`,
      status: 'unauthenticated',
      identity: null,
      createdAt: T0
    },
    {
      id: 'a-opencode',
      providerId: 'opencode',
      label: 'Default',
      isolationDir: null,
      status: 'ok',
      identity: 'you@example.com',
      createdAt: T0
    }
  ];
  accounts.push(...PROBE_PROVIDERS.map((provider): Account => ({
    id: `a-${provider.id}`,
    providerId: provider.id,
    label: 'Default',
    isolationDir: null,
    status: 'ok',
    identity: 'you@example.com',
    createdAt: T0
  })));
  return { providers, accounts };
}
