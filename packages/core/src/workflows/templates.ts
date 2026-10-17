// Workflow template storage and project-scoped access, independent of running steps.
import { checkPlan } from '@boite/contracts';
import type { Principal, RpcParams, ThreadSummary, WorkflowTemplate } from '@boite/contracts';
import type { Core } from '../core.ts';
import { invalidParams, refused } from '../errors.ts';
import { newId } from '../ids.ts';
import { planError, text } from './validation.ts';

interface DataRow { data: string }

export function listTemplates(core: Core, root: ThreadSummary): WorkflowTemplate[] {
  return (core.journal.db.query('SELECT data FROM workflow_templates WHERE project_id IS ? ORDER BY name').all(root.projectId) as DataRow[]).map(row => JSON.parse(row.data) as WorkflowTemplate);
}

export function saveTemplate(core: Core, root: ThreadSummary, params: RpcParams<'workflows.templates.save'>, principal: Principal): WorkflowTemplate {
  const name = text(params.name, 'name', 80).trim();
  // Profiles are checked when a run starts: a template outlives today's routes.
  const named = Array.isArray((params.plan as { steps?: unknown } | null)?.steps) ? (params.plan.steps as { profile?: unknown }[]).map(s => String(s?.profile ?? '')) : [];
  const { plan } = planError(() => checkPlan(params.plan, { profiles: named }));
  const now = Date.now();
  const byId = params.templateId === undefined ? null : core.journal.db.query('SELECT data FROM workflow_templates WHERE id = ? AND project_id IS ?').get(params.templateId, root.projectId) as DataRow | null;
  if (params.templateId !== undefined && !byId) throw invalidParams(`templateId: no template ${params.templateId} in this project`);
  const byName = byId ?? core.journal.db.query('SELECT data FROM workflow_templates WHERE name = ? AND project_id IS ?').get(name, root.projectId) as DataRow | null;
  const previous = byName ? JSON.parse(byName.data) as WorkflowTemplate : null;
  // The owner runs a template by its name: an agent adds plans, it never swaps one under that name.
  if (previous && principal === 'agent') throw refused(`a template named "${previous.name}" already exists in this project; save the plan under a new name`);
  const template: WorkflowTemplate = { id: previous?.id ?? newId('wft_'), projectId: root.projectId, name, plan: { ...plan, name }, createdAt: previous?.createdAt ?? now, updatedAt: now };
  core.journal.append({ type: 'workflow.template', threadId: root.id, version: 1, payload: { id: template.id, name } }, db => {
    db.query('INSERT OR REPLACE INTO workflow_templates VALUES (?, ?, ?, ?, ?, ?)').run(template.id, template.projectId, template.name, template.createdAt, template.updatedAt, JSON.stringify(template));
  });
  core.bus.emit('workflows.changed', { threadId: root.id, runId: '' });
  return template;
}

export function removeTemplate(core: Core, root: ThreadSummary, templateId: string): { removed: boolean } {
  const removed = core.journal.append({ type: 'workflow.template.removed', threadId: root.id, version: 1, payload: { id: templateId } }, db =>
    db.query('DELETE FROM workflow_templates WHERE id = ? AND project_id IS ?').run(templateId, root.projectId).changes > 0);
  core.bus.emit('workflows.changed', { threadId: root.id, runId: '' });
  return { removed };
}
