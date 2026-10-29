import {homedir} from 'node:os';
import {join, resolve} from 'node:path';
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import type {SessionContext} from '../types.ts';
import {linkAccountFiles, protectedBridge, protectedControlEnvironment, selectionSettings, type ProtectedHead} from '../protected-bridge.ts';

/** pi's native extension API gates even forged calls and nested tool execution. */
export function protectedPi(ctx: SessionContext, head: ProtectedHead, declared: string[]) {
  if (!ctx.protectedExecution) return null;
  if (!['yolo', 'bypassPermissions'].includes(ctx.thread.permissionMode)) throw new Error('execution.pi.permissionMode: pi supports protected automatic tools only in yolo or bypassPermissions; RPC has no native approval mode');
  if (JSON.stringify(declared) !== JSON.stringify(['--mode', 'rpc'])) throw new Error('execution.pi.launch.args: expected only --mode rpc for protected execution');
  const selectedEnv = protectedControlEnvironment(ctx);
  const bridge = protectedBridge(ctx, head);
  try {
    const home = selectedEnv['HOME'] || homedir();
    const configured = selectedEnv['PI_CODING_AGENT_DIR'] || join(home, '.pi', 'agent');
    const source = resolve(ctx.thread.cwd, configured === '~' ? home : configured.startsWith('~/') ? join(home, configured.slice(2)) : configured);
    const agentDir = join(bridge.directory, 'agent');
    mkdirSync(agentDir);
    for (const name of ['auth.json', 'models.json']) {
      if (!existsSync(join(source, name))) continue;
      const value: unknown = Bun.JSON5.parse(readFileSync(join(source, name), 'utf8'));
      rejectCommandValues(value, name);
      // Freeze model selection; an editable catalog must not change after admission.
      if (name === 'models.json') writeFileSync(join(agentDir, 'models.json'), JSON.stringify(value), {mode: 0o600});
    }
    linkAccountFiles(source, agentDir, ['auth.json']);
    writeFileSync(join(agentDir, 'settings.json'), JSON.stringify(selectionSettings(join(source, 'settings.json'), ['defaultProvider', 'defaultModel', 'defaultThinkingLevel'])));
    const extension = bridge.asset('pi-protected.mjs', `
const endpoint = ${JSON.stringify(bridge.url)}, authorization = ${JSON.stringify(`Bearer ${bridge.token}`)};
const definitions = ${JSON.stringify(bridge.definitions)};
async function call(path, body) {
  const response = await fetch(endpoint + path, {method: 'POST', headers: {authorization, 'content-type': 'application/json'}, body: JSON.stringify(body)});
  if (!response.ok) throw new Error('Protected tool channel refused');
  return response.json();
}
export default function(pi) {
  for (const definition of definitions) pi.registerTool({name: definition.name, label: definition.name,
    description: definition.description, parameters: definition.inputSchema,
    async execute(_id, input) {
      const result = await call('/call', {name: definition.name, input});
      if (!result.success) throw new Error(result.contentItems.map(item => item.text).join('\\n'));
      return {content: result.contentItems.map(item => ({type: 'text', text: item.text})), details: {protected: true}};
    }});
  pi.on('tool_call', event => {
    if (!definitions.some(definition => definition.name === event.toolName)) return {block: true, reason: 'Unprotected native or extension tool refused'};
  });
  pi.on('session_start', async () => {
    pi.setActiveTools(definitions.map(definition => definition.name));
    await call('/ready', {fingerprint: ${JSON.stringify(ctx.protectedExecution.fingerprint)}});
  });
}
`);
    return {...bridge, env: {PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: '1'}, args: ['--no-builtin-tools', '--no-extensions', '--no-mcp', '--no-skills', '--no-prompt-templates', '--no-context-files', '--no-themes', '--no-approve', '--extension', extension]};
  } catch (error) {bridge.close(); throw error;}
}

/** pi resolves API keys and header values beginning with ! as unrestricted shell commands. */
function rejectCommandValues(value: unknown, field: string, executable = false): void {
  if (executable && typeof value === 'string' && value.startsWith('!')) throw new Error(`execution.pi.config.${field}: command-valued authentication requires a protected credential helper`);
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) rejectCommandValues(child, `${field}.${key}`, executable || ['key', 'apiKey', 'headers'].includes(key));
}
