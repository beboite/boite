/**
 * What every ACP process of the driver shares: the SDK as it is loaded, the
 * name the client gives itself, and the limits and waits a turn, a probe and a
 * login all use.
 */
import type { ProviderDescriptor } from '@boite/contracts';

/** What the agent sees as `clientInfo.name`, and the name of the JSON-RPC app. */
export const CLIENT_NAME = 'boite';
export const MINUTE_MS = 60_000;
export const STDERR_MAX = 400;
/** How long a failed prompt waits for the child's exit before blaming the error itself. */
export const EXIT_GRACE_MS = 500;

/**
 * The one dialect that lists its models itself, carries a per-model effort
 * scale, takes both through `session/set_model`, and takes its permission mode
 * on the command line because it advertises no session modes.
 */
export function isGrok(provider: ProviderDescriptor): boolean {
  return provider.quirks?.includes('grok') === true;
}

/** Hermes Agent's dialect: a `session/load` of an id it does not have answers an empty result. */
export function isHermes(provider: ProviderDescriptor): boolean {
  return provider.quirks?.includes('hermes') === true;
}

/** The whole SDK, loaded on the first ACP turn: nothing heavy loads at core start. */
export type AcpSdk = typeof import('@agentclientprotocol/sdk');

export interface AcpDeps {
  loadSdk: () => Promise<AcpSdk>;
}

export type Timer = ReturnType<typeof setTimeout>;

/** A failure of the connection, unless the process's own exit lands within the grace: then that one. */
export async function preferExit(died: Promise<never>, error: unknown): Promise<never> {
  await Promise.race([
    died,
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, EXIT_GRACE_MS);
      timer.unref?.();
    }),
  ]);
  throw error;
}

/** The agent advertised `sessionCapabilities.delete`: a session Boite opened only to read controls can go. */
export function canDeleteSessions(init: { agentCapabilities?: { sessionCapabilities?: { delete?: unknown } | null } | null }): boolean {
  const capability = init.agentCapabilities?.sessionCapabilities?.delete;
  return capability !== undefined && capability !== null;
}

/**
 * Deletes a session opened only to read the agent's controls, so a probe or a
 * discovery leaves no empty conversation in the agent's own list (OpenCode 2
 * keeps each one in its database). A refusal changes nothing for the caller.
 */
export async function discardSession(
  agent: { request(method: 'session/delete', params: { sessionId: string }): Promise<unknown> },
  canDelete: boolean,
  sessionId: string,
): Promise<void> {
  if (!canDelete) return;
  try {
    await agent.request('session/delete', { sessionId });
  } catch {
    // An agent that will not delete it keeps one empty session, as before.
  }
}
