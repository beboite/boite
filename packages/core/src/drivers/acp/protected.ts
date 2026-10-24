import {homedir} from 'node:os';
import {join, resolve} from 'node:path';
import {existsSync, mkdirSync, readFileSync} from 'node:fs';
import type {SessionContext} from '../types.ts';
import {linkAccountFiles, protectedBridge, protectedControlEnvironment, selectionSettings, type ProtectedHead} from '../protected-bridge.ts';

/** ACP itself specifies no native-tool confinement. Only this verified implementation is admitted. */
export function protectedAcp(ctx: SessionContext, head: ProtectedHead, declared: string[]) {
  if (!ctx.protectedExecution) return null;
  if (ctx.provider.id !== 'opencode') throw new Error('execution.acp.provider: protected tools require the verified OpenCode 1 extension; ACP capability claims do not attest isolation');
  if (!['default', 'plan'].includes(ctx.thread.permissionMode)) throw new Error('execution.acp.permissionMode: OpenCode protected ACP supports only its native build/default and plan modes; no plain-mode fallback');
  if (JSON.stringify(declared) !== JSON.stringify(['acp', '--port', '0']) && JSON.stringify(declared) !== JSON.stringify(['acp'])) throw new Error('execution.acp.launch.args: expected acp with optional --port 0 for protected execution');
  const selectedEnv = protectedControlEnvironment(ctx);
  const bridge = protectedBridge(ctx, head);
  try {
    const configRoot = join(bridge.directory, 'config');
    mkdirSync(join(configRoot, 'opencode'), {recursive: true});
    const source = resolve(ctx.thread.cwd, selectedEnv['XDG_CONFIG_HOME'] || join(selectedEnv['HOME'] || homedir(), '.config'), 'opencode');
    const selection = ['provider', 'model', 'small_model', 'enabled_providers', 'disabled_providers'];
    // Normalize only data fields, following the native global/custom-config precedence.
    // External plugin, MCP, command and agent discovery never follows these files.
    if (existsSync(join(source, 'config'))) throw new Error('execution.acp.config: migrate the legacy TOML config to JSON before protected execution');
    const files = ['config.json', 'opencode.json', 'opencode.jsonc'].map(name => join(source, name));
    if (selectedEnv['OPENCODE_CONFIG']) files.push(resolve(ctx.thread.cwd, selectedEnv['OPENCODE_CONFIG']));
    if (selectedEnv['OPENCODE_CONFIG_DIR']) for (const name of ['opencode.json', 'opencode.jsonc']) files.push(resolve(ctx.thread.cwd, selectedEnv['OPENCODE_CONFIG_DIR'], name));
    let settings: Record<string, unknown> = {};
    for (const file of files) settings = mergeSelection(settings, selectionSettings(file, selection));
    const inline: unknown = Bun.JSON5.parse(selectedEnv['OPENCODE_CONFIG_CONTENT'] || '{}');
    if (!inline || typeof inline !== 'object' || Array.isArray(inline)) throw new Error('execution.acp.config.OPENCODE_CONFIG_CONTENT: expected an object');
    settings = mergeSelection(settings, Object.fromEntries(Object.entries(inline).filter(([key]) => selection.includes(key))));
    rejectExternalSdk(settings['provider'], 'provider');
    const authRoot = resolve(ctx.thread.cwd, selectedEnv['XDG_DATA_HOME'] || join(selectedEnv['HOME'] || homedir(), '.local/share'), 'opencode');
    const authFile = join(authRoot, 'auth.json');
    if (existsSync(authFile)) {
      const auth = JSON.parse(readFileSync(authFile, 'utf8')) as Record<string, {type?: unknown}>;
      if (Object.values(auth).some(value => !value || !['api', 'oauth'].includes(String(value.type)))) throw new Error('execution.acp.auth: remote-configuration credentials cannot load unprotected plugins; expected native api or oauth records');
    }
    const dataRoot = join(bridge.directory, 'data');
    linkAccountFiles(authRoot, join(dataRoot, 'opencode'), ['auth.json']);
    const plugin = bridge.asset('opencode-protected.mjs', `
export default async function() {
  const response = await fetch(${JSON.stringify(bridge.url + '/ready')}, {method: 'POST', headers: {authorization: ${JSON.stringify(`Bearer ${bridge.token}`)}, 'content-type': 'application/json'}, body: JSON.stringify({fingerprint: ${JSON.stringify(ctx.protectedExecution.fingerprint)}})});
  if (!response.ok || !(await response.json()).ready) throw new Error('Protected extension admission failed');
  return {'tool.execute.before': async (input) => {
    if (!${JSON.stringify(bridge.definitions.map(d => `boite_protected_${d.name}`))}.includes(input.tool)) throw new Error('Unprotected native, plugin or MCP tool refused');
  }, 'command.execute.before': async () => {throw new Error('Unprotected native command refused');}};
}
`);
    const config = {...settings, plugin: [plugin], instructions: [], lsp: false, formatter: false,
      permission: {'*': 'deny', boite_protected_boite_exec: 'allow', boite_protected_boite_commit: 'allow'},
      mcp: {boite_protected: {type: 'remote', url: bridge.url + '/mcp', headers: {Authorization: `Bearer ${bridge.token}`}, oauth: false, enabled: true}}};
    const file = bridge.asset('opencode.json', JSON.stringify(config));
    return {...bridge, env: {HOME: bridge.directory, OPENCODE_TEST_HOME: bridge.directory, XDG_CONFIG_HOME: configRoot, XDG_DATA_HOME: dataRoot, XDG_CACHE_HOME: join(bridge.directory, 'cache'), XDG_STATE_HOME: join(bridge.directory, 'state'),
      OPENCODE_CONFIG: file, OPENCODE_CONFIG_DIR: join(configRoot, 'opencode'), OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
      OPENCODE_DISABLE_PROJECT_CONFIG: '1', OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_LSP_DOWNLOAD: '1',
      OPENCODE_PERMISSION: JSON.stringify(config.permission)}};
  } catch (error) {bridge.close(); throw error;}
}

/** Same data merge behavior as native configuration, with no executable module resolution. */
function mergeSelection(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const merged = {...base};
  for (const [key, value] of Object.entries(patch)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error(`execution.acp.config.${key}: unsafe configuration key`);
    const previous = merged[key];
    merged[key] = value && typeof value === 'object' && !Array.isArray(value) && previous && typeof previous === 'object' && !Array.isArray(previous)
      ? mergeSelection(previous as Record<string, unknown>, value as Record<string, unknown>) : value;
  }
  return merged;
}

// OpenCode 1.19.3 bundles these providers; any other npm value invokes installation/import.
const bundled = new Set(['@ai-sdk/amazon-bedrock', '@ai-sdk/amazon-bedrock/mantle', '@ai-sdk/anthropic', '@ai-sdk/azure', '@ai-sdk/google',
  '@ai-sdk/google-vertex', '@ai-sdk/google-vertex/anthropic', '@ai-sdk/openai', '@ai-sdk/openai-compatible', '@openrouter/ai-sdk-provider',
  '@ai-sdk/xai', '@ai-sdk/mistral', '@ai-sdk/groq', '@ai-sdk/deepinfra', '@ai-sdk/cerebras', '@ai-sdk/cohere', '@ai-sdk/gateway',
  '@ai-sdk/togetherai', '@ai-sdk/perplexity', '@ai-sdk/vercel', '@ai-sdk/alibaba', 'gitlab-ai-provider', '@ai-sdk/github-copilot', 'venice-ai-sdk-provider']);
function rejectExternalSdk(value: unknown, field: string): void {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (key === 'npm' && (typeof child !== 'string' || !bundled.has(child))) throw new Error(`execution.acp.${field}.npm: expected a bundled SDK; external code imports require protected execution`);
    rejectExternalSdk(child, `${field}.${key}`);
  }
}
