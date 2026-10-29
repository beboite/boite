import { nativeModelId, type ModelFavorites, type ModelInfo, type ProviderId, type ProviderSummary } from '@boite/contracts';
import { BUILT_IN_MODELS, DEFAULT_MODEL_NAMES, INITIAL_MODEL_DEFAULTS, writeModelDefaults, resolveModelDefault, fallbackModelDefault, type ModelDefault, type ModelDefaults } from '../model-defaults';
import { isNamedModel } from '../model-order';
import { modelFavorites, resolveFavorites, type FavoritesTarget, type ResolvedFavorite } from '../model-favorites.svelte';
import { defaultPrefs, writePrefs, type ComposerPrefs } from '../prefs';
import { strings } from '../strings';
import { work, type Profile } from '../work-prefs.svelte';
import type { Choice } from '../store.svelte';
import type { StoreContext } from './context';

/** One probe answer per provider and account, the key the core uses too. */
export function probeKey(providerId: ProviderId, accountId: string): string {
  return `${providerId}::${accountId}`;
}

const MODEL_CATALOG_MAX_AGE_MS = 5 * 60_000;
/** A burst of probes writes the model cache once, this long after the first of them. */
export const MODEL_CACHE_WRITE_MS = 1_000;

/**
 * True when `live` would serialize to the JSON `stored` was parsed from: an
 * undefined field or a function is absent, an undefined array entry is null.
 * The order of keys does not matter. It stops at the first difference and
 * builds no string, where comparing two `JSON.stringify` results serialized
 * every provider and account on each accounts list.
 */
export function sameJson(live: unknown, stored: unknown): boolean {
  if (live === stored) return true;
  if (live === undefined) return stored === null;
  if (typeof live !== 'object' || live === null || typeof stored !== 'object' || stored === null) return false;
  if (Array.isArray(live)) {
    if (!Array.isArray(stored) || live.length !== stored.length) return false;
    for (let index = 0; index < live.length; index++) if (!sameJson(live[index] ?? null, stored[index])) return false;
    return true;
  }
  if (Array.isArray(stored)) return false;
  const values = stored as Record<string, unknown>;
  let count = 0;
  for (const [key, value] of Object.entries(live)) {
    if (value === undefined || typeof value === 'function') continue;
    count++;
    if (!Object.hasOwn(values, key) || !sameJson(value, values[key])) return false;
  }
  return count === Object.keys(values).length;
}

/**
 * What the composer runs on: the remembered choice, the per-provider model
 * defaults, the favorites, and what each agent answered `providers.probe` with.
 */
export class Models {
  prefs = $state<ComposerPrefs>(defaultPrefs());
  modelDefaults = $state<ModelDefaults>({});
  draftChoice = $state<Choice | null>(null);
  /** The shared favorites as this machine offers them (`lib/model-favorites.svelte.ts`). */
  favorites = $derived.by((): ResolvedFavorite[] => resolveFavorites(modelFavorites.current.items, this.ctx.store));
  /**
   * What an agent answered `providers.probe` with, keyed `providerId::accountId`.
   * An ACP agent owns its model list; the descriptor only carries `default`.
   * One entry per provider and account the picker has opened this session, which
   * is what bounds it: the pairs exist on the machine, they do not arrive with
   * time, and an account that changes drops its own key.
   */
  probedModels = $state<Record<string, ModelInfo[]>>({});
  probeAttempts = new Set<string>();
  /**
   * The keys whose list came from the connected core itself, by a probe answer
   * or its `providers.probed` event. The core accepts a model from such a list
   * without being asked again; a list restored from storage is not one of them.
   */
  confirmed = new Set<string>();
  probeTimes = new Map<string, number>();
  /** One per-model effort read per provider, account and model, see `probeModelEffort`. */
  effortAttempts = new Set<string>();
  probeRequests = new Map<string, { request: Promise<void>; reportFailure: boolean; error?: unknown }>();
  probeEpoch = 0;
  /** The keys a probe is running for, so the picker can say it is reading. */
  probingModels = $state<string[]>([]);

  constructor(private readonly ctx: StoreContext) {}

  /**
   * Stars or unstars a model of this machine's account, for every machine. The
   * star names the account by label; unstarring removes every shared favorite
   * this row stands for. A paired device reads the favorites and never writes them.
   */
  toggleFavorite(providerId: string, accountId: string, model: ModelInfo): void {
    if (!this.ctx.store.owner) return;
    const shown = this.favorites.find((f) => f.providerId === providerId && f.accountId === accountId && f.model.id === model.id);
    if (shown) { modelFavorites.toggle(null, shown.items); return; }
    const label = this.ctx.store.accountOf(accountId)?.label;
    modelFavorites.toggle({ providerId, model: { id: model.id, name: model.name }, ...(label ? { account: label } : {}) });
  }

  /** This machine as the shared favorites reach it; registered while a client is attached. */
  readonly favoritesTarget: FavoritesTarget = {
    settings: () => this.ctx.store.settings,
    writable: () => this.ctx.store.principal === 'owner' && this.ctx.client?.state === 'ready',
    write: async (favorites: ModelFavorites) => {
      const client = this.ctx.client;
      if (!client) return;
      const settings = await client.call('settings.set', { modelFavorites: favorites });
      if (client === this.ctx.client) this.ctx.store.settings = settings;
    },
    accountsReady: () => this.ctx.store.accounts.length > 0,
    accountLabel: (accountId, providerId) => {
      const account = this.ctx.store.accountOf(accountId);
      return account?.providerId === providerId ? account.label : null;
    },
  };

  /** This machine's settings or accounts changed: the shared favorites compare with its copy. */
  syncFavorites(): void {
    modelFavorites.sync(this.favoritesTarget);
  }

  #modelCacheKey(): string { return 'boite.models.v1:' + JSON.stringify([this.ctx.store.endpointUrl, this.ctx.store.core?.dataDir]); }
  #saveTimer: ReturnType<typeof setTimeout> | null = null;
  #saveKey = '';
  /**
   * The lists the held write's models were probed under, and their JSON: read
   * at the flush, they could already say what a later `accounts.list` wrote
   * into the same rows (`retainRows`).
   */
  #saveLists: { providers: unknown; accounts: unknown; json: string } | null = null;
  #onPageHide: (() => void) | null = null;

  /**
   * Writes the probed models to `localStorage` at most once a
   * `MODEL_CACHE_WRITE_MS`, the state at the end of the burst; leaving the
   * page or detaching the store writes what waits at once. Every probe used to serialize providers,
   * accounts and all the lists on the main thread. The write carries the
   * providers and accounts of the moment it was asked for, not of the flush.
   */
  saveModels(): void {
    const key = this.#modelCacheKey();
    const { providers, accounts } = this.ctx.store;
    const changed = key !== this.#saveKey || providers !== this.#saveLists?.providers || accounts !== this.#saveLists?.accounts;
    // Another machine's cache, or models probed under other lists, is written before this one waits.
    if (this.#saveTimer !== null && changed) this.flushModels();
    this.#saveKey = key;
    if (this.#saveLists === null || changed) {
      this.#saveLists = { providers, accounts, json: `"providers":${JSON.stringify(providers)},"accounts":${JSON.stringify(accounts)}` };
    }
    if (this.#saveTimer !== null) return;
    this.#saveTimer = setTimeout(() => this.flushModels(), MODEL_CACHE_WRITE_MS);
    if (this.#onPageHide === null && typeof window !== 'undefined') {
      this.#onPageHide = this.#flush;
      window.addEventListener('pagehide', this.#onPageHide);
    }
  }

  #flush = () => this.flushModels();

  /** The write `saveModels` holds, now. */
  flushModels(): void {
    if (this.#saveTimer === null) return;
    clearTimeout(this.#saveTimer);
    this.#saveTimer = null;
    if (this.#onPageHide !== null) {
      window.removeEventListener('pagehide', this.#onPageHide);
      this.#onPageHide = null;
    }
    const lists = this.#saveLists;
    this.#saveLists = null;
    if (lists === null) return;
    try { localStorage.setItem(this.#saveKey, `{${lists.json},"models":${JSON.stringify(this.probedModels)}}`); }
    catch { /* Storage unavailable: keep the in-memory cache. */ }
  }

  restoreModels(): void {
    const s = this.ctx.store;
    const key = this.#modelCacheKey();
    // A write still held is what the cache holds now.
    this.flushModels();
    try {
      const cached = JSON.parse(localStorage.getItem(key) ?? 'null');
      if (!cached || !sameJson(s.providers, cached.providers ?? null) || !sameJson(s.accounts, cached.accounts ?? null)) return;
      const entries = Object.entries(cached.models ?? {}).filter(([, models]) => Array.isArray(models) && models.every(m => typeof m?.id === 'string' && typeof m?.name === 'string'));
      this.probedModels = { ...Object.fromEntries(entries) as Record<string, ModelInfo[]>, ...this.probedModels };
    } catch { /* A missing or malformed cache is read again from the agent. */ }
  }

  /**
   * The models to offer for this instance: the ones the agent listed when a
   * probe already ran. Claude has no descriptor catalog to fall back to.
   */
  modelsOf(providerId: ProviderId, accountId: string | null): ModelInfo[] {
    const probed = accountId ? this.probedModels[probeKey(providerId, accountId)] : undefined;
    if (probed) return probed;
    const provider = this.ctx.store.providerOf(providerId);
    return provider?.protocol === 'claude-sdk' ? [] : provider?.models ?? [];
  }

  /** The model a choice runs on, out of what its own instance offers: what the chips read. */
  modelOf(choice: Choice | null): ModelInfo | null {
    if (!choice) return null;
    const models = this.ctx.store.modelsOf(choice.providerId, choice.accountId);
    const offered = choice.model ? models.find((m) => m.id === this.#listedAs(choice.model!, models)) : undefined;
    if (offered) return offered;
    const preferred = this.#configured(choice.providerId, choice.accountId) ?? INITIAL_MODEL_DEFAULTS[choice.providerId];
    // Display the configured target before probing, with the built-in effort
    // scale when it is the built-in model. It never joins modelsOf's selectable list.
    if (!choice.model || choice.model !== preferred?.model) return null;
    const builtIn = BUILT_IN_MODELS[choice.providerId];
    return builtIn?.id === nativeModelId(choice.model) ? builtIn : { id: choice.model, name: DEFAULT_MODEL_NAMES[choice.model] ?? choice.model };
  }

  /**
   * The id `models` gives `model`, or null when it is not listed. A gateway
   * route named after the vendor (`claude/claude-opus-5-5`) is the same model
   * as the native id the core lists in its place since it stopped listing both.
   */
  #listedAs(model: string, models: readonly ModelInfo[]): string | null {
    if (models.some((m) => m.id === model)) return model;
    const native = nativeModelId(model);
    return models.find((m) => nativeModelId(m.id) === native)?.id ?? null;
  }

  /** The configured default, under the id this account's catalog lists it as. */
  #configured(providerId: string, accountId?: string | null): ModelDefault | undefined {
    const configured = this.modelDefaults[providerId];
    if (!configured || !accountId) return configured;
    const listed = this.#listedAs(configured.model, this.ctx.store.modelsOf(providerId, accountId));
    return listed && listed !== configured.model ? { ...configured, model: listed } : configured;
  }

  /**
   * OpenCode names a model's reasoning efforts only once a session is on that
   * model, so the list a probe reads carries none. The composer asks for the
   * model it landed on, once per model, and the effort chip fills in.
   */
  async probeModelEffort(providerId: ProviderId, accountId: string, model: string): Promise<void> {
    const s = this.ctx.store;
    const client = this.ctx.client;
    if (!client) return;
    const key = `${probeKey(providerId, accountId)}::${model}`;
    const held = this.probeRequests.get(key);
    if (held) return held.request;
    if (this.effortAttempts.has(key)) return;
    const epoch = this.probeEpoch;
    const pending = { request: Promise.resolve(), reportFailure: false };
    pending.request = (async () => {
      await s.probeModels(providerId, accountId);
      if (client !== this.ctx.client || epoch !== this.probeEpoch) return;
      const listed = s.modelsOf(providerId, accountId).find(entry => entry.id === model);
      if (!listed || listed.effort !== undefined || this.effortAttempts.has(key)) return;
      this.effortAttempts.add(key);
      try {
        const { models } = await client.call('providers.probe', { providerId, accountId, model });
        if (client !== this.ctx.client || epoch !== this.probeEpoch) return;
        this.probedModels = { ...this.probedModels, [probeKey(providerId, accountId)]: models };
        this.confirmed.add(probeKey(providerId, accountId));
        this.saveModels();
      } catch (error) {
        if (client === this.ctx.client) this.effortAttempts.delete(key);
        console.warn('reading the model efforts failed', error);
      }
    })().finally(() => { if (this.probeRequests.get(key) === pending) this.probeRequests.delete(key); });
    this.probeRequests.set(key, pending);
    return pending.request;
  }

  /**
   * The core already listed this model for this account: a pick can land at
   * once, and a refresh running behind it keeps that list until it answers.
   */
  catalogHas(providerId: ProviderId, accountId: string, model: string): boolean {
    const key = probeKey(providerId, accountId);
    return this.confirmed.has(key) && (this.probedModels[key]?.some((entry) => entry.id === model) ?? false);
  }

  /** Every list the client holds came from another connection or a reloaded core. */
  forgetConfirmed(): void {
    this.confirmed.clear();
  }

  isProbing(providerId: ProviderId, accountId: string | null): boolean {
    return accountId !== null && this.probingModels.includes(probeKey(providerId, accountId));
  }

  /**
   * The first probe of this instance is running and nothing, live or cached,
   * has answered yet: the picker shows it reading instead of the descriptor's
   * list. A failed probe leaves no selectable Claude placeholders.
   */
  modelsPending(providerId: ProviderId, accountId: string | null): boolean {
    return accountId !== null && !this.probedModels[probeKey(providerId, accountId)] && this.isProbing(providerId, accountId);
  }

  /**
   * Ask the agent what it can run. Reopening after five minutes forces a fresh
   * catalog; cached rows stay visible while it reads, including after a failure.
   */
  probeModels(providerId: ProviderId, accountId: string, refresh = false, options: { validate?: boolean; model?: string } = {}): Promise<void> {
    const client = this.ctx.client;
    const key = probeKey(providerId, accountId);
    const existing = this.probeRequests.get(key);
    if (existing) {
      // A refresh can join automatic discovery while its agent is still answering.
      if (refresh) existing.reportFailure = true;
      return options.validate ? existing.request.then(() => { if (existing.error !== undefined) throw existing.error; }) : existing.request;
    }
    const attempted = this.probeAttempts.has(key);
    const stale = attempted && Date.now() - (this.probeTimes.get(key) ?? 0) >= MODEL_CATALOG_MAX_AGE_MS;
    if (!client || (!refresh && attempted && !stale && !(options.validate && !this.confirmed.has(key)))) return Promise.resolve();
    const account = this.ctx.store.accountOf(accountId);
    if (!refresh && (account?.status === 'unauthenticated' || account?.status === 'error')) return Promise.resolve();
    this.probeAttempts.add(key);
    this.probeTimes.set(key, Date.now());
    const force = refresh || (!options.validate && (stale || (!attempted && this.probedModels[key] !== undefined)));
    const epoch = this.probeEpoch;
    this.probingModels = [...this.probingModels, key];
    const pending: { request: Promise<void>; reportFailure: boolean; error?: unknown } = { request: Promise.resolve(), reportFailure: refresh };
    pending.request = (async () => {
      try {
        const { models } = await client.call('providers.probe', { providerId, accountId, ...(force ? { refresh: true } : {}), ...(options.model ? { model: options.model } : {}) });
        if (client !== this.ctx.client || epoch !== this.probeEpoch) return;
        this.probedModels = { ...this.probedModels, [key]: models };
        this.confirmed.add(key);
        this.saveModels();
      } catch (error) {
        pending.error = error;
        if (client !== this.ctx.client) return;
        // The account or the descriptors changed while the agent answered: the
        // core refused a stale list, and the next look asks again.
        if (epoch !== this.probeEpoch) this.probeAttempts.delete(key);
        else if (pending.reportFailure) this.ctx.fail(error);
        // Discovery also runs when the composer mounts, before any user action.
        // An agent may still need a login even when its descriptor has no auth check.
        else console.warn('background model discovery failed', error);
      }
      finally {
        if (this.probeRequests.get(key) === pending) {
          this.probeRequests.delete(key);
          this.probingModels = this.probingModels.filter(entry => entry !== key);
        }
      }
    })();
    this.probeRequests.set(key, pending);
    return options.validate ? pending.request.then(() => { if (pending.error !== undefined) throw pending.error; }) : pending.request;
  }

  defaultModelOf(provider: ProviderSummary, accountId?: string): string | null {
    const models = accountId ? this.ctx.store.modelsOf(provider.id, accountId) : provider.models;
    const configured = this.#configured(provider.id, accountId);
    if (configured) return configured.model;
    // The built-in default is a preference: once the account's own catalog is
    // read and does not list it, the catalog decides.
    if (accountId && this.probedModels[probeKey(provider.id, accountId)]) {
      const fallback = fallbackModelDefault(provider.id, models);
      if (fallback) return fallback.model;
    }
    return INITIAL_MODEL_DEFAULTS[provider.id]?.model ?? resolveModelDefault(provider.id, models, this.modelDefaults)?.model ?? null;
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
    const own = this.#configured(providerId, accountId);
    const configured = own ?? INITIAL_MODEL_DEFAULTS[providerId];
    if (configured?.model === model && (!offered.some((entry) => entry.id === model) ||
      (s.providerOf(providerId)?.protocol === 'claude-sdk' && !this.probedModels[probeKey(providerId, accountId)]))) return configured.effort;
    const preferred = own
      ? resolveModelDefault(providerId, offered, { ...this.modelDefaults, [providerId]: own }) : fallbackModelDefault(providerId, offered);
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
    // A provider turned off since the draft or the last send is never what a new prompt opens on.
    if (s.draft && this.draftChoice && s.providerOn(this.draftChoice.providerId)) return this.#offered(this.draftChoice);
    const remembered = this.prefs.providerId && s.providerOn(this.prefs.providerId) ? s.providerOf(this.prefs.providerId) : null;
    const offered = s.offeredProviders;
    const provider =
      (remembered?.available ? remembered : null) ??
      offered.find((p) => p.available && s.accountsOf(p.id).length > 0) ??
      offered.find((p) => s.accountsOf(p.id).length > 0) ??
      null;
    if (!provider) return null;
    // The remembered account while it can run, else one that can, else any to sign in again.
    const account = s.usableAccountOf(provider.id, this.prefs.accountId) ?? s.accountsOf(provider.id)[0];
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
    if (!provider || !provider.available || !s.providerOn(providerId) || !account) return false;
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
   * A choice still on the built-in default, moved to what the account's
   * catalog lists once it is read. The composer shows the model the send will
   * use. A default the user configured, or any other model, comes back as is.
   */
  #offered(choice: Choice, catalog?: ModelInfo[]): Choice {
    // A choice saved under a vendor's route is that same model under the id the catalog lists.
    const listed = choice.model ? this.#listedAs(choice.model, catalog ?? this.ctx.store.modelsOf(choice.providerId, choice.accountId)) : null;
    if (listed && listed !== choice.model) return { ...choice, model: listed };
    if (this.modelDefaults[choice.providerId] || choice.model !== INITIAL_MODEL_DEFAULTS[choice.providerId]?.model) return choice;
    const offered = catalog ?? this.probedModels[probeKey(choice.providerId, choice.accountId)];
    if (!offered || offered.some((model) => model.id === choice.model)) return choice;
    const fallback = fallbackModelDefault(choice.providerId, offered);
    return fallback ? { ...choice, model: fallback.model, effort: fallback.effort, speed: null } : choice;
  }

  /** Validate a draft's choice against the owning core before creating its thread. */
  async prepareDraftChoice(choice: Choice, options: { background?: boolean } = {}): Promise<Choice | null> {
    const s = this.ctx.store;
    const provider = s.providerOf(choice.providerId);
    if (!choice.model || !provider) return choice;
    // The core listed this model on this connection: it accepts it without a
    // second read, which would wait behind a refresh still running.
    const known = this.catalogHas(choice.providerId, choice.accountId, choice.model) &&
      (provider.protocol !== 'acp' || choice.effort === null || s.modelsOf(provider.id, choice.accountId).find((m) => m.id === choice.model)?.effort !== undefined);
    if (!known && ['claude-sdk', 'acp', 'codex-appserver', 'muse', 'pi'].includes(provider.protocol)) {
      const client = this.ctx.client;
      if (!client) return null;
      const epoch = this.probeEpoch;
      try {
        // Join the composer's discovery request; typing and Send must not
        // launch a second catalog read while the first one is pending.
        await this.probeModels(choice.providerId, choice.accountId, false, { validate: true,
          ...(provider.protocol === 'acp' && choice.effort !== null ? { model: choice.model } : {}) });
        if (client !== this.ctx.client || epoch !== this.probeEpoch) return null;
        if (provider.protocol === 'acp' && choice.effort !== null) {
          await s.probeModelEffort(choice.providerId, choice.accountId, choice.model);
          if (client !== this.ctx.client || epoch !== this.probeEpoch) return null;
        }

      } catch (error) {
        const current = client === this.ctx.client && epoch === this.probeEpoch;
        // An effort probe can fail for a model the catalog already lists. The
        // draft still starts. Any other probe failure still stops it.
        const known = s.modelsOf(provider.id, choice.accountId).some((model) => model.id === choice.model);
        if (current && provider.protocol === 'acp' && choice.effort !== null && known) return choice;
        if (current && !options.background) this.ctx.fail(error);
        return null;
      }
    }
    const offered = s.modelsOf(provider.id, choice.accountId);
    if (!offered.some((model) => model.id === choice.model)) {
      // Only the built-in default moves to what the account offers. A default
      // the user configured, or a model he picked, is refused instead.
      const moved = this.#offered(choice, offered);
      if (moved !== choice) return moved;
      if (!options.background) s.error = strings.settings.modelDefaultUnavailable.replace('{model}', choice.model).replace('{provider}', provider.name);
      return null;
    }
    return choice;
  }

  /** What was probed for one account, dropped: the account itself changed. */
  dropProbes(accountId: string): void {
    this.probeEpoch++;
    for (const key of this.probeAttempts) if (key.endsWith(`::${accountId}`)) this.probeAttempts.delete(key);
    for (const key of this.confirmed) if (key.endsWith(`::${accountId}`)) this.confirmed.delete(key);
    for (const key of this.probeTimes.keys()) if (key.endsWith(`::${accountId}`)) this.probeTimes.delete(key);
    const suffix = `::${accountId}`;
    const kept = Object.entries(this.probedModels).filter(([key]) => !key.endsWith(suffix));
    if (kept.length !== Object.keys(this.probedModels).length) {
      this.probedModels = Object.fromEntries(kept);
      this.saveModels();
    }
  }
}
