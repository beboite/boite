/** OpenCode 2's native controls, expressed as the ACP options the session owns. */
import type { SessionConfigOption } from '@agentclientprotocol/sdk';
import { plainObject } from './models.ts';

export type NativeCall = (path: string, method?: string, body?: unknown) => Promise<unknown>;
export const object = (value: unknown): Record<string, unknown> => plainObject(value) ?? {};
export const list = (value: unknown): Record<string, unknown>[] => Array.isArray(value) ? value.map(object) : [];
export const text = (value: unknown): string => typeof value === 'string' ? value : '';

export class OpenCodeControls {
  private models: Record<string, unknown>[] = [];
  private agents: Record<string, unknown>[] = [];
  private model: Record<string, unknown> = {};
  private mode = 'build';
  commands: Record<string, unknown>[] = [];

  constructor(private readonly call: NativeCall, private readonly cwd: string) {}

  async read(session: Record<string, unknown>): Promise<void> {
    const query = `?${new URLSearchParams({ 'location[directory]': this.cwd })}`;
    const [models, preferred, agents, commands] = await Promise.all([
      this.call(`/api/model${query}`), this.call(`/api/model/default${query}`),
      this.call(`/api/agent${query}`), this.call(`/api/command${query}`),
    ]);
    this.models = list(object(models)['data']).filter(model => model['enabled'] !== false);
    this.agents = list(object(agents)['data']).filter(agent => agent['mode'] !== 'subagent' && agent['hidden'] !== true);
    this.commands = list(object(commands)['data']);
    const model = object(session['model'] ?? object(preferred)['data']);
    this.model = { providerID: model['providerID'], id: model['id'], ...(model['variant'] ? { variant: model['variant'] } : {}) };
    this.mode = text(session['agent']) || text(this.agents[0]?.['id']) || 'build';
  }

  options(): SessionConfigOption[] {
    const id = `${text(this.model['providerID'])}/${text(this.model['id'])}`;
    const selected = this.models.find(model => model['providerID'] === this.model['providerID'] && model['id'] === this.model['id']);
    return [
      { id: 'model', category: 'model', name: 'Model', type: 'select', currentValue: id,
        options: this.models.map(model => ({ value: `${text(model['providerID'])}/${text(model['id'])}`, name: text(model['name']) || text(model['id']) })) },
      { id: 'thought_level', category: 'thought_level', name: 'Thinking', type: 'select', currentValue: text(this.model['variant']) || 'default',
        options: [{ value: 'default', name: 'Default' }, ...list(selected?.['variants']).map(variant => ({ value: text(variant['id']), name: text(variant['id']) }))] },
      { id: 'mode', category: 'mode', name: 'Mode', type: 'select', currentValue: this.mode,
        options: this.agents.map(agent => ({ value: text(agent['id']), name: text(agent['name']) || text(agent['id']) })) },
    ];
  }

  async set(sessionId: string, configId: string, value: string): Promise<void> {
    const path = `/api/session/${encodeURIComponent(sessionId)}`;
    if (configId === 'mode') {
      await this.call(`${path}/agent`, 'POST', { agent: value });
      this.mode = value;
      return;
    }
    let model: Record<string, unknown>;
    if (configId === 'model') {
      const slash = value.indexOf('/');
      if (slash < 1) throw new Error(`OpenCode model must be provider/model, received ${value}`);
      model = { providerID: value.slice(0, slash), id: value.slice(slash + 1) };
    } else if (configId === 'thought_level') {
      model = { ...this.model };
      delete model['variant'];
      if (value !== 'default') model['variant'] = value;
    } else throw new Error(`OpenCode configId must be model, thought_level or mode, received ${configId}`);
    await this.call(`${path}/model`, 'POST', { model });
    this.model = model;
  }

  contextWindow(): number {
    const model = this.models.find(model => model['providerID'] === this.model['providerID'] && model['id'] === this.model['id']);
    const size = object(model?.['limit'])['context'];
    return typeof size === 'number' ? size : 0;
  }
}
