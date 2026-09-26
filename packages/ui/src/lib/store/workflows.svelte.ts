import type { ThreadId, WorkflowRun, WorkflowTemplate } from '@boite/contracts';
import type { StoreContext } from './context';

/** The workflow runs of the open thread's tree and its project's saved plans. */
export class Workflows {
  /** The workflow runs rooted at the open thread, or at its parent for a step, newest first. */
  workflows = $state<WorkflowRun[]>([]);
  /** The thread `workflows` was read for, so a list never shows under another thread. */
  workflowsThreadId = $state<ThreadId | null>(null);
  workflowTemplates = $state<WorkflowTemplate[]>([]);
  workflowsError = $state<string | null>(null);
  workflowsEpoch = 0;
  /** A burst of `workflows.changed` becomes one read: set while one is in flight. */
  workflowsReading: { threadId: ThreadId; again: boolean } | null = null;

  constructor(private readonly ctx: StoreContext) {}

  reset(): void {
    this.workflowsEpoch++;
    this.workflowsReading = null;
    this.workflows = [];
    this.workflowsThreadId = null;
    this.workflowTemplates = [];
    this.workflowsError = null;
  }

  /**
   * The runs and the project's templates for this thread. Events arrive once
   * per saved step, so a read already in flight for the same thread is marked
   * to go again rather than joined by a second one.
   */
  async loadWorkflows(threadId = this.ctx.store.openThread?.id): Promise<void> {
    const s = this.ctx.store;
    const client = this.ctx.client;
    if (!client || !threadId) return;
    const reading = this.workflowsReading;
    if (reading?.threadId === threadId) {
      reading.again = true;
      return;
    }
    const epoch = ++this.workflowsEpoch;
    const entry = { threadId, again: false };
    this.workflowsReading = entry;
    const current = () => this.ctx.client === client && s.openThread?.id === threadId && this.workflowsEpoch === epoch;
    try {
      do {
        entry.again = false;
        const [runs, templates] = await Promise.all([
          client.call('workflows.list', { threadId }),
          client.call('workflows.templates.list', { threadId })
        ]);
        if (!current()) return;
        if (this.workflowsThreadId !== threadId) this.workflowsError = null;
        this.workflows = runs;
        this.workflowTemplates = templates;
        this.workflowsThreadId = threadId;
      } while (entry.again && current());
    } catch (error) {
      if (current()) this.workflowsError = this.ctx.reason(error);
    } finally {
      if (this.workflowsReading === entry) this.workflowsReading = null;
    }
  }

  /** The runs of `threadId`'s tree, empty while the list was read for another thread. */
  workflowsOf(threadId: ThreadId): WorkflowRun[] {
    return this.workflowsThreadId === threadId ? this.workflows : [];
  }

  isWorkflowStep(threadId: ThreadId): boolean {
    return this.workflows.some(run => run.nodes.some(node => node.instances.some(inst => inst.threadId === threadId)));
  }

  /** Pause, resume, stop or retry, sent as the run's root: the core refuses a step thread. */
  async controlWorkflow(run: WorkflowRun, action: 'pause' | 'resume' | 'stop' | 'retry', stepId?: string): Promise<boolean> {
    const client = this.ctx.client;
    if (!client) return false;
    this.workflowsError = null;
    try {
      const next = await client.call('workflows.control', { threadId: run.rootThreadId, runId: run.id, action, ...(stepId ? { stepId } : {}) });
      if (client === this.ctx.client) this.workflows = this.workflows.map(one => one.id === next.id ? next : one);
      return true;
    } catch (error) {
      if (client === this.ctx.client) this.workflowsError = this.ctx.reason(error);
      return false;
    }
  }

  /** Starts a saved plan on the open thread, or on its parent when a step is open. */
  async startWorkflowTemplate(template: WorkflowTemplate): Promise<WorkflowRun | null> {
    const s = this.ctx.store;
    const client = this.ctx.client;
    const thread = s.openThread;
    if (!client || !thread || !s.owner) return null;
    this.workflowsError = null;
    try {
      const run = await client.call('workflows.start', { threadId: thread.parentThreadId ?? thread.id, plan: template.plan, templateId: template.id, requestId: crypto.randomUUID() });
      if (client === this.ctx.client && s.openThread?.id === thread.id) await s.loadWorkflows(thread.id);
      return run;
    } catch (error) {
      if (client === this.ctx.client) this.workflowsError = this.ctx.reason(error);
      return null;
    }
  }

  async saveWorkflowTemplate(run: WorkflowRun, name: string): Promise<WorkflowTemplate | null> {
    const s = this.ctx.store;
    const client = this.ctx.client;
    if (!client || !s.owner || !name.trim()) return null;
    this.workflowsError = null;
    try {
      const template = await client.call('workflows.templates.save', { threadId: run.rootThreadId, name: name.trim(), plan: run.plan });
      if (client === this.ctx.client) await s.loadWorkflows(s.openThread?.id);
      return template;
    } catch (error) {
      if (client === this.ctx.client) this.workflowsError = this.ctx.reason(error);
      return null;
    }
  }

  async removeWorkflowTemplate(template: WorkflowTemplate): Promise<void> {
    const s = this.ctx.store;
    const client = this.ctx.client;
    const threadId = s.openThread?.id;
    if (!client || !threadId || !s.owner) return;
    this.workflowsError = null;
    try {
      await client.call('workflows.templates.remove', { threadId, templateId: template.id });
      if (client === this.ctx.client) await s.loadWorkflows(threadId);
    } catch (error) {
      if (client === this.ctx.client) this.workflowsError = this.ctx.reason(error);
    }
  }
}
