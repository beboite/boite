/**
 * The session's model, effort and permission mode: what the agent last said
 * it offers and is on, and the calls that move it to the thread's values.
 */
import type {
  ClientContext,
  SessionConfigOption,
  SessionConfigOptionCategory,
  SessionMode,
  SessionModeState,
} from '@agentclientprotocol/sdk';
import type { ModelInfo, PermissionMode } from '@boite/contracts';
import { messageOf } from '../../errors.ts';
import { PROXY_PREFIX_ENV } from '../../subscription-proxy.ts';
import { grokReasoningEffortOf } from '../grok.ts';
import type { SessionContext } from '../types.ts';
import { AGENT_OWN_MODEL, agentModelsOf, categoryOption, modelsFrom, selectValues, type AgentModels } from './models.ts';
import { isGrok } from './protocol.ts';

/**
 * The thread's permission mode as candidate `session/set_mode` ids, best first.
 * ACP standardises the call and the shape of `availableModes`, never the ids
 * inside it: every agent names its own modes. So each Boite mode carries the
 * spellings agents are known to use and the first one an agent lists wins.
 * `matchMode` compares without case, `_` or `-`, so the two spellings of a name
 * are one key; both are written out anyway, because the list is also what tells
 * a reader which agent uses which.
 *
 * - `default`, `auto_edit` and `yolo` are Antigravity's three session modes,
 *   which is what the mapping was written against; it has no plan mode.
 * - `acceptEdits`, `bypassPermissions`, `plan`, `default` are Claude Code's
 *   permission modes, which its ACP bridge hands over as mode ids.
 * - `accept_edits`, `bypass_permissions`, `auto_edit`, `dont_ask` are the
 *   snake_case spelling of those same names.
 * - `build` is what OpenCode calls its plain mode, `normal` what several
 *   smaller agents call theirs. OpenCode lists `build` and `plan` as a config
 *   option of category `mode`, with no `availableModes` at all: the same
 *   candidates are matched against that option's values (`applyModeOption`).
 * - `auto` is the short name for a mode that approves everything.
 *
 * Every mode but `plan` ends on the agent's plain mode. An agent that only
 * knows `build` and `plan` has nothing closer to "edit freely", and a thread
 * that leaves `plan` for a mode the agent does not list must not stay in
 * `plan`: the plain mode is where the agent works, and whatever it still asks
 * arrives as a permission request the thread's mode answers.
 */
const PLAIN_MODES = ['default', 'build', 'normal'] as const;
const MODE_CANDIDATES: Record<PermissionMode, readonly string[]> = {
  default: PLAIN_MODES,
  acceptEdits: ['acceptEdits', 'accept_edits', 'autoEdit', 'auto_edit', ...PLAIN_MODES],
  bypassPermissions: ['bypassPermissions', 'bypass_permissions', 'yolo', 'auto', ...PLAIN_MODES],
  yolo: ['yolo', 'bypassPermissions', 'bypass_permissions', 'auto', ...PLAIN_MODES],
  plan: ['plan'],
  dontAsk: ['dontAsk', 'dont_ask', 'bypassPermissions', 'bypass_permissions', 'yolo', 'auto', ...PLAIN_MODES],
};

/** How long to wait before each new try of a model the agent takes without listing it: 3.25 s in all. */
const INJECTED_MODEL_RETRY_MS: readonly number[] = [250, 500, 1000, 1500];
/** The effort value OpenCode 2 lists beside its levels for "the model's own". */
const AGENT_DEFAULT_EFFORT = 'default';

/** Mode ids are spelled every way there is: match without case, `_` or `-`. */
function normalizeModeId(id: string): string {
  return id.toLowerCase().replace(/[_-]/g, '');
}

/** The agent's own id for a Boite permission mode, or null when it offers none. */
function matchMode(wanted: PermissionMode, modes: SessionMode[]): string | null {
  const offered = new Map<string, string>();
  for (const mode of modes) {
    const key = normalizeModeId(mode.id);
    // The agent's order decides: the first spelling it lists is the one sent.
    if (!offered.has(key)) offered.set(key, mode.id);
  }
  for (const candidate of MODE_CANDIDATES[wanted]) {
    const found = offered.get(normalizeModeId(candidate));
    if (found !== undefined) return found;
  }
  return null;
}

/** The live connection and session the calls go out on, read at each call: null once the process is gone. */
export interface ControlTarget {
  agent: ClientContext | null;
  sessionId: string | null;
}

/**
 * What one ACP session was told and last reported about its model, its effort
 * and its mode. It sends only what moved, on the session `target` names.
 */
export class SessionControls {
  private configWarned = false;
  /** What the last session answer, or the last `set_config_option`, listed. */
  private configOptions: SessionConfigOption[] = [];
  /** What the last session answer said about models, for the agents that list them. */
  private agentModels: AgentModels | null = null;
  /**
   * The model and the effort as they last went out, whichever call carried
   * them. `undefined` is "nothing sent yet", which is not the same as a thread
   * that asks for none. They are not in the session key: a turn that moved one
   * of them sends it on the live session instead of dropping the process.
   */
  private appliedModel: string | null | undefined = undefined;
  private appliedEffort: string | null | undefined = undefined;
  /**
   * The model the agent opened its first new session on: what "the agent's own
   * model" is when a thread goes back to it on a session that was moved off it.
   */
  private ownModel: string | null = null;
  /**
   * The same for an agent that lists its models in the session answer: the
   * `currentModelId` of a `session/new`, or the account's probed default. A
   * loaded session reports the model it was left on, which is not the agent's own.
   */
  private ownListedModel: string | null = null;
  /**
   * Whether `ownListedModel` was read at all: null once read is an agent that
   * lists no models, null before is a question a throwaway session answers.
   */
  private ownListedModelRead = false;
  /**
   * The options came from this session's own answers, not from another
   * session's seed: only then does a current value say what this one is on.
   */
  private ownOptions = false;
  /** Values this process refused, by category: asked again, they cost the same wait and the same warning. */
  private readonly refused = new Set<string>();
  /** What the last `session/new` or `session/load` said the agent can be in. */
  private modes: SessionMode[] = [];
  /** The mode the agent is in, as it last told us: an answer or a drift it announced. */
  private currentModeId: string | null = null;
  private modeWarned = false;

  constructor(private readonly target: () => ControlTarget) {}

  seed(options: SessionConfigOption[]): void {
    if (this.configOptions.length === 0) this.configOptions = structuredClone(options);
    this.noteOwnModel(options);
  }

  /**
   * What a fresh `session/new` of the account said the agent's own model is,
   * for a process whose first session is a load; `undefined` when nothing read it.
   */
  seedOwnListedModel(modelId: string | null | undefined): void {
    if (this.ownListedModelRead || modelId === undefined) return;
    this.ownListedModel = modelId;
    this.ownListedModelRead = true;
  }

  /**
   * The models a throwaway session listed, for a loaded session that listed
   * none: which one the loaded session is on stays unknown.
   */
  seedListedModels(listed: AgentModels | null): void {
    if (this.agentModels === null && listed !== null) this.agentModels = { currentModelId: null, available: listed.available };
  }

  knowsOwnListedModel(): boolean {
    return this.ownListedModelRead;
  }

  /** The model option's value in a `session/new` answer, the first one kept. */
  noteOwnModel(options: SessionConfigOption[] | null): void {
    if (this.ownModel !== null) return;
    const option = categoryOption(options, 'model');
    if (option?.type === 'select' && typeof option.currentValue === 'string' && option.currentValue.length > 0) this.ownModel = option.currentValue;
  }

  catalog(ctx: SessionContext): ModelInfo[] | null {
    if (categoryOption(this.configOptions, 'model') === null && this.agentModels === null) return null;
    return modelsFrom(ctx.provider, this.configOptions, this.agentModels);
  }

  hasOptions(): boolean {
    return this.configOptions.length > 0;
  }

  /** An agent that takes its model as a config option, which `applyConfig` sets. */
  hasModelOption(): boolean {
    return categoryOption(this.configOptions, 'model') !== null;
  }

  /** The session answers listed models, which is where an agent with no model option takes them. */
  hasModels(): boolean {
    return this.agentModels !== null;
  }

  /**
   * `config_option_update`: the options as the agent says they now stand.
   * Mode and model values are taken from it, for an agent whose modes are a config
   * option and that left one on its own: without it the kept value would still
   * say `plan`, nothing would be sent, and the next turn would run in the
   * agent's mode instead of the thread's. A changed model invalidates the
   * previous admission before the next protected prompt.
   */
  noteOptionUpdate(options: SessionConfigOption[]): void {
    this.configOptions = this.configOptions.map(entry => {
      if (entry.category !== 'mode' && entry.category !== 'model') return entry;
      return options.find(option => option.id === entry.id && option.category === entry.category) ?? entry;
    });
  }

  /** `current_mode_update`: a mode change the agent announced on its own. */
  noteMode(modeId: string): void {
    this.currentModeId = modeId;
  }

  /**
   * What a `session/new` or `session/load` said about itself: the modes, the
   * config options and the models. Nothing is sent from here; the turn that
   * follows applies the thread's own values, which is the one place a loaded
   * session and a warm one are treated alike.
   */
  noteSession(
    modes: SessionModeState | null | undefined,
    options: SessionConfigOption[] | null,
    answer: unknown,
    fresh: boolean,
  ): void {
    this.noteModes(modes);
    if (options !== null && options.length > 0) {
      this.configOptions = options;
      this.ownOptions = true;
    }
    const listed = agentModelsOf(answer);
    if (listed !== null) this.agentModels = listed;
    if (fresh) {
      this.ownListedModel = listed?.currentModelId ?? null;
      this.ownListedModelRead = true;
    }
  }

  /**
   * The thread's model as one `session/set_model`, for the agents that take it
   * there rather than through `session/set_config_option`: Grok, with its
   * reasoning effort in `_meta`, and any agent whose session answer lists
   * `models` but no `model` config option (Hermes Agent), which takes the model
   * alone. It runs at the start of every turn and sends nothing when the
   * model has not moved since the last one, so a warm session follows a
   * change instead of being dropped for it. A thread on the agent's own model
   * with no effort set says nothing, unless an earlier turn moved the session
   * off it, and neither does one the session answer already reports as
   * current. A refusal is one warning: the turn runs on whatever the agent is
   * already on.
   */
  async applyModel(ctx: SessionContext): Promise<void> {
    const grok = isGrok(ctx.provider);
    // An agent with a `model` option takes it in `applyConfig`, and one that
    // lists no models has nothing to match the thread's model against. A load
    // may omit the list: a known own model still says the agent has one.
    if (!grok && ((this.agentModels === null && this.ownListedModel === null) || categoryOption(this.configOptions, 'model') !== null)) return;
    const { agent, sessionId } = this.target();
    if (agent === null || sessionId === null) return;

    const wanted = ctx.thread.model === AGENT_OWN_MODEL ? null : ctx.thread.model;
    // Only Grok's `set_model` carries an effort; the others have no field for it.
    const effort = grok && ctx.thread.effort !== null && ctx.thread.effort.length > 0 ? ctx.thread.effort : null;
    // Back to the agent's own model on a session moved off it, by this process
    // or by the one that left a loaded session: it has to be asked for. A
    // session already on it sends nothing below.
    const restore = !grok && wanted === null ? this.ownListedModel : null;
    if (wanted === null && effort === null && restore === null) return;

    const listed = this.agentModels;
    const modelId = wanted ?? restore ?? listed?.currentModelId ?? null;
    if (modelId === null) return;
    if (this.appliedModel === modelId && this.appliedEffort === effort) return;

    // Nothing sent yet, and the session already opened on that pair.
    if (this.appliedModel === undefined && listed !== null && listed.currentModelId === modelId) {
      const entry = listed.available.find((model) => model.modelId === modelId) ?? null;
      const current = entry === null ? null : grokReasoningEffortOf(entry.meta);
      if (effort === null || effort === current) {
        this.appliedModel = modelId;
        this.appliedEffort = effort;
        return;
      }
    }

    try {
      await agent.request('session/set_model', {
        sessionId,
        modelId,
        ...(effort === null ? {} : { _meta: { reasoningEffort: effort } }),
      });
      this.appliedModel = modelId;
      this.appliedEffort = effort;
    } catch (error) {
      ctx.log('warn', `acp: the agent refused the model ${modelId}: ${messageOf(error)}`);
    }
  }

  /** What a `session/new` or `session/load` answered about modes, if anything. */
  private noteModes(state: SessionModeState | null | undefined): void {
    if (state === null || state === undefined) return;
    this.modes = state.availableModes;
    this.currentModeId = state.currentModeId;
  }

  /**
   * The thread's permission mode as one `session/set_mode`. Sent when the
   * session opens (a loaded session does not reliably come back in the mode it
   * was left in) and at the start of every turn, so a warm session follows a
   * change and an agent that switched on its own is put back. Nothing goes out
   * when the agent already reports that mode. A mode is a preference: an agent
   * that lists none, offers no match or refuses the call is one warning in the
   * core log, never a reason to fail the turn.
   */
  async applyMode(ctx: SessionContext): Promise<boolean> {
    // Grok's mode went on the command line at spawn and it advertises no
    // `availableModes`: there is nothing to match and nothing to warn about.
    if (isGrok(ctx.provider)) return false;
    const { agent, sessionId } = this.target();
    if (agent === null || sessionId === null) return false;
    const wanted = ctx.thread.permissionMode;

    // An agent that lists its modes as a config option has no `session/set_mode` to answer.
    const option = this.modes.length === 0 ? categoryOption(this.configOptions, 'mode') : null;
    if (option !== null) return this.applyModeOption(ctx, option, wanted);

    const modeId = matchMode(wanted, this.modes);
    if (modeId === null) {
      if (ctx.protectedExecution) throw new Error(`execution.acp.permissionMode: native agent offers no exact mode for ${wanted}`);
      if (this.modeWarned) return false;
      this.modeWarned = true;
      const offered = this.modes.length === 0 ? 'none' : this.modes.map((mode) => mode.id).join(', ');
      ctx.log('warn', `acp: no session mode matches the permission mode ${wanted}; the agent offers ${offered}`);
      return false;
    }
    if (this.currentModeId === modeId) return true;

    try {
      await agent.request('session/set_mode', { sessionId, modeId });
      this.currentModeId = modeId;
      return true;
    } catch (error) {
      if (ctx.protectedExecution) throw new Error(`execution.acp.permissionMode: native agent refused ${modeId}: ${messageOf(error)}`);
      ctx.log('warn', `acp: the agent refused the session mode ${modeId}: ${messageOf(error)}`);
      return false;
    }
  }

  /**
   * The permission mode for an agent whose modes are the values of a `mode`
   * config option: the same candidates, matched against those values, sent as
   * a `session/set_config_option`. The option's own current value is what the
   * agent is in, so nothing goes out when it already matches, and the answer
   * refreshes it. No match is one warning, as for `session/set_mode`.
   */
  private async applyModeOption(ctx: SessionContext, option: SessionConfigOption, wanted: PermissionMode): Promise<boolean> {
    const { agent, sessionId } = this.target();
    if (agent === null || sessionId === null) return false;
    const values = selectValues(option);
    const modeId = matchMode(wanted, values.map((id) => ({ id, name: id })));
    if (modeId === null) {
      if (ctx.protectedExecution) throw new Error(`execution.acp.permissionMode: native agent offers no exact mode for ${wanted}`);
      if (this.modeWarned) return false;
      this.modeWarned = true;
      ctx.log('warn', `acp: no session mode matches the permission mode ${wanted}; the agent offers ${values.length === 0 ? 'none' : values.join(', ')}`);
      return false;
    }
    if (option.type === 'select' && String(option.currentValue) === modeId) return true;
    try {
      const answer = await agent.request('session/set_config_option', { sessionId, configId: option.id, value: modeId });
      const listed = (answer as { configOptions?: SessionConfigOption[] | null }).configOptions ?? null;
      if (ctx.protectedExecution) {
        const confirmed = categoryOption(listed ?? [], 'mode');
        if (confirmed?.type !== 'select' || String(confirmed.currentValue) !== modeId) throw new Error(`execution.acp.permissionMode: native agent did not confirm ${modeId}`);
      }
      if (listed !== null && listed.length > 0) {
        this.configOptions = listed;
        this.ownOptions = true;
      }
      return true;
    } catch (error) {
      if (ctx.protectedExecution) throw new Error(`execution.acp.permissionMode: native agent refused ${modeId}: ${messageOf(error)}`);
      ctx.log('warn', `acp: the agent refused the session mode ${modeId}: ${messageOf(error)}`);
      return false;
    }
  }

  /**
   * The thread's model and reasoning effort as `session/set_config_option`,
   * which is how ACP changes them in place. It runs at the start of every turn,
   * on a session that was loaded as well as on one that was created, and sends
   * only what moved since the last turn: a change of either follows the warm
   * process instead of dropping it.
   */
  async applyConfig(ctx: SessionContext): Promise<void> {
    // Grok took its model and its effort through `session/set_model` and
    // answers `session/set_config_option` with method-not-found: nothing goes
    // out.
    if (isGrok(ctx.provider)) return;
    if (this.configOptions.length === 0 && !ctx.protectedExecution) return;
    const model = ctx.thread.model;
    const effort = ctx.thread.effort;
    // An agent that lists models without a `model` option took it in
    // `applyModel`, which records the model id it asked for.
    const takenByListing = (this.agentModels !== null || this.ownListedModel !== null) && !this.hasModelOption();
    if ((model !== this.appliedModel && !takenByListing) || ctx.protectedExecution) {
      // Back to the agent's own model on a session moved off it: that model
      // has to be asked for, or the session stays on the last one.
      const wanted = model === AGENT_OWN_MODEL && this.appliedModel !== undefined && this.ownModel !== null ? this.ownModel : model;
      if (await this.setOption(ctx, 'model', wanted)) {
        // OpenCode 2 puts the effort back to its default with any other model:
        // what the answer now reports decides whether the effort goes again.
        if (this.appliedModel !== model) this.appliedEffort = undefined;
        this.appliedModel = model;
      } else if (ctx.protectedExecution) {
        throw new Error(`execution.acp.model: native agent offers no confirmed model ${wanted}`);
      }
    }
    if (effort !== this.appliedEffort && (await this.setOption(ctx, 'thought_level', effort))) {
      this.appliedEffort = effort;
    }
  }

  /**
   * The model option for a model the agent takes without listing it: one of a
   * provider the core injected into its configuration, whose ids all start with
   * the prefix the account's environment names. OpenCode 2 lists the models of
   * its own providers alone and still runs `douane/<model>` when asked.
   */
  private injectedModelOption(ctx: SessionContext, category: SessionConfigOptionCategory, wanted: string): SessionConfigOption | undefined {
    const prefix = ctx.accountEnv[PROXY_PREFIX_ENV];
    if (category !== 'model' || prefix === undefined || prefix.length === 0 || !wanted.startsWith(prefix)) return undefined;
    return categoryOption(this.configOptions, 'model') ?? undefined;
  }

  /** One effort level on the session as it runs. False when the agent has no such option or refused it. */
  async applyEffort(ctx: SessionContext, effort: string): Promise<boolean> {
    if (isGrok(ctx.provider) || this.configOptions.length === 0) return false;
    if (effort === this.appliedEffort) return true;
    if (!(await this.setOption(ctx, 'thought_level', effort))) return false;
    this.appliedEffort = effort;
    return true;
  }

  /** True once that value is what the agent is on, whether it was sent or never needed. */
  private async setOption(
    ctx: SessionContext,
    category: SessionConfigOptionCategory,
    wanted: string | null,
  ): Promise<boolean> {
    const { agent, sessionId } = this.target();
    const strictModel = !!ctx.protectedExecution && category === 'model';
    if (agent === null || sessionId === null) return false;
    // No effort set: an agent that lists `default` among its levels (OpenCode
    // 2) is put back on it, since it keeps the last level it was asked for.
    if ((wanted === null || wanted.length === 0) && category === 'thought_level') {
      const option = categoryOption(this.configOptions, category);
      if (option === null || !selectValues(option).includes(AGENT_DEFAULT_EFFORT)) return true;
      wanted = AGENT_DEFAULT_EFFORT;
    }
    // Nothing to ask for: the agent keeps whatever it is configured with.
    if (wanted === null || wanted.length === 0) return true;
    if (category === 'model' && wanted === AGENT_OWN_MODEL) return true;
    const listed = this.configOptions.find(
      (entry) => entry.category === category && selectValues(entry).includes(wanted),
    );
    // Already the value this session last reported: nothing to send.
    if (this.ownOptions && listed?.type === 'select' && String(listed.currentValue) === wanted) return true;
    const refusal = `${category}\0${wanted}`;
    if (!strictModel && this.refused.has(refusal)) return false;
    const option = listed ?? this.injectedModelOption(ctx, category, wanted);
    if (option === undefined) {
      if (!this.configWarned) {
        this.configWarned = true;
        ctx.log('warn', `acp: the agent offers no ${category} option with the value ${wanted}`);
      }
      return false;
    }
    // OpenCode 2 answers `session/new` a moment before it has loaded a provider
    // injected into its configuration: asked at once, it does not know the
    // model yet, and half a second later it does. Only a model it never listed
    // is asked again; a refusal of one it lists is its answer.
    const waits = listed === undefined ? INJECTED_MODEL_RETRY_MS : [];
    for (let attempt = 0; ; attempt += 1) {
      const live = this.target();
      if (live.agent === null || live.sessionId === null) return false;
      try {
        const answer = await live.agent.request('session/set_config_option', {
          sessionId: live.sessionId,
          configId: option.id,
          value: wanted,
        });
        // The answer carries the options as they now stand, current values included.
        const options = (answer as { configOptions?: SessionConfigOption[] | null }).configOptions ?? null;
        if (strictModel) {
          const confirmed = categoryOption(options ?? [], 'model');
          if (confirmed?.type !== 'select' || confirmed.currentValue !== wanted) {
            throw new Error(`execution.acp.model: native agent did not confirm ${wanted}`);
          }
        }
        if (options !== null && options.length > 0) {
          this.configOptions = options;
          this.ownOptions = true;
        }
        return true;
      } catch (error) {
        const wait = waits[attempt];
        if (wait === undefined) {
          if (strictModel) throw new Error(`execution.acp.model: native agent refused ${wanted}: ${messageOf(error)}`);
          ctx.log('warn', `acp: the agent refused the ${category} ${wanted}: ${messageOf(error)}`);
          this.refused.add(refusal);
          return false;
        }
        await new Promise<void>((resolve) => { setTimeout(resolve, wait); });
      }
    }
  }
}
