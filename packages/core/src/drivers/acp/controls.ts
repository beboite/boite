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
import type { PermissionMode } from '@boite/contracts';
import { messageOf } from '../../errors.ts';
import { grokReasoningEffortOf } from '../grok.ts';
import type { TurnContext } from '../types.ts';
import { AGENT_OWN_MODEL, agentModelsOf, selectValues, type AgentModels } from './models.ts';
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
 *   smaller agents call theirs.
 * - `auto` is the short name for a mode that approves everything.
 */
const MODE_CANDIDATES: Record<PermissionMode, readonly string[]> = {
  default: ['default', 'build', 'normal'],
  acceptEdits: ['acceptEdits', 'accept_edits', 'autoEdit', 'auto_edit'],
  bypassPermissions: ['bypassPermissions', 'bypass_permissions', 'yolo', 'auto'],
  plan: ['plan'],
  dontAsk: ['dontAsk', 'dont_ask', 'bypassPermissions', 'bypass_permissions', 'yolo', 'auto'],
};

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
  /** What the last `session/new` or `session/load` said the agent can be in. */
  private modes: SessionMode[] = [];
  /** The mode the agent is in, as it last told us: an answer or a drift it announced. */
  private currentModeId: string | null = null;
  private modeWarned = false;

  constructor(private readonly target: () => ControlTarget) {}

  seed(options: SessionConfigOption[]): void {
    if (this.configOptions.length === 0) this.configOptions = structuredClone(options);
  }

  hasOptions(): boolean {
    return this.configOptions.length > 0;
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
  ): void {
    this.noteModes(modes);
    if (options !== null && options.length > 0) this.configOptions = options;
    const listed = agentModelsOf(answer);
    if (listed !== null) this.agentModels = listed;
  }

  /**
   * The thread's model and reasoning effort as one `session/set_model`, for the
   * agents that take them there rather than through `session/set_config_option`
   * (Grok, today). It runs at the start of every turn and sends nothing when
   * the pair has not moved since the last one, so a warm session follows a
   * change instead of being dropped for it. A thread on the agent's own model
   * with no effort set says nothing, and neither does one the session answer
   * already reports as current. A refusal is one warning: the turn runs on
   * whatever the agent is already on.
   */
  async applyModel(ctx: TurnContext): Promise<void> {
    if (!isGrok(ctx.provider)) return;
    const { agent, sessionId } = this.target();
    if (agent === null || sessionId === null) return;

    const wanted = ctx.thread.model === AGENT_OWN_MODEL ? null : ctx.thread.model;
    const effort = ctx.thread.effort !== null && ctx.thread.effort.length > 0 ? ctx.thread.effort : null;
    if (wanted === null && effort === null) return;

    const listed = this.agentModels;
    const modelId = wanted ?? listed?.currentModelId ?? null;
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
  async applyMode(ctx: TurnContext): Promise<void> {
    // Grok's mode went on the command line at spawn and it advertises no
    // `availableModes`: there is nothing to match and nothing to warn about.
    if (isGrok(ctx.provider)) return;
    const { agent, sessionId } = this.target();
    if (agent === null || sessionId === null) return;
    const wanted = ctx.thread.permissionMode;

    const modeId = matchMode(wanted, this.modes);
    if (modeId === null) {
      if (this.modeWarned) return;
      this.modeWarned = true;
      const offered = this.modes.length === 0 ? 'none' : this.modes.map((mode) => mode.id).join(', ');
      ctx.log('warn', `acp: no session mode matches the permission mode ${wanted}; the agent offers ${offered}`);
      return;
    }
    if (this.currentModeId === modeId) return;

    try {
      await agent.request('session/set_mode', { sessionId, modeId });
      this.currentModeId = modeId;
    } catch (error) {
      ctx.log('warn', `acp: the agent refused the session mode ${modeId}: ${messageOf(error)}`);
    }
  }

  /**
   * The thread's model and reasoning effort as `session/set_config_option`,
   * which is how ACP changes them in place. It runs at the start of every turn,
   * on a session that was loaded as well as on one that was created, and sends
   * only what moved since the last turn: a change of either follows the warm
   * process instead of dropping it.
   */
  async applyConfig(ctx: TurnContext): Promise<void> {
    // Grok took its model and its effort through `session/set_model` and
    // answers `session/set_config_option` with method-not-found: nothing goes
    // out.
    if (isGrok(ctx.provider)) return;
    if (this.configOptions.length === 0) return;
    const model = ctx.thread.model;
    const effort = ctx.thread.effort;
    if (model !== this.appliedModel && (await this.setOption(ctx, 'model', model))) this.appliedModel = model;
    if (effort !== this.appliedEffort && (await this.setOption(ctx, 'thought_level', effort))) {
      this.appliedEffort = effort;
    }
  }

  /** True once that value is what the agent is on, whether it was sent or never needed. */
  private async setOption(
    ctx: TurnContext,
    category: SessionConfigOptionCategory,
    wanted: string | null,
  ): Promise<boolean> {
    const { agent, sessionId } = this.target();
    if (agent === null || sessionId === null) return false;
    // Nothing to ask for: the agent keeps whatever it is configured with.
    if (wanted === null || wanted.length === 0) return true;
    if (category === 'model' && wanted === AGENT_OWN_MODEL) return true;
    const option = this.configOptions.find(
      (entry) => entry.category === category && selectValues(entry).includes(wanted),
    );
    if (option === undefined) {
      if (!this.configWarned) {
        this.configWarned = true;
        ctx.log('warn', `acp: the agent offers no ${category} option with the value ${wanted}`);
      }
      return false;
    }
    try {
      const answer = await agent.request('session/set_config_option', {
        sessionId,
        configId: option.id,
        value: wanted,
      });
      // The answer carries the options as they now stand, current values included.
      const listed = (answer as { configOptions?: SessionConfigOption[] | null }).configOptions ?? null;
      if (listed !== null && listed.length > 0) this.configOptions = listed;
      return true;
    } catch (error) {
      ctx.log('warn', `acp: the agent refused the ${category} ${wanted}: ${messageOf(error)}`);
      return false;
    }
  }
}
