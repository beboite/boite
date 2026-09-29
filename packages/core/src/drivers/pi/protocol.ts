import type { ToolStatus } from '@boite/contracts';

export const STDERR_MAX = 400;
/** How long a failed command waits for the child's exit before blaming itself. */
export const EXIT_GRACE_MS = 500;
/** How long a probe waits for the three commands it sends before giving up. */
export const PROBE_TIMEOUT_MS = 30_000;
/** Where a thread's pi transcript lives, under the account's own directory. */
export const SESSION_ROOT = 'pi-sessions';
/** The model id that means "the agent keeps the one it is configured with". */
export const AGENT_OWN_MODEL = 'default';
/** The four `extension_ui_request` methods that block until the client answers. */
export const UI_DIALOGS = new Set(['select', 'confirm', 'input', 'editor']);
/** The `extension_ui_request` methods pi sends and expects no answer to (`docs/rpc-extension-ui.md`). */
export const UI_NOTICES = new Set(['notify', 'setStatus', 'setWidget', 'setTitle', 'set_editor_text']);

/**
 * What every pi process Boite starts gets on top of the environment, turns and
 * probes alike. pi does network work of its own on a cold start; these two stop
 * the part Boite has no use for and leave the rest alone.
 *
 * `PI_SKIP_VERSION_CHECK` drops the `pi.dev` latest-version request
 * (`dist/utils/version-check.js`), `PI_TELEMETRY=0` drops the install and update
 * telemetry and the provider attribution headers (`dist/core/telemetry.js`).
 *
 * `PI_OFFLINE` is deliberately not among them, even though it covers both. It
 * also turns off `ModelRuntime.modelNetworkEnabled`, which a later `refresh()`
 * falls back to (`dist/core/model-runtime.js`), so the remote model catalog is
 * never read and the models probe answers with a shorter list: measured twice on
 * the same configuration, 51 models with it against 53 without.
 */
export const AGENT_ENV: Record<string, string> = {
  PI_SKIP_VERSION_CHECK: '1',
  PI_TELEMETRY: '0',
};

/** pi's `Usage`, the block an `AssistantMessage` carries. */
export interface PiUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  /** The part of `cacheWrite` written with the one-hour lifetime. Only Anthropic reports the split. */
  cacheWrite1h?: number;
  cost?: { total?: number };
}

/** pi's `AssistantMessage`, the fields a `message_end` is read for. */
export interface PiAssistantMessage {
  role?: string;
  /** The wire protocol the request went out on, `anthropic-messages` or `openai-responses` for instance. */
  api?: string;
  provider?: string;
  model?: string;
  usage?: PiUsage;
  stopReason?: string;
  errorMessage?: string;
}

/** One entry of `get_commands`: extension commands, prompt templates and skills alike. */
export interface PiCommand {
  name?: string;
  description?: string;
  source?: string;
  location?: string;
  path?: string;
}

/** What one `tool_execution_*` event is drawn as. */
export interface ToolView {
  name: string;
  input?: unknown;
  output: string | null;
  status: ToolStatus;
}

/** `Model` of `@earendil-works/pi-ai`, the fields the probe reads. */
export interface PiModel {
  id?: string;
  name?: string;
  provider?: string;
  reasoning?: boolean;
  /** Per model: `null` drops a level, and `xhigh` or `max` exist only when present. */
  thinkingLevelMap?: Record<string, string | null>;
}

/**
 * `ThinkingLevel` in pi's own order, from `dist/cli/args.js`. `off` through
 * `high` are the standard scale; `xhigh` and `max` are opt-in per model.
 */
export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
