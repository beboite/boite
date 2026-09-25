import type { ModelInfo, ProviderId, ProviderSummary } from '@boite/contracts';
import { DEFAULT_MODEL_NAMES, INITIAL_MODEL_DEFAULTS, writeModelDefaults, resolveModelDefault, type ModelDefaults } from '../model-defaults';
import { FAVORITES_KEY, isNamedModel, readFavorites, type FavoriteModel } from '../model-order';
import { defaultPrefs, writePrefs, type ComposerPrefs } from '../prefs';
import { strings } from '../strings';
import { work, type Profile } from '../work-prefs.svelte';
import type { Choice } from '../store.svelte';
import type { StoreContext } from './context';

/** One probe answer per provider and account, the key the core uses too. */
export function probeKey(providerId: ProviderId, accountId: string): string {
  return `${providerId}::${accountId}`;
}

/**
 * What the composer runs on: the remembered choice, the per-provider model
 * defaults, the favorites, and what each agent answered `providers.probe` with.
 */
export class Models {
  prefs = $state<ComposerPrefs>(defaultPrefs());
  modelDefaults = $state<ModelDefaults>({});
  draftChoice = $state<Choice | null>(null);
  favorites = $state<FavoriteModel[]>(readFavorites());
  /**
   * What an agent answered `providers.probe` with, keyed `providerId::accountId`.
   * An ACP agent owns its model list; the descriptor only carries `default`.
   * One entry per provider and account the picker has opened this session, which
   * is what bounds it: the pairs exist on the machine, they do not arrive with
   * time, and an account that changes drops its own key.
   */
  probedModels = $state<Record<string, ModelInfo[]>>({});
  probeAttempts = new Set<string>();
  /** One per-model effort read per provider, account and model, see `probeModelEffort`. */
  effortAttempts = new Set<string>();
  probeRequests = new Map<string, Promise<void>>();
  probeEpoch = 0;
  /** The keys a probe is running for, so the picker can say it is reading. */
  probingModels = $state<string[]>([]);

  constructor(private readonly ctx: StoreContext) {}

  toggleFavorite(providerId: string, accountId: string, model: ModelInfo): void {
    const matches = (f: FavoriteModel) => f.providerId === providerId && f.accountId === accountId && f.model.id === model.id;
    this.favorites = this.favorites.some(matches) ? this.favorites.filter((f) => !matches(f))
      : [...this.favorites, { providerId, accountId, model }];
    try { localStorage.setItem(FAVORITES_KEY, JSON.stringify(this.favorites)); } catch { /* session only */ }
  }

  #modelCacheKey(): string { return 'boite.models.v1:' + JSON.stringify([this.ctx.store.endpointUrl, this.ctx.store.core?.dataDir]); }
  saveModels(): void {
    const s = this.ctx.store;
    try { localStorage.setItem(this.#modelCacheKey(), JSON.stringify({ providers: s.providers, accounts: s.accounts, models: this.probedModels })); }
    catch { /* Storage unavailable: keep the in-memory cache. */ }
  }
  restoreModels(): void {
    const s = this.ctx.store;
    try {
      const cached = JSON.parse(localStorage.getItem(this.#modelCacheKey()) ?? 'null');
      if (!cached || JSON.stringify(cached.providers) !== JSON.stringify(s.providers) || JSON.stringify(cached.accounts) !== JSON.stringify(s.accounts)) return;
      const entries = Object.entries(cached.models ?? {}).filter(([, models]) => Array.isArray(models) && models.every(m => typeof m?.id === 'string' && typeof m?.name === 'string'));
      this.probedModels = { ...Object.fromEntries(entries) as Record<string, ModelInfo[]>, ...this.probedModels };
    } catch { /* A missing or malformed cache is read again from the agent. */ }
  }

  /**
   * The models to offer for this instance: the ones the agent listed when a
   * probe already ran, else the descriptor's.
   */
  modelsOf(providerId: ProviderId, accountId: string | null): ModelInfo[] {
    const probed = accountId ? this.probedModels[probeKey(providerId, accountId)] : undefined;
    if (probed) return probed;
    const provider = this.ctx.store.providerOf(providerId);
    const models = provider?.models ?? [];
    return provider?.protocol === 'claude-sdk' ? models.map(({ effort, speeds, ...model }) => model) : models;
  }

  /** The model a choice runs on, out of what its own instance offers: what the chips read. */
  modelOf(choice: Choice | null): ModelInfo | null {
    if (!choice) return null;
    const offered = this.ctx.store.modelsOf(choice.providerId, choice.accountId).find((m) => m.id === choice.model);
    if (offered) return offered;
    const preferred = this.modelDefaults[choice.providerId] ?? INITIAL_MODEL_DEFAULTS[choice.providerId];
    // Display the configured target before probing. It never joins modelsOf's selectable list.
    return choice.model && choice.model === preferred?.model
      ? { id: choice.model, name: DEFAULT_MODEL_NAMES[choice.model] ?? choice.model } : null;
  }

  /**
   * OpenCode names a model's reasoning efforts only once a session is on that
   * model, so the list a probe reads carries none. The composer asks for the
   * model it landed on, once per model, and the effort chip fills in.
   */
  async probeModelEffort(providerId: ProviderId, accountId: string, model: string): Promise<void> {
    const s = this.ctx.store;
    const client = this.ctx.client;
    if (!client || !s.owner) return;
    const key = `${probeKey(providerId, accountId)}::${model}`;
    if (this.effortAttempts.has(key)) return;
    await s.probeModels(providerId, accountId);
    const listed = s.modelsOf(providerId, accountId).find(entry => entry.id === model);
    if (!listed || listed.effort !== undefined || this.effortAttempts.has(key)) return;
    this.effortAttempts.add(key);
    const epoch = this.probeEpoch;
    try {
      const { models } = await client.call('providers.probe', { providerId, accountId, model });
      if (client !== this.ctx.client || epoch !== this.probeEpoch) return;
      this.probedModels = { ...this.probedModels, [probeKey(providerId, accountId)]: models };
      this.saveModels();
    } catch (error) {
      // An older core refuses nothing here, it just answers the plain list; a
      // real failure is the agent's, and the chip simply stays absent.
      if (client === this.ctx.client) this.effortAttempts.delete(key);
      console.warn('reading the model efforts failed', error);
    }
  }

  isProbing(providerId: ProviderId, accountId: string | null): boolean {
    return accountId !== null && this.probingModels.includes(probeKey(providerId, accountId));
  }

  /**
   * Ask the agent what it can run. Once per instance per session: the answer
   * stays until the core reloads its descriptors or the account changes.
   */
  probeModels(providerId: ProviderId, accountId: string, refresh = false): Promise<void> {
    const client = this.ctx.client;
    const key = probeKey(providerId, accountId);
    const existing = this.probeRequests.get(key);
    if (existing) return existing;
    if (!client || !this.ctx.store.owner || (!refresh && this.probeAttempts.has(key))) return Promise.resolve();
    this.probeAttempts.add(key);
    const epoch = this.probeEpoch;
    this.probingModels = [...this.probingModels, key];
    let request!: Promise<void>;
    request = (async () => {
      try {
        const { models } = await client.call('providers.probe', { providerId, accountId, ...(refresh ? { refresh: true } : {}) });
        if (client !== this.ctx.client || epoch !== this.probeEpoch) return;
        this.probedModels = { ...this.probedModels, [key]: models };
        this.saveModels();
      } catch (error) {
        if (client !== this.ctx.client) return;
        // The account or the descriptors changed while the agent answered: the
        // core refused a stale list, and the next look asks again.
        if (epoch !== this.probeEpoch) this.probeAttempts.delete(key);
        else this.ctx.fail(error);
      }
      finally {
        if (this.probeRequests.get(key) === request) {
          this.probeRequests.delete(key);
          this.probingModels = this.probingModels.filter(entry => entry !== key);
        }
      }
    })();
    this.probeRequests.set(key, request);
    return request;
  }

  defaultModelOf(provider: ProviderSummary, accountId?: string): string | null {
    const models = accountId ? this.ctx.store.modelsOf(provider.id, accountId) : provider.models;
    const preferred = this.modelDefaults[provider.id] ?? INITIAL_MODEL_DEFAULTS[provider.id];
    return preferred?.model ?? resolveModelDefault(provider.id, models, this.modelDefaults)?.model ?? null;
  }

  /** Replace old agent-selected aliases for the next prompt, preserving named choices. */
  composerChoice(choice: Choice): Choice {
    const s = this.ctx.store;
    const offered = s.modelOf(choice);
    if (choice.model && isNamedModel(offered ?? { id: choice.model, name: choice.model })) return choice;
    const provider = s.providerOf(choice.providerId);
    if (!provider) return choice;
    const model = s.defaultModelOf(provider, choice.accountId);
    return { ...choice, model, effort: s.defaultEffortOf(provider.id, choice.accountId, model), speed: null };
  }

  defaultEffortOf(providerId: string, accountId: string, model: string | null): string | null {
    const s = this.ctx.store;
    const offered = s.modelsOf(providerId, accountId);
    const configured = this.modelDefaults[providerId] ?? INITIAL_MODEL_DEFAULTS[providerId];
    if (configured?.model === model && (!offered.some((entry) => entry.id === model) ||
      (s.providerOf(providerId)?.protocol === 'claude-sdk' && !this.probedModels[probeKey(providerId, accountId)]))) return configured.effort;
    const preferred = resolveModelDefault(providerId, offered, this.modelDefaults);
    return preferred?.model === model ? preferred.effort : offered.find((m) => m.id === model)?.effort?.default ?? null;
  }

  setModelDefault(providerId: string, accountId: string, model: string, effort: string | null): void {
    const offered = this.ctx.store.modelsOf(providerId, accountId).find((m) => m.id === model);
    if (!offered || !isNamedModel(offered)) return;
    const validEffort = offered.effort?.levels.some((level) => level.id === effort) ? effort : offered.effort?.default ?? null;
    this.modelDefaults = { ...this.modelDefaults, [providerId]: { model, effort: validEffort } };
    writeModelDefaults(this.modelDefaults);
  }

  /**
   * What the composer opens on: the remembered provider and account when they
   * still exist, else the first available provider and its first account.
   */
  defaultChoice(): Choice | null {
    const s = this.ctx.store;
    if (s.draft && this.draftChoice) return this.draftChoice;
    const remembered = this.prefs.providerId ? s.providerOf(this.prefs.providerId) : null;
    const provider =
      (remembered?.available ? remembered : null) ??
      s.providers.find((p) => p.available && s.accountsOf(p.id).length > 0) ??
      s.providers.find((p) => s.accountsOf(p.id).length > 0) ??
      null;
    if (!provider) return null;
    const accounts = s.accountsOf(provider.id);
    const account =
      accounts.find((a) => a.id === this.prefs.accountId) ??
      accounts.find((a) => a.status === 'ok') ??
      accounts[0];
    if (!account) return null;
    const model = s.defaultModelOf(provider, account.id);
    const effort = s.defaultEffortOf(provider.id, account.id, model);
    return {
      providerId: provider.id,
      accountId: account.id,
      permissionMode: this.prefs.permissionMode,
      model,
      effort,
      speed: s.modelsOf(provider.id, account.id).find(m => m.id === model)?.speeds?.some(option => option.id === this.prefs.speed) ? this.prefs.speed : null
    };
  }

  /**
   * The composer moves to this provider's signed-in account, the way a pick in
   * the model picker would: the one just connected when it is named and signed
   * in, else the first signed in. False when it has none yet.
   */
  useProvider(providerId: ProviderId, accountId: string | null = null): boolean {
    const s = this.ctx.store;
    const provider = s.providerOf(providerId);
    const signedIn = s.accountsOf(providerId).filter((a) => a.status === 'ok');
    const account = signedIn.find((a) => a.id === accountId) ?? signedIn[0];
    if (!provider || !provider.available || !account) return false;
    const model = s.defaultModelOf(provider, account.id);
    s.remember({
      providerId,
      accountId: account.id,
      permissionMode: this.prefs.permissionMode,
      model,
      effort: s.defaultEffortOf(providerId, account.id, model),
      speed: null
    });
    return true;
  }

  /**
   * The tour's question: the preset lands in the device's settings, the
   * everyday answer asks before each action, and a draft still empty on
   * screen moves to where this answer starts.
   */
  applyProfile(profile: Profile): void {
    const s = this.ctx.store;
    work.choose(profile);
    if (profile === 'everyday' && this.prefs.permissionMode !== 'default') {
      this.prefs = { ...this.prefs, permissionMode: 'default' };
      writePrefs(this.prefs);
      if (this.draftChoice) this.draftChoice = { ...this.draftChoice, permissionMode: 'default' };
    }
    if (s.draft && !s.openThread) s.setDraftProject(profile === 'everyday' ? null : s.lastProject());
  }

  remember(choice: Choice): void {
    if (this.ctx.store.draft) this.draftChoice = { ...choice };
    this.prefs = { ...choice };
    writePrefs(this.prefs);
  }

  /**
   * The composer's one action. On a draft it creates the thread first, titled
   * from the prompt; on an open thread it starts a turn. An image alone is a
   * turn too, so an empty prompt with an attachment goes out.
   */
  async prepareDraftChoice(choice: Choice): Promise<Choice | null> {
    const s = this.ctx.store;
    const provider = s.providerOf(choice.providerId);
    if (!choice.model || !provider) return choice;
    const models = s.modelsOf(choice.providerId, choice.accountId);
    if ((!models.some((model) => model.id === choice.model) ||
      (provider.protocol === 'claude-sdk' && !this.probedModels[probeKey(provider.id, choice.accountId)])) &&
      ['claude-sdk', 'acp', 'codex-appserver', 'muse', 'pi', 'agy'].includes(provider.protocol)) {
      const client = this.ctx.client;
      if (!client) return null;
      try {
        const result = await client.call('providers.probe', { providerId: choice.providerId, accountId: choice.accountId });
        this.probedModels = { ...this.probedModels, [probeKey(choice.providerId, choice.accountId)]: result.models };
      } catch (error) { this.ctx.fail(error); return null; }
    }
    if (!s.modelsOf(provider.id, choice.accountId).some((model) => model.id === choice.model)) {
      s.error = strings.settings.modelDefaultUnavailable.replace('{model}', choice.model).replace('{provider}', provider.name);
      return null;
    }
    return choice;
  }

  /** What was probed for one account, dropped: the account itself changed. */
  dropProbes(accountId: string): void {
    this.probeEpoch++;
    for (const key of this.probeAttempts) if (key.endsWith(`::${accountId}`)) this.probeAttempts.delete(key);
    const suffix = `::${accountId}`;
    const kept = Object.entries(this.probedModels).filter(([key]) => !key.endsWith(suffix));
    if (kept.length !== Object.keys(this.probedModels).length) {
      this.probedModels = Object.fromEntries(kept);
      this.saveModels();
    }
  }
}
