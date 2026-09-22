import { type ModelInfo, type ProviderSummary } from '@boite/contracts';
import { DATA_DIR } from './shared.ts';

/** The managed provider of the seed: a release Boite downloads, 468 MB of it. */
export const MANAGED_ID = 'antigravity';

export const MANAGED_VERSION = 'agy_acp_server_1.1.1';

export const MANAGED_ARCHIVE_BYTES = 468_238_392;

export const MANAGED_EXE = `${DATA_DIR}\\agents\\${MANAGED_ID}\\current\\agy_acp_server.exe`;

/** The second one is already down, one version behind: that is the Update row. */
export const UPDATABLE_ID = 'opencode';

export const UPDATABLE_VERSION = '0.4.12';

export const UPDATABLE_AVAILABLE = '0.5.0';

const UPDATABLE_ARCHIVE_BYTES = 41_268_224;

/** What one `providers.install` on that provider would fetch, and how big it is. */
export const RELEASES: Record<string, { version: string; archiveBytes: number }> = {
  claude: { version: '2.1.267', archiveBytes: 220_051_616 },
  codex: { version: '0.155.1', archiveBytes: 107_573_195 },
  [MANAGED_ID]: { version: MANAGED_VERSION, archiveBytes: MANAGED_ARCHIVE_BYTES },
  [UPDATABLE_ID]: { version: UPDATABLE_AVAILABLE, archiveBytes: UPDATABLE_ARCHIVE_BYTES }
};

/** Sixteen steps of 120 ms: about two seconds of download, long enough to be seen. */
export const INSTALL_STEPS = 16;

export const INSTALL_STEP_MS = 120;

/** How long the fake agent takes to answer a probe, so the picker shows it reading. */
export const PROBE_MS = 150;

/** How long the fake's `threads.retitle` takes: long enough for the menu to say it is writing. */
export const RETITLE_DELAY_MS = 200;

/** How long the fake takes to read its transcripts, and to import one. */
export const IMPORT_LIST_MS = 120;

/** The fake's context meter: a window, a floor on the first turn, a step per turn on top of the prompt. */
export const FAKE_CONTEXT_WINDOW = 200_000;

export const FAKE_CONTEXT_FLOOR = 1_200;

export const FAKE_CONTEXT_PER_TURN = 600;

/**
 * What the fake ACP agent lists in the `configOptions` of a `session/new`: its
 * own models, the descriptor's `default` first, and one reasoning scale that
 * belongs to the session rather than to a model.
 */
const PROBED_EFFORT = {
  levels: [
    { id: 'think', label: 'Think' },
    { id: 'think-hard', label: 'Think hard' }
  ],
  default: 'think'
};

/**
 * A real OpenCode answers with hundreds of models across a dozen prefixes (534
 * on the machine this was written on), so the fake answers with enough of them
 * to put the picker's model column past its search threshold.
 */
const PROBED_CATALOGUE: [string, string][] = [
  ['openrouter/anthropic/claude-sonnet-4-5', 'Claude Sonnet 4.5'],
  ['openrouter/anthropic/claude-haiku-4-5', 'Claude Haiku 4.5'],
  ['openrouter/openai/gpt-5-mini', 'GPT-5 Mini'],
  ['openrouter/google/gemini-3-pro', 'Gemini 3 Pro'],
  ['openrouter/meta-llama/llama-4-scout', 'Llama 4 Scout'],
  ['openrouter/deepseek/deepseek-v4', 'DeepSeek V4'],
  ['openrouter/qwen/qwen3-max', 'Qwen3 Max'],
  ['opencode/grok-code', 'Grok Code'],
  ['opencode/claude-sonnet-5', 'Claude Sonnet 5 zen'],
  ['opencode/gpt-5-codex', 'GPT-5 Codex zen'],
  ['opencode/kimi-k2', 'Kimi K2'],
  ['opencode/glm-4-7', 'GLM 4.7'],
  ['opencode/minimax-m2', 'MiniMax M2'],
  ['nvidia/nemotron-4-340b', 'Nemotron 4 340B'],
  ['nvidia/llama-3-3-nemotron-super', 'Llama 3.3 Nemotron Super'],
  ['nvidia/mistral-nemo-12b', 'Mistral Nemo 12B'],
  ['nvidia/deepseek-r2', 'DeepSeek R2'],
  ['nvidia/qwen3-coder-480b', 'Qwen3 Coder 480B'],
  ['nvidia/gpt-oss-120b', 'GPT-OSS 120B'],
  ['nvidia/phi-4-reasoning', 'Phi 4 Reasoning']
];

/** The scale the Muse probe falls back to when its model catalog lists none. */
export const MUSE_EFFORT: NonNullable<ModelInfo['effort']> = {
  levels: [
    { id: 'low', label: 'Low' },
    { id: 'medium', label: 'Medium' },
    { id: 'high', label: 'High' },
    { id: 'xhigh', label: 'Extra high' },
    { id: 'max', label: 'Max' }
  ],
  default: 'high'
};

export const PROBED_MODELS: ModelInfo[] = [
  { id: 'default', name: 'OpenCode default', default: false, effort: PROBED_EFFORT },
  { id: 'anthropic/claude-sonnet-5', name: 'Claude Sonnet 5', default: true, effort: PROBED_EFFORT },
  { id: 'openai/gpt-5-codex', name: 'GPT-5 Codex', default: false, effort: PROBED_EFFORT },
  ...PROBED_CATALOGUE.map(([id, name]): ModelInfo => ({ id, name, default: false, effort: PROBED_EFFORT }))
];

export const PROBE_PROVIDERS: Pick<ProviderSummary, 'id' | 'name' | 'protocol' | 'login'>[] = [
  { id: 'codex', name: 'Codex', protocol: 'codex-appserver', login: { kind: 'command' } },
  { id: 'pi', name: 'pi', protocol: 'pi', login: false },
  { id: 'grok', name: 'Grok', protocol: 'acp', login: { kind: 'command' } },
  { id: 'muse', name: 'Muse Code', protocol: 'muse', login: { kind: 'command' } }
];
