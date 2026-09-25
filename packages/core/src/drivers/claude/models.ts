import type { Query, SpawnOptions as SdkSpawnOptions } from '@anthropic-ai/claude-agent-sdk';
import type { ModelInfo } from '@boite/contracts';
import { unavailable } from '../../errors.ts';
import type { SpawnedChild } from '../../procs.ts';
import { profileFor, resolveExecutable } from '../../providers/loader.ts';
import type { ProbeContext, ProbeResult } from '../types.ts';
import { childEnv, PromptQueue } from './query.ts';
import type { ClaudeDeps } from './query.ts';

export async function readClaudeModels(ctx: ProbeContext, deps: ClaudeDeps): Promise<ProbeResult> {
  const profile = profileFor(ctx.provider);
  const executable = profile ? resolveExecutable(profile) : null;
  if (!executable) throw unavailable('no Claude executable for model discovery');
  const prompts = new PromptQueue();
  const abortController = new AbortController();
  let query: Query | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const queryFn = await deps.loadQuery();
    query = queryFn({ prompt: prompts.stream(), options: {
      cwd: ctx.cwd, pathToClaudeCodeExecutable: executable, abortController,
      env: childEnv(ctx.accountEnv), settingSources: ['user'], persistSession: false,
      tools: [], mcpServers: {},
      spawnClaudeCodeProcess: (options: SdkSpawnOptions): SpawnedChild => {
        const child = ctx.spawnChild(options.command, options.args, { cwd: options.cwd, env: options.env });
        child.stderr.resume(); return child;
      },
    } });
    const rows = await Promise.race([query.supportedModels(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Claude model discovery timed out after 20 seconds')), 20_000);
    })]);
    const models: ModelInfo[] = rows.filter(row => !/^(default|auto)$/i.test(row.value)).map(row => {
      const id = row.resolvedModel ?? row.value;
      const known = ctx.provider.models.find(model => model.id === id.replace(/\[.*\]$/, ''));
      const versioned = row.description.match(/^(?:Claude\s+)?((?:Fable|Opus|Sonnet|Haiku)\s+\d+(?:\.\d+)*)(?:\b|$)/i)?.[1];
      const name = known?.name ?? (versioned ? `Claude ${versioned}` : row.displayName);
      const levels = row.supportsEffort ? (row.supportedEffortLevels ?? []).map(id => ({ id: String(id), label: id === 'xhigh' ? 'Extra high' : id.charAt(0).toUpperCase() + id.slice(1) })) : [];
      if (row.supportsAdaptiveThinking) levels.push({ id: 'ultrathink', label: 'Ultrathink' });
      return { id, name: id.includes('[1m]') ? `${name} (1M)` : name,
        ...(levels.length ? { effort: { levels, default: levels.some(l => l.id === 'high') ? 'high' : levels[0]!.id } } : {}),
        ...(row.supportsFastMode ? { speeds: [{ id: 'fast', label: 'Fast' }] } : {}),
      };
    });
    const current = new Set(models.map(model => model.id.replace(/\[.*\]$/, '')));
    // Explicit legacy ids remain runnable even when the CLI only lists its aliases.
    // Unknown native capabilities stay absent rather than inheriting another model's.
    for (const model of ctx.provider.models) {
      if (model.legacy && !current.has(model.id)) models.push({ id: model.id, name: model.name, legacy: true });
    }
    return { models: models.filter((model, index) => models.findIndex(m => m.id === model.id) === index), probedAt: Date.now() };
  } finally { if (timer) clearTimeout(timer); prompts.end(); query?.close(); abortController.abort(); ctx.killTree(); }
}
