import {
  RpcErrorCode,
  type Account,
  type ModelInfo,
  type ProviderSummary,
  type QuestionRequest,
} from '@boite/contracts';
import { RpcFailure } from '../client';

/*
 * The core's refusals, one function per rule, for the in-memory client. Each
 * answers with the core's code, message and data keys, so a screen tested on
 * the fake meets the refusal the core would send. The shared contract
 * scenarios in `tests/contract/` run against both and catch a rule that drifts.
 */

function refused(message: string, data?: Record<string, unknown>): RpcFailure {
  return new RpcFailure({ code: RpcErrorCode.Refused, message, ...(data === undefined ? {} : { data }) });
}

/** The core's `answerQuestion` checks, in its order; the question stays pending when one refuses. */
export function checkAnswer(
  request: QuestionRequest,
  params: { threadId: string; optionIds: string[]; text?: string },
): void {
  if (request.threadId !== params.threadId) {
    throw refused('the question belongs to another thread', {
      questionId: request.id,
      threadId: params.threadId,
      expected: request.threadId,
    });
  }
  const known = new Set(request.options.map((option) => option.id));
  const unknown = params.optionIds.filter((id) => !known.has(id));
  if (unknown.length > 0) {
    throw refused('the question does not offer these options', { questionId: request.id, unknown, expected: [...known] });
  }
  if (!request.multiple && params.optionIds.length > 1) {
    throw refused('the question takes one option', { questionId: request.id, optionIds: params.optionIds });
  }
  const text = params.text ?? '';
  if (text.length > 0 && !request.allowText) throw refused('the question takes no free text', { questionId: request.id });
  if (params.optionIds.length === 0 && text.length === 0) {
    throw refused('an answer needs an option or some text', { questionId: request.id });
  }
}

/** The core's `askAsync` checks: the trimmed text and labels it keeps, and whether the card takes several options. */
export function checkAsk(params: { text: unknown; options?: unknown; multiple?: unknown }): {
  text: string;
  labels: string[];
  multiple: boolean;
} {
  const text = typeof params.text === 'string' ? params.text.trim() : '';
  if (text.length === 0 || text.length > 2000) throw refused('text must hold 1 to 2000 characters', { field: 'text' });
  const labels = params.options ?? [];
  if (!Array.isArray(labels) || labels.length > 12
    || labels.some((label) => typeof label !== 'string' || label.trim().length === 0 || label.length > 200)) {
    throw refused('options must be at most 12 labels of 1 to 200 characters', { field: 'options' });
  }
  if (params.multiple !== undefined && typeof params.multiple !== 'boolean') {
    throw refused('multiple must be a boolean', { field: 'multiple' });
  }
  const trimmed = (labels as string[]).map((label) => label.trim());
  return { text, labels: trimmed, multiple: params.multiple === true && trimmed.length > 1 };
}

/** The protocols whose models the agent lists itself, so an unknown one may just be unread. */
const PROBED_PROTOCOLS = ['acp', 'codex-appserver', 'muse', 'pi', 'agy'];

/** The core's `checkModel`: null is the provider's default, anything else must be listed. */
export function checkModel(provider: ProviderSummary, accountId: string, models: ModelInfo[], model: string | null): string | null {
  if (model === null) return null;
  if (models.some((entry) => entry.id === model)) return model;
  throw refused(
    PROBED_PROTOCOLS.includes(provider.protocol)
      ? 'the agent has not listed this model: open the model picker so Boite reads its models first'
      : 'the provider does not offer this model',
    { providerId: provider.id, accountId, model, expected: models.map((entry) => entry.id) },
  );
}

/** The core's `checkEffort`: null is the model's default, anything else must be one of its levels. */
export function checkEffort(provider: ProviderSummary, models: ModelInfo[], model: string | null, effort: string | null): string | null {
  if (effort === null) return null;
  const levels = models.find((entry) => entry.id === model)?.effort?.levels ?? [];
  if (levels.some((level) => level.id === effort)) return effort;
  throw refused('the model does not offer this reasoning effort', {
    providerId: provider.id,
    model,
    effort,
    expected: levels.length === 0 ? 'null: this model has no effort levels' : levels.map((level) => level.id),
  });
}

/** The core's default model: the one marked default, else the first listed. */
export function defaultModel(provider: ProviderSummary): string | null {
  return provider.models.find((model) => model.default === true)?.id ?? provider.models[0]?.id ?? null;
}

/** One spelling of a Windows path to compare: forward slashes, lower case, no trailing slash. */
export function pathKey(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/** The core's `checkCwd`, without the disk: the directory must be the project or inside it. */
export function checkCwd(projectPath: string, cwd: string): string {
  const root = pathKey(projectPath);
  const inside = pathKey(cwd);
  if (inside !== root && !inside.startsWith(`${root}/`)) {
    throw refused('the working directory must be inside the project', { cwd, projectPath });
  }
  return cwd;
}

/** A folder the fake has no disk for counts as present, except under one named `missing`. */
export function missingFolder(path: string): boolean {
  return /(^|[\\/])missing([\\/]|$)/i.test(path);
}

/** The core's `assertDriverRunnable`, for the fake's providers and accounts. */
export function checkRunnable(provider: ProviderSummary | undefined, account: Account): void {
  if (provider === undefined || !provider.available) {
    throw new RpcFailure({
      code: RpcErrorCode.Unavailable,
      message: `the provider ${account.providerId} is not available on this machine`,
      data: { providerId: account.providerId, executable: provider?.executable ?? null },
    });
  }
  if (account.status === 'unauthenticated') {
    throw new RpcFailure({
      code: RpcErrorCode.Unavailable,
      message: `the account ${account.label} is not logged in`,
      data: { accountId: account.id, providerId: account.providerId },
    });
  }
}

/**
 * What the core's session check reads on a new or rechecked account: a
 * provider with no sign-in runs as is, an account at the provider's own
 * location is the user's own login, and an isolated one is signed in only
 * once a login finished in it.
 */
export function sessionStatus(provider: ProviderSummary | undefined, account: Account, signedIn: boolean): Account['status'] {
  if (provider === undefined) return 'error';
  if (provider.login === false || account.isolationDir === null || signedIn) return 'ok';
  return 'unauthenticated';
}
