import {homedir} from 'node:os';
import {join, resolve} from 'node:path';
import {mkdirSync, writeFileSync} from 'node:fs';
import type {SessionContext} from '../types.ts';
import type {InitializeResult, MuseSessionRecord} from './protocol.ts';
import {linkAccountFiles, protectedBridge, protectedControlEnvironment, selectionSettings, type ProtectedHead} from '../protected-bridge.ts';
import {agentEnv} from '../../providers/resolve.ts';

// Verified against the official stable native release, not the separately versioned SDK.
const VERSION = '1.4.13';
const FINGERPRINT = 'sha256:7fddaf646dbc317e5fcac0785e135eb04df14fbb0db1863089dfd6da21730e5b';

/** The native registry admits only core MCP tools, including on forged provider calls. */
export function protectedMuse(ctx: SessionContext, head: ProtectedHead, declared: string[]) {
  if (!ctx.protectedExecution) return null;
  if (JSON.stringify(declared) !== JSON.stringify(['serve', '--trust-workspace']) && JSON.stringify(declared) !== JSON.stringify(['serve'])) {
    throw new Error('execution.muse.launch.args: expected serve with optional --trust-workspace; protected discovery is core-owned');
  }
  const selectedEnv = agentEnv(ctx.provider, ctx.accountEnv);
  const accountEnv = Object.fromEntries(Object.entries(selectedEnv).filter((entry): entry is [string, string] => entry[1] !== undefined));
  protectedControlEnvironment({...ctx, accountEnv});
  // Native experiments and managed-hook/path overrides must not re-enable
  // discovery outside the private control roots. Keep native API/auth routing.
  const transport = new Set(['MUSE_CUSTOM_HEADERS', 'MUSE_MODEL', 'TBH_AUTH_BASE_URL', 'TBH_MINT_BASE_URL', 'TBH_CA_CERTIFICATE', 'TBH_TLS_CREDENTIAL_ROOT']);
  for (const key of Object.keys(selectedEnv)) if (/^(?:MUSE_|TBH_)/i.test(key) && !transport.has(key.toUpperCase())) delete selectedEnv[key];
  const source = resolve(ctx.thread.cwd, selectedEnv['XDG_CONFIG_HOME'] || join(selectedEnv['HOME'] || homedir(), '.config'), 'muse');
  const settings = selectionSettings(join(source, 'settings.json'), ['model', 'endpoint_transport', 'contributor_mode']);
  const bridge = protectedBridge(ctx, head);
  try {
    const config = join(bridge.directory, 'config'), native = join(config, 'muse');
    mkdirSync(native, {recursive: true});
    // Native auth and refresh remain under trusted control, never in the tool view.
    linkAccountFiles(source, native, ['auth.json']);
    writeFileSync(join(native, 'settings.json'), JSON.stringify({schema_version: 1, ...settings,
      run: {subagent_delegation_mode: 'off', reminder_roster: {agents: []}, toolset: bridge.definitions.map(d => `mcp__boite_protected__${d.name}`)},
      mcp_servers: {boite_protected: {transport: 'streamable_http', url: bridge.url + '/mcp', mode: 'required', headers: {Authorization: `Bearer ${bridge.token}`}}},
    }), {mode: 0o600});
    return {...bridge, args: ['serve', '--disable-write', '--disable-shell'],
      env: {...selectedEnv, HOME: bridge.directory, XDG_CONFIG_HOME: config, XDG_DATA_HOME: join(bridge.directory, 'data'), XDG_STATE_HOME: join(bridge.directory, 'state'),
        XDG_CACHE_HOME: join(bridge.directory, 'cache'), XDG_CONFIG_DIRS: config, XDG_DATA_DIRS: join(bridge.directory, 'data'),
        CODEX_HOME: join(bridge.directory, 'codex'), CLAUDE_CONFIG_DIR: join(bridge.directory, 'claude'),
        CLAUDE_PLUGIN_ROOT: join(bridge.directory, 'plugins'), PLUGIN_ROOT: join(bridge.directory, 'plugins'),
        MUSE_NO_AUTO_UPDATE: '1', TBH_DISABLE_DEFAULT_PLUGIN_INSTALL: '1', TBH_DISABLE_TELEMETRY: '1'},
      admit(init: InitializeResult) {
        ctx.protectedExecution!.check();
        if (init.serverInfo?.name !== 'muse' || init.serverInfo.version !== VERSION || init.schema?.fingerprint !== FINGERPRINT) {
          throw new Error(`execution.muse.native: expected verified Muse ${VERSION} and MSP fingerprint ${FINGERPRINT}; no unprotected fallback`);
        }
      },
      ready(session: MuseSessionRecord, mode: string, model: string | null) {
        ctx.protectedExecution!.check();
        if (session.providerId !== 'meta' || model !== null && session.modelId !== model || session.approvalMode?.mode !== mode || session.workspaceRoot !== bridge.cwd) {
          throw new Error('execution.muse.session: native host did not confirm the captured provider/model/mode/private workspace');
        }
        // The native run builder starts required MCP and resolves every named
        // tool before its first provider request. MSP session/start is lazy;
        // it must not be mistaken for an MCP tools/list acknowledgement.
      },
    };
  } catch (error) {bridge.close(); throw error;}
}
