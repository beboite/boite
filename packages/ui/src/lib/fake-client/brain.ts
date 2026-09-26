/** The brain folder: its configuration, what it holds and its sync. */
import { RpcErrorCode } from '@boite/contracts';
import { RpcFailure } from '../client';
import type { FakeContext, FakeMethods } from './context';

export function brainMethods(ctx: FakeContext) {
  return {
    'brain.status': async () => structuredClone(ctx.brain),
    'brain.configure': async (config) => {
        if (typeof config.enabled !== 'boolean' || (config.enabled && !config.path) || (config.path !== null && (typeof config.path !== 'string' || !/^(?:[A-Za-z]:[\\/]|\/)/.test(config.path)))) throw new RpcFailure({ code: RpcErrorCode.InvalidParams, message: 'brain.path must be an absolute folder path or null; enabled must be a boolean' });
        const autoPull = config.autoPull === undefined ? ctx.brain.config.autoPull : config.autoPull;
        const globalInstructions = config.globalInstructions === undefined ? ctx.brain.config.globalInstructions : config.globalInstructions;
        if (globalInstructions !== undefined && typeof globalInstructions !== 'boolean') throw new RpcFailure({ code: RpcErrorCode.InvalidParams, message: 'brain.globalInstructions must be a boolean' });
        const boiteGuide = config.boiteGuide === undefined ? ctx.brain.config.boiteGuide : config.boiteGuide;
        if (boiteGuide !== undefined && typeof boiteGuide !== 'boolean') throw new RpcFailure({ code: RpcErrorCode.InvalidParams, message: 'brain.boiteGuide must be a boolean' });
        if (autoPull !== undefined && (!autoPull || typeof autoPull.onStartup !== 'boolean' || !Number.isInteger(autoPull.intervalMinutes) || autoPull.intervalMinutes < 0 || autoPull.intervalMinutes > 1440)) throw new RpcFailure({ code: RpcErrorCode.InvalidParams, message: 'brain.autoPull.onStartup must be a boolean; intervalMinutes must be an integer from 0 to 1440' });
        if (ctx.brain.config.path !== config.path) ctx.brain.lastSync = null;
        ctx.brain.config = { ...config, ...(autoPull ? { autoPull: { ...autoPull } } : {}), ...(globalInstructions !== undefined ? { globalInstructions } : {}), ...(boiteGuide !== undefined ? { boiteGuide } : {}) };
        ctx.brain.links = config.path && config.enabled && globalInstructions ? [
          ['Claude Code', '.claude/CLAUDE.md'], ['Codex', '.codex/AGENTS.md'], ['OpenCode', '.config/opencode/AGENTS.md'],
          ['pi', '.pi/agent/AGENTS.md'], ['Grok', '.grok/AGENTS.md'], ['Gemini / Antigravity', '.gemini/GEMINI.md'], ['Muse', '.config/muse/AGENTS.md'],
        ].map(([name, path]) => ({ name: name!, path: `/home/user/${path}`, state: 'linked' as const, error: null })) : [];
        ctx.brain.entries = config.path ? [
          { kind: 'instructions', name: 'AGENTS.md', path: 'AGENTS.md', description: '', error: null },
          { kind: 'skill', name: 'code-review', path: 'skills/code-review/SKILL.md', description: 'Review changes and check the affected behavior.', error: null },
          { kind: 'plugin', name: 'team-tools', path: 'plugins/team-tools/.claude-plugin/plugin.json', description: 'Shared tools for the team.', error: null },
        ] : [];
        ctx.brain.git = config.path ? { branch: 'main', upstream: 'origin/main', ahead: 0, behind: 0, dirty: false } : null;
        return structuredClone(ctx.brain);
    },
    'brain.sync': async () => {
        if (!ctx.brain.git) throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'brain.path must point to the root of a Git checkout to synchronize' });
        ctx.brain.lastSync = Date.now();
        return structuredClone(ctx.brain);
    },
  } satisfies Partial<FakeMethods>;
}
