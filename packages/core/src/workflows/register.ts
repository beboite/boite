// Workflow RPC registration and loading model lists needed by plan checks.
import type { Core } from '../core.ts';
import type { RpcContext } from '../router.ts';
import type { ProviderProbe } from '../providers/probe.ts';

/** Registered beside delegation: the same principals, the core checks the thread. */
/** The model names a plan's steps carry, so their providers' lists are read before the checks. A step on another machine is matched there. */
function stepModels(steps: unknown): (string | undefined)[] {
  return Array.isArray(steps) ? steps.map(step => {
    const raw = step as { model?: unknown; machine?: unknown } | null;
    return typeof raw?.model === 'string' && raw.machine == null ? raw.model : undefined;
  }) : [];
}

export function registerWorkflowMethods(core: Core, probe: ProviderProbe): void {
  const principal = (ctx: RpcContext) => ctx.connection.identity.principal;
  const routes = (threadId: string, steps: unknown) => core.delegation.prepareRoutes(threadId, probe, stepModels(steps));
  core.router.register('workflows.list', params => core.workflows.list(params.threadId));
  core.router.register('workflows.get', params => core.workflows.get(params.threadId, params.runId));
  core.router.register('workflows.check', async params => { await routes(params.threadId, params.plan?.steps); return core.workflows.check(params.threadId, params.plan); });
  core.router.register('workflows.start', async (params, ctx) => { await routes(params.threadId, params.plan?.steps); return core.workflows.start(params, principal(ctx) === 'agent' ? 'agent' : 'user'); });
  core.router.register('workflows.extend', async (params, ctx) => { await routes(params.threadId, params.steps); return core.workflows.extend(params, principal(ctx)); });
  core.router.register('workflows.control', (params, ctx) => core.workflows.control(params, principal(ctx)));
  core.router.register('workflows.output', params => core.workflows.output(params.threadId, params.value));
  core.router.register('workflows.templates.list', params => core.workflows.templates(params.threadId));
  core.router.register('workflows.templates.save', (params, ctx) => core.workflows.saveTemplate(params, principal(ctx)));
  core.router.register('workflows.templates.remove', params => core.workflows.removeTemplate(params.threadId, params.templateId));
}
