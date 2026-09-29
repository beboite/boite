import type {
  AgentTask,
  ImageAttachment,
  ProviderDescriptor,
  QuestionAnswer,
  QuestionOption,
  ToolStatus,
  Usage,
} from '@boite/contracts';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { messageOf, unavailable } from '../../errors.ts';
import { profileFor, resolveExecutable } from '../../providers/resolve.ts';
import type { TurnContext } from '../types.ts';
import type {
  ApprovalChoice,
  MuseAnswer,
  MuseItem,
  MuseQuestion,
  MuseTokenUsage,
  OpenApproval,
  ToolView,
} from './protocol.ts';
import { AGENT_OWN_MODEL, COMMAND_TOOL_NAME, EFFORTS, MODE_POSTURE } from './protocol.ts';
import { MspError } from './rpc.ts';

// ---------------------------------------------------------------------------
// Mapping helpers
// ---------------------------------------------------------------------------

export function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * The executable a turn or a probe spawns. The official Windows installer puts a
 * `muse.cmd` launcher on PATH, which `node:child_process` refuses to spawn, and
 * a versioned binary beside it named by `.muse-version`: that binary is what
 * runs. Anything else is spawned as the profile resolved it.
 */
export function museExecutable(provider: ProviderDescriptor): string {
  const profile = profileFor(provider);
  const executable = profile === undefined ? null : resolveExecutable(profile);
  if (executable === null) {
    throw unavailable(`no ${provider.id} executable on this machine`, { providerId: provider.id });
  }
  if (!executable.toLowerCase().endsWith('.cmd')) return executable;
  const dir = dirname(executable);
  let version = '';
  try {
    version = readFileSync(join(dir, '.muse-version'), 'utf8').trim();
  } catch {
    // no launcher record: the shim is all there is
  }
  if (/^[\w.-]+$/.test(version)) {
    const binary = join(dir, `muse-bin-${version}.exe`);
    if (existsSync(binary)) return binary;
  }
  throw unavailable(
    `${basename(executable)} is Muse Code's launcher script, which Boite cannot start: install Muse Code from Providers`,
    { providerId: provider.id, executable },
  );
}

/** The model this turn asks for, or null for the agent's own. */
export function modelOf(ctx: TurnContext): string | null {
  const model = ctx.thread.model;
  if (model === null || model === AGENT_OWN_MODEL) return null;
  return model;
}

/** The thread's effort when it is one `ReasoningEffort` names, else the host's own. */
export function effortOf(ctx: TurnContext): string | null {
  const effort = ctx.thread.effort;
  if (effort === null) return null;
  return (EFFORTS as readonly string[]).includes(effort) ? effort : null;
}

/** `TurnInputPart`s: the prompt as one text part, then one image part per attachment. */
export function inputOf(prompt: string, attachments: ImageAttachment[]): Record<string, unknown>[] {
  return [
    ...(prompt.length === 0 ? [] : [{ type: 'text', text: prompt }]),
    ...attachments.map((attachment) => ({ type: 'image', base64Data: attachment.data, mediaType: attachment.mimeType })),
  ];
}

/** Why a command failed, in words: the host's own reason when it gave one. */
export function commandFailure(error: unknown): string {
  if (error instanceof MspError && error.reason !== null) return `muse refused ${error.method}: ${error.reason}`;
  return messageOf(error);
}

/** The error a failed turn ends with. A missing login gets the one sentence that fixes it. */
export function turnFailure(error: { kind?: string; message?: string } | undefined, reason: string): string | null {
  if (error?.kind === 'authRequired') {
    return `Muse Code is not signed in: sign this account in from Providers (${error.message ?? reason})`;
  }
  if (error?.message !== undefined && error.message.length > 0) return error.message;
  return reason.length > 0 ? reason : null;
}

export function itemStatus(status: string | undefined): ToolStatus {
  switch (status) {
    case 'completed':
      return 'done';
    case 'rejected':
      return 'denied';
    case 'failed':
    case 'cancelled':
    case 'timedOut':
      return 'error';
    default:
      return 'running';
  }
}

/** Muse's tool arguments are model-written JSON, kept as text when they do not parse. */
function argsOf(args: string | undefined): unknown {
  if (args === undefined || args.length === 0) return null;
  try {
    return JSON.parse(args) as unknown;
  } catch {
    return { args };
  }
}

/** A tool item as a card. A shell command is drawn as `Bash`, like every other agent's. */
export function toolViewOf(item: MuseItem): ToolView {
  const output = item.visibleOutput ?? (item.status === 'failed' ? (item.failureReason ?? null) : null);
  if (typeof item.commandText === 'string' && item.commandText.length > 0) {
    return { name: COMMAND_TOOL_NAME, input: { command: item.commandText }, output, status: itemStatus(item.status) };
  }
  return { name: item.tool ?? 'tool', input: argsOf(item.args), output, status: itemStatus(item.status) };
}

/** The card an approval draws: a shell command as `Bash`, anything else under Muse's tool name. */
export function approvalCardOf(open: OpenApproval): { toolName: string; input: unknown; description: string | null } {
  const subject = open.subject;
  const input: Record<string, unknown> = { kind: subject.kind ?? 'tool' };
  for (const key of ['command', 'path', 'access', 'host', 'port', 'target'] as const) {
    if (subject[key] !== undefined) input[key] = subject[key];
  }
  const toolName =
    subject.kind === 'shell' ? COMMAND_TOOL_NAME : open.toolName || subject.toolName || subject.kind || 'tool';
  const description =
    subject.command ?? subject.path ?? subject.host ?? subject.target ?? (open.rawArgs.length > 0 ? open.rawArgs : null);
  return { toolName, input, description };
}

/**
 * The `ApprovalChoice` an answer becomes. Allow takes the narrowest approving
 * choice (once before session before persistent), deny the plain denial, and a
 * stop the `abort` choice when the host offers one.
 */
export function choiceFor(choices: ApprovalChoice[], answer: 'allow' | 'deny' | 'abort'): ApprovalChoice | null {
  const rank = (choice: ApprovalChoice): number =>
    (choice.scope === 'once' ? 0 : choice.scope === 'session' ? 2 : 4) +
    (choice.decision.endsWith('PolicyAmendment') ? 1 : 0);
  const pick = (decisions: string[]): ApprovalChoice | null =>
    choices
      .filter((choice) => decisions.includes(choice.decision))
      .sort((left, right) => rank(left) - rank(right))[0] ?? null;
  if (answer === 'allow') return pick(['approved', 'approvedForSession', 'approvedPolicyAmendment']);
  if (answer === 'abort') return pick(['abort']) ?? pick(['denied', 'deniedPolicyAmendment']);
  return pick(['denied', 'deniedPolicyAmendment']);
}

export function questionTextOf(entry: MuseQuestion): string {
  const header = textOf(entry.header).trim();
  const body = textOf(entry.question).trim();
  if (header.length > 0 && body.length > 0 && header !== body) return `${header}: ${body}`;
  return body.length > 0 ? body : header;
}

/** Muse options have a label and no id: the label is the id, which is what goes back. */
export function optionsOf(raw: MuseQuestion['options']): QuestionOption[] {
  if (!Array.isArray(raw)) return [];
  const options: QuestionOption[] = [];
  for (const entry of raw) {
    const label = textOf(entry?.label);
    if (label.length === 0 || options.some((option) => option.id === label)) continue;
    const description = textOf(entry?.description);
    options.push(description.length > 0 ? { id: label, label, description } : { id: label, label });
  }
  return options;
}

/** One `UserInputAnswer`: the picked labels, and the typed text as `freeText`. */
export function answerOf(questionId: string, answer: QuestionAnswer, options: QuestionOption[], multiple: boolean): MuseAnswer {
  const labels = answer.optionIds
    .map((id) => options.find((option) => option.id === id)?.label)
    .filter((label): label is string => label !== undefined);
  const text = answer.text?.trim() ?? '';
  const out: MuseAnswer = { questionId };
  if (labels.length > 0) {
    if (multiple) out.selectedLabels = labels;
    else out.selectedLabel = labels[0] as string;
  }
  if (text.length > 0) out.freeText = text;
  return out;
}

/** `session/todoListChanged` as the thread's tasks. A cancelled item is dropped. */
export function tasksOf(items: unknown[]): AgentTask[] {
  const tasks: AgentTask[] = [];
  items.forEach((entry, index) => {
    const item = (entry ?? {}) as { text?: unknown; status?: unknown };
    const text = textOf(item.text).trim();
    if (text.length === 0 || item.status === 'cancelled') return;
    const status =
      item.status === 'completed' ? 'completed' : item.status === 'inProgress' ? 'in_progress' : 'pending';
    tasks.push({ id: String(index), text, status });
  });
  return tasks;
}

/** `TokenUsage`. Muse carries no price, so the cost stays null. */
export function mapUsage(usage: MuseTokenUsage): Usage {
  return {
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    cacheReadTokens: usage.cacheReadTokens ?? usage.cachedTokens ?? 0,
    cacheWriteTokens: usage.cacheWriteTokens ?? 0,
    costUsdEquivalent: null,
  };
}

export function addUsage(left: Usage | null, right: Usage): Usage {
  if (left === null) return right;
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    cacheReadTokens: left.cacheReadTokens + right.cacheReadTokens,
    cacheWriteTokens: left.cacheWriteTokens + right.cacheWriteTokens,
    costUsdEquivalent: null,
  };
}

/**
 * What a session was started with and cannot be told to change: the folder,
 * the account and the host's sandbox flags. The model, the effort and the
 * approval mode are not in here, they are sent on the running host.
 */
export function sessionKey(ctx: TurnContext): string {
  return JSON.stringify({
    cwd: ctx.thread.cwd,
    flags: MODE_POSTURE[ctx.thread.permissionMode].flags,
    accountId: ctx.account.id,
    providerId: ctx.provider.id,
    env: ctx.accountEnv,
  });
}
