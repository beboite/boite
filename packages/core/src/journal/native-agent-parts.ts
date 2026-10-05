import type { MessagePart } from '@boite/contracts';

/**
 * Which message parts are a native agent call: a tool named Agent, Task or
 * subagent in any case, or one carrying a `nativeAgents` list. The team view
 * reads only the messages `native_agent_messages` names, instead of parsing
 * every part of a long thread on each `delegation.get`.
 */
const NAMES = ['agent', 'task', 'subagent'];

export function isNativeAgentPart(part: MessagePart | undefined): boolean {
  return part?.type === 'tool' && (part.nativeAgents !== undefined || NAMES.includes(String(part.name).toLowerCase()));
}

/** The same test on a `json_each` row named `alias`. */
export function nativeAgentPartSql(alias: string): string {
  return `json_extract(${alias}.value, '$.type') = 'tool'
    AND (json_type(${alias}.value, '$.nativeAgents') = 'array' OR lower(json_extract(${alias}.value, '$.name')) IN (${NAMES.map(name => `'${name}'`).join(', ')}))`;
}
