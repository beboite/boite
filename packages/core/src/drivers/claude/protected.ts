import type {Options} from '@anthropic-ai/claude-agent-sdk';
import {z} from 'zod';
import type {TurnContext} from '../types.ts';
import {PROTECTED_DESCRIPTION, PROTECTED_TOOL, protectedTool, PROTECTED_COMMIT, PROTECTED_COMMIT_DESCRIPTION, protectedCommit} from '../protected.ts';

/** Native tools are removed, not entrusted to a bypassable approval callback. */
export async function protectedClaudeOptions(head: () => {ctx: TurnContext; stopped: Promise<void>} | null, toolsAllowed = true): Promise<Partial<Options>> {
  const {createSdkMcpServer, tool} = await import('@anthropic-ai/claude-agent-sdk');
  const server = createSdkMcpServer({name: 'boite_protected', version: '1.0.0', tools: [tool(PROTECTED_TOOL, PROTECTED_DESCRIPTION, {
    command: z.string().min(1), args: z.array(z.string()), cwd: z.string().optional(),
  }, async input => {
    const turn = head();
    const result = await protectedTool(turn?.ctx ?? null, input, turn?.stopped ?? Promise.resolve());
    return {isError: !result.success, content: result.contentItems.map(item => ({type: 'text' as const, text: item.text}))};
  }), tool(PROTECTED_COMMIT, PROTECTED_COMMIT_DESCRIPTION, {message: z.string().min(1).max(500)}, async input => {
    const turn = head(), result = await protectedCommit(turn?.ctx ?? null, input, turn?.stopped ?? Promise.resolve());
    return {isError: !result.success, content: result.contentItems.map(item => ({type: 'text' as const, text: item.text}))};
  })].filter(() => toolsAllowed)});
  return {
    tools: [], settingSources: [], strictMcpConfig: true, mcpServers: {boite_protected: server},
    allowedTools: toolsAllowed ? [`mcp__boite_protected__${PROTECTED_TOOL}`, `mcp__boite_protected__${PROTECTED_COMMIT}`] : [],
    plugins: [], skills: [],
    settings: {disableAllHooks: true, autoMemoryEnabled: false, permissions: {deny: ['Read', 'Edit', 'Write', 'Bash', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Agent', 'Task', 'Workflow', 'Skill']}},
  };
}
