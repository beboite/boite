import type {SessionContext} from '../types.ts';
import {PROTECTED_DESCRIPTION, PROTECTED_SCHEMA, PROTECTED_TOOL, PROTECTED_COMMIT, PROTECTED_COMMIT_DESCRIPTION} from '../protected.ts';

/** Last CLI layer: no host extension, hook, shell or browser may bypass the mediated tool. */
export const PROTECTED_CODEX_ARGS = ['--strict-config', ...[
  'shell_tool', 'shell_snapshot', 'hooks', 'plugins', 'apps', 'browser_use', 'browser_use_external',
  'computer_use', 'in_app_browser', 'view_image', 'image_generation', 'code_mode', 'code_mode_host',
  'multi_agent', 'multi_agent_v2', 'request_permissions_tool', 'exec_permission_approvals', 'memories',
].flatMap(feature => ['--config', `features.${feature}=false`]),
  '--config', 'features.skip_host_skill_discovery=true', '--config', 'project_doc_max_bytes=0',
  '--config', 'web_search="disabled"', '--config', 'allow_login_shell=false',
  '--config', 'shell_environment_policy.inherit="none"', '--config', 'shell_environment_policy.set={}',
  '--config', 'notify=[]',
] as const;

export function protectedCodexConfig(ctx: SessionContext): Record<string, unknown> {
  const execution = ctx.protectedExecution;
  if (!execution) return {};
  execution.check();
  return {permissions: {[profile(ctx)]: {filesystem: {':root': 'deny'}, network: {enabled: false}}}};
}
function profile(ctx: SessionContext): string { return `boite_protected_${ctx.protectedExecution!.fingerprint}`; }
export function protectedCodexThread(ctx: SessionContext): Record<string, unknown> {
  return {permissions: profile(ctx), dynamicTools: ctx.protectedExecution?.toolsAllowed === false ? [] : [{type: 'function', name: PROTECTED_TOOL,
    description: PROTECTED_DESCRIPTION, inputSchema: PROTECTED_SCHEMA}, {type: 'function', name: PROTECTED_COMMIT, description: PROTECTED_COMMIT_DESCRIPTION,
    inputSchema: {type: 'object', additionalProperties: false, properties: {message: {type: 'string', minLength: 1, maxLength: 500}}, required: ['message']}}], environments: []};
}
