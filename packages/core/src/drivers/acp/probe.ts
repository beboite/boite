/** The probe: the models the agent itself lists, read by one short-lived process. */
import { Readable, Writable } from 'node:stream';
import type { ClientConnection, SessionConfigOption } from '@agentclientprotocol/sdk';
import type { AccountId, ModelInfo, ProviderId } from '@boite/contracts';
import pkg from '../../../package.json';
import { messageOf, unavailable } from '../../errors.ts';
import { agentEnv, launchPrefix, profileFor, resolveExecutable } from '../../providers/resolve.ts';
import { stderrLines } from '../lines.ts';
import type { ProbeContext, ProbeResult } from '../types.ts';
import { agentModelsOf, categoryOption, effortFrom, modelsFrom, selectValues, type AgentModels } from './models.ts';
import { CLIENT_NAME, isGrok, preferExit, STDERR_MAX, type AcpDeps, type Timer } from './protocol.ts';
import { jsonLinesOnly } from './stdout.ts';

/** How long a probe waits for the agent to answer `initialize` and `session/new`. */
const PROBE_TIMEOUT_MS = 20_000;

/** What one probe session read: the list, and the named model's own effort scale when one was asked for. */
export interface ProbeReading {
  models: ModelInfo[];
  /** Null when no model was named, or the agent has no per-model scale to read. */
  effort: { model: string; scale: ModelInfo['effort'] | null } | null;
}

/**
 * One short-lived agent process: `initialize`, `session/new`, read the config
 * options, then the child goes through the registry that traced it. Nothing of
 * this session is kept; a turn opens its own.
 */
export async function readModels(ctx: ProbeContext, deps: AcpDeps, noteOptions: (options: SessionConfigOption[]) => void): Promise<ProbeReading> {
  const sdk = await deps.loadSdk();
  const profile = profileFor(ctx.provider);
  const executable = profile === undefined ? null : resolveExecutable(profile);
  if (executable === null) {
    throw unavailable(`no ${ctx.provider.id} executable on this machine`, { providerId: ctx.provider.id });
  }

  let lastStderr = '';
  // No thread here, so no permission mode either: the probe launches the line
  // the descriptor declares and reads the agent on its own defaults.
  const child = ctx.spawnChild(executable, [...launchPrefix(profile), ...(profile?.launch?.args ?? [])], {
    cwd: ctx.cwd,
    env: agentEnv(ctx.provider, ctx.accountEnv),
  });
  child.stdin.on('error', () => undefined);
  stderrLines(child.stderr, (text) => {
    lastStderr = text.slice(0, STDERR_MAX);
  });

  const say = (head: string): string => (lastStderr.length === 0 ? head : `${head}: ${lastStderr}`);
  let connection: ClientConnection | null = null;
  let timer: Timer | null = null;
  try {
    const died = new Promise<never>((_resolve, reject) => {
      child.once('exit', (code) => {
        reject(unavailable(say(`the ${ctx.provider.id} agent exited with code ${code ?? 'unknown'}`), {
          providerId: ctx.provider.id,
          accountId: ctx.accountId,
        }));
      });
      child.once('error', (error) => {
        reject(unavailable(say(`the ${ctx.provider.id} agent did not start: ${messageOf(error)}`), {
          providerId: ctx.provider.id,
          accountId: ctx.accountId,
        }));
      });
    });
    const expired = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(unavailable(say(`the ${ctx.provider.id} agent did not list its models in ${PROBE_TIMEOUT_MS / 1000} s`), {
          providerId: ctx.provider.id,
          accountId: ctx.accountId,
        }));
      }, PROBE_TIMEOUT_MS);
      timer.unref?.();
    });

    const stream = sdk.ndJsonStream(
      Writable.toWeb(child.stdin) as unknown as WritableStream<Uint8Array>,
      jsonLinesOnly(Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>, (line) => {
        lastStderr = line.slice(0, STDERR_MAX);
      }),
    );
    // No update handler and no permission handler: nothing of this session is
    // drawn, and a prompt never goes out on it.
    const open = sdk.client({ name: CLIENT_NAME }).connect(stream);
    connection = open;

    const read = (async (): Promise<{ options: SessionConfigOption[] | null; listed: AgentModels | null; effort: ProbeReading['effort'] }> => {
      await open.agent.request('initialize', {
        protocolVersion: sdk.PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: { name: CLIENT_NAME, version: pkg.version },
      });
      const created = await open.agent.request('session/new', { cwd: ctx.cwd, mcpServers: [] });
      const options = created.configOptions ?? null;
      // OpenCode lists a model's efforts only once the session is on that model:
      // the `thought_level` option is absent from `session/new` and arrives in
      // the answer to the model change. Grok writes its scales in `_meta`.
      let effort: ProbeReading['effort'] = null;
      const wanted = ctx.model;
      const modelOption = categoryOption(options, 'model');
      if (wanted !== undefined && !isGrok(ctx.provider) && modelOption !== null && selectValues(modelOption).includes(wanted)) {
        const answer = await open.agent.request('session/set_config_option', {
          sessionId: created.sessionId,
          configId: modelOption.id,
          value: wanted,
        });
        const listed = (answer as { configOptions?: SessionConfigOption[] | null }).configOptions ?? null;
        effort = { model: wanted, scale: effortFrom(categoryOption(listed, 'thought_level')) };
      }
      return { options, listed: agentModelsOf(created), effort };
    })();

    // When the agent exits, stdout closes and the pending request rejects with
    // "the connection closed" before the exit is reported: a failed read
    // waits a moment for the exit, whose code and stderr line say why.
    const answer = await Promise.race([read.catch((error: unknown) => preferExit(died, error)), died, expired]);
    noteOptions(answer.options ?? []);
    return { models: modelsFrom(ctx.provider, answer.options, answer.listed), effort: answer.effort };
  } finally {
    if (timer !== null) clearTimeout(timer);
    try {
      connection?.close();
    } catch {
      // the connection is already closed
    }
    try {
      child.stdin.end();
    } catch {
      // the pipe is already gone
    }
    ctx.killTree();
  }
}

export interface ProbeEntry {
  options: SessionConfigOption[];
  providerId: ProviderId;
  accountId: AccountId;
  /** The one process in flight for this key, so two callers share it. */
  running: Promise<ProbeResult> | null;
  result: ProbeResult | null;
  /** Models whose own effort scale was asked for already, found or not, so each costs one process at most. */
  effortRead: Set<string>;
}

/** The list with one model's effort scale written in; a scale of null leaves the model as it was. */
export function withModelEffort(models: ModelInfo[], effort: ProbeReading['effort']): ModelInfo[] {
  if (effort === null || effort.scale === null) return models;
  const scale = effort.scale;
  return models.map((model) => (model.id === effort.model ? { ...model, effort: scale } : model));
}
