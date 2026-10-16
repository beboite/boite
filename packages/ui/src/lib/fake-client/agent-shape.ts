import { RpcErrorCode, type AgentShape, type AgentShapeTool } from '@boite/contracts';
import { RpcFailure } from '../client';
import type { FakeContext, FakeMethods } from './context';

/** Written for the fixture: sizes in the range a Claude Code request carries, no recorded prompt. */
const SYSTEM = [
  'You are a coding agent running inside Boite, on the user\'s machine.',
  [
    '# Working rules',
    '',
    'Read the repository\'s AGENTS.md before changing code. Keep changes to what the task names.',
    'Run the checks the project lists and quote the line that decides each one.',
    '',
    '# Tools',
    '',
    'Prefer the dedicated file tools over shell commands for reading and editing files.',
    'Batch independent reads in one message; run dependent steps one after the other.',
  ].join('\n'),
  [
    '# Environment',
    '',
    'Working directory: C:\\src\\boite',
    'Platform: windows',
    'Shell: PowerShell 7',
  ].join('\n'),
];

const TOOLS: [name: string, description: number, schema: number][] = [
  ['Bash', 1183, 1700], ['Read', 790, 1100], ['Edit', 360, 600], ['Write', 240, 380],
  ['Grep', 980, 1500], ['Glob', 420, 400], ['WebFetch', 469, 640], ['TodoWrite', 2600, 1300],
  ['AskUserQuestion', 1097, 3100], ['Skill', 1417, 380], ['mcp__boite__boite_capabilities', 120, 90],
];

function shape(threadId: string, sessionId: string, model: string | null, effort: string | null): AgentShape {
  const tools: AgentShapeTool[] = TOOLS.map(([name, descriptionChars, schema]) => ({ name, descriptionChars, chars: name.length + descriptionChars + schema + 40 }))
    .sort((a, b) => b.chars - a.chars || a.name.localeCompare(b.name));
  const system = SYSTEM.map(text => ({ chars: text.length, text, truncated: false }));
  // One block cut by the core's bound, as a long instructions file is.
  const long = 'Shared rules for every agent of this machine.\n'.repeat(900);
  system.push({ chars: long.length, text: long.slice(0, 32_000), truncated: true });
  const chars = { system: system.reduce((sum, block) => sum + block.chars, 0), tools: tools.reduce((sum, tool) => sum + tool.chars, 0) };
  return {
    threadId, status: 'ready', sessionId, version: '2.1.300', at: Date.now() - 90_000,
    model, effort, thinking: 'adaptive', betas: ['claude-code-20250219', 'interleaved-thinking-2025-05-14', 'context-management-2025-06-27'],
    maxTokens: 64_000, system, tools, omitted: { system: 0, tools: 0 }, chars,
    estimatedTokens: Math.ceil((chars.system + chars.tools) / 4),
  };
}

export function agentShapeMethods(ctx: FakeContext): Pick<FakeMethods, 'threads.agentShape'> {
  return {
    'threads.agentShape': async ({ threadId }) => {
      const thread = ctx.thread(threadId);
      const provider = ctx.providers.find(item => item.id === thread.providerId);
      if (provider?.protocol !== 'claude-sdk') {
        throw new RpcFailure({ code: RpcErrorCode.Refused, message: `threads.agentShape reads Claude Code transcripts; this thread runs ${thread.providerId}`,
          data: { threadId, field: 'providerId', expected: 'a provider on the claude-sdk protocol' } });
      }
      if (thread.sessionId === null) {
        return { threadId, status: 'no-session', sessionId: null, version: null, at: null, model: null, effort: null, thinking: null, betas: [], maxTokens: null,
          system: [], tools: [], omitted: { system: 0, tools: 0 }, chars: { system: 0, tools: 0 }, estimatedTokens: 0 };
      }
      return shape(threadId, thread.sessionId, thread.model, thread.effort);
    },
  };
}
