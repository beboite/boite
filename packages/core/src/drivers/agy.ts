/**
 * The Antigravity CLI's own headless mode:
 * `agy --input-format stream-json --output-format stream-json -p=`, one JSON
 * prompt per line on stdin, one JSON event per line on stdout. There is no SDK
 * behind it and no protocol library, so the line reader below is the whole
 * transport. This is the user's installed `agy` on the user's own login, not
 * the managed ACP server the `antigravity` descriptor downloads.
 *
 * A prompt is `{"event":"user","message":{"role":"user","content":"..."}}`,
 * and one process takes as many as it is sent, each a turn of the same
 * conversation. What comes back:
 *
 * - `init`, once per process: the `conversation_id` and what the agent runs on.
 * - `step_update`, once per change of a step: `step_index`, `state` (`ACTIVE`,
 *   `DONE`, `ERROR`) and `step_type`. An `agent_response` step streams
 *   `text_delta` chunks and carries its `usage` when it is done; a `tool` step
 *   carries `tool_name` and `tool_info { name, parameters, error? }`, `ACTIVE`
 *   then `DONE` or `ERROR` on the same index. `tool_info.output` arrives whole
 *   with the last update of most tools and never streams.
 * - `result`, at the end of every turn: `status` `SUCCESS` or `ERROR`, the
 *   `response`, the `error`. Its `usage` counts the whole process, so a turn's
 *   usage is the sum of its own `agent_response` steps instead.
 *
 * `-p=` has to be spelled with its empty value: a bare `-p` takes the next
 * argument as the prompt. stderr carries the CLI's own chatter, logged and
 * otherwise ignored. Print mode has no approval gate: the permission mode is a
 * launch flag, and whatever it does not allow agy denies by itself.
 */
import type { AccountId, ModelInfo, ProviderId, ThreadId } from '@boite/contracts';
import { messageOf } from '../errors.ts';
import { AGENT_OWN_MODEL, readModels } from './agy/models.ts';
import { AgySession, sessionKey } from './agy/session.ts';
import { AgyTurn } from './agy/turn.ts';
import type { Driver, ProbeContext, ProbeFilter, ProbeResult, TurnContext, TurnHandle } from './types.ts';

const MINUTE_MS = 60_000;

interface ProbeEntry {
  providerId: ProviderId;
  accountId: AccountId;
  /** The one process in flight for this key, so two callers share it. */
  running: Promise<ProbeResult> | null;
  result: ProbeResult | null;
}

/** One agy process per thread, kept between turns when `warmProcessMinutes` says so. */
export function createAgyDriver(): Driver {
  const sessions = new Map<ThreadId, AgySession>();
  /** A thread's last process while it is still leaving, so the next one waits for it. */
  const leaving = new Map<ThreadId, Promise<void>>();
  const probes = new Map<string, ProbeEntry>();

  const keyOf = (providerId: ProviderId, accountId: AccountId): string => `${providerId}::${accountId}`;

  async function probe(ctx: ProbeContext): Promise<ProbeResult> {
    const key = keyOf(ctx.provider.id, ctx.accountId);
    const entry: ProbeEntry = probes.get(key) ?? {
      providerId: ctx.provider.id,
      accountId: ctx.accountId,
      running: null,
      result: null,
    };
    probes.set(key, entry);
    if (entry.result !== null) return entry.result;
    if (entry.running !== null) return entry.running;

    const running = readModels(ctx).then((models) => ({ models, probedAt: Date.now() }));
    entry.running = running;
    try {
      const result = await running;
      if (probes.get(key) === entry) entry.result = result;
      return result;
    } catch (error) {
      if (probes.get(key) === entry) probes.delete(key);
      throw error;
    } finally {
      entry.running = null;
    }
  }

  function probedModels(providerId: ProviderId, accountId: AccountId): ModelInfo[] | null {
    return probes.get(keyOf(providerId, accountId))?.result?.models ?? null;
  }

  /**
   * The id `--model` takes. A grouped model goes out as `<base>-<level>`, the
   * thread's effort or else the model's default level. That default comes from
   * the probe; a core that restarted has none cached, so the turn lists the
   * models once itself, traced under the thread. A model without variants goes
   * out as it is, and `default` sends nothing at all.
   */
  async function launchModel(ctx: TurnContext): Promise<string | null> {
    const model = ctx.thread.model;
    if (model === null || model === AGENT_OWN_MODEL) return null;
    // The core only accepts an effort the model lists, and only grouped models list any.
    if (ctx.thread.effort !== null) return `${model}-${ctx.thread.effort}`;
    let listed = probedModels(ctx.provider.id, ctx.account.id);
    if (listed === null) {
      try {
        listed = (await probe({
          provider: ctx.provider,
          accountId: ctx.account.id,
          accountEnv: ctx.accountEnv,
          cwd: ctx.thread.cwd,
          spawnChild: ctx.spawnChild,
          // The turn's thread may already run agy's leftovers; the probe kills its own child only.
          killTree: () => undefined,
          log: ctx.log,
        })).models;
      } catch (error) {
        ctx.log('warn', `agy: the models could not be listed before the turn, ${model} goes out as it is: ${messageOf(error)}`);
      }
    }
    const level = listed?.find((entry) => entry.id === model)?.effort?.default;
    return level === undefined || level.length === 0 ? model : `${model}-${level}`;
  }

  return {
    protocol: 'agy',
    probe,
    probedModels,

    forgetProbes(filter: ProbeFilter = {}): void {
      for (const [key, entry] of [...probes]) {
        if (filter.providerId !== undefined && filter.providerId !== entry.providerId) continue;
        if (filter.accountId !== undefined && filter.accountId !== entry.accountId) continue;
        probes.delete(key);
      }
    },

    startTurn(ctx: TurnContext): TurnHandle {
      const threadId = ctx.thread.id;
      const warmMs = Math.max(0, ctx.warmProcessMinutes) * MINUTE_MS;
      const key = sessionKey(ctx);
      const turn = new AgyTurn(ctx);

      let session = sessions.get(threadId) ?? null;
      if (session !== null && !session.usable(key, warmMs, ctx.sessionId)) {
        sessions.delete(threadId);
        session.close(session.key === key ? null : 'the thread changed model, effort, permission mode, account or folder', ctx);
        session = null;
      }
      if (session === null) {
        session = new AgySession(key, warmMs, ctx.sessionId, leaving.get(threadId) ?? null, launchModel, (ended, gone) => {
          if (sessions.get(threadId) === ended) sessions.delete(threadId);
          leaving.set(threadId, gone);
          void gone.then(() => {
            if (leaving.get(threadId) === gone) leaving.delete(threadId);
          });
        });
        sessions.set(threadId, session);
      }
      const running = session;
      running.attach(turn, warmMs);
      return {
        done: turn.done,
        stop: (): void => {
          running.stopTurn(turn);
        },
      };
    },

    releaseThread(threadId: ThreadId): void {
      const session = sessions.get(threadId);
      if (session === undefined || session.busy()) return;
      sessions.delete(threadId);
      session.close(null);
    },

    shutdown(): void {
      const open = [...sessions.values()];
      sessions.clear();
      for (const session of open) session.close(null, undefined, true);
    },
  };
}
