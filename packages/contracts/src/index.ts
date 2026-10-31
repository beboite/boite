import type { AgentsRpcMethods, AgentsRpcEvents } from './agents';
import type { ComposerRpcMethods, ComposerRpcEvents } from './composer';
export * from './composer';
import type { WorkflowsRpcMethods, WorkflowsRpcEvents } from './workflows';
import type { BrowserRpcMethods, BrowserRpcEvents, BrowserProfile } from './browser';
import type { PullRequestsRpcMethods, PullRequestsRpcEvents, PullRequestWatch } from './pull-requests';
import type { MobileDevicesRpcMethods, MobileDevicesRpcEvents } from './mobile-devices';
import type { WindowsRpcMethods, WindowsRpcEvents } from './windows';
import type { DesktopRpcMethods } from './desktop';
import type { CoreLogContext, CoreLogLevel, CoreLogRecord, CoreLogsQuery, DiagnosticsRpcMethods } from './diagnostics';
export * from './diagnostics';
export * from './pull-requests';
export * from './browser';
export * from './browser-remote';
export * from './mobile-devices';
export * from './windows';
export * from './desktop';
export * from './agents';
export { nextAgentOccurrence } from './agent-schedule';
export * from './workflows';
export * from './workflow-plan';
export * from './thread-focus';
export * from './context-mode';
export * from './delegation-input';
import type { AccountsRpcEvents, AccountsRpcMethods } from './accounts';
import type { AgentDoorRpcMethods } from './agent-door';
import type { BrainRpcEvents, BrainRpcMethods } from './brain';
import type { CoordinationRpcEvents, CoordinationRpcMethods } from './coordination';
import type { CoreRpcEvents, CoreRpcMethods } from './core';
import type { DelegationRpcEvents, DelegationRpcMethods } from './delegation';
import type { FilesRpcMethods } from './files';
import type { GitRpcMethods } from './git';
import type { GroupRpcEvents, GroupRpcMethods } from './group';
import type { HooksRpcEvents, HooksRpcMethods } from './hooks';
import type { ImportsRpcEvents, ImportsRpcMethods } from './imports';
import type { KeybindingsRpcEvents, KeybindingsRpcMethods } from './keybindings';
import type { MessagesRpcEvents, MessagesRpcMethods } from './messages';
import type { PairingRpcMethods } from './pairing';
import type { PanelRpcEvents, PanelRpcMethods } from './panel';
import type { PermissionsRpcEvents, PermissionsRpcMethods } from './permissions';
import type { PluginsRpcEvents, PluginsRpcMethods } from './plugins';
import type { ProjectsRpcEvents, ProjectsRpcMethods } from './projects';
import type { ProvidersRpcEvents, ProvidersRpcMethods } from './providers';
import type { QuestionsRpcEvents, QuestionsRpcMethods } from './questions';
import type { SchedulerRpcEvents, SchedulerRpcMethods } from './scheduler';
import type { SecretsRpcEvents, SecretsRpcMethods } from './secrets';
import type { SettingsRpcEvents, SettingsRpcMethods } from './settings';
import type { SpeechRpcMethods } from './speech';
import type { SubscriptionProxyRpcEvents, SubscriptionProxyRpcMethods } from './subscription-proxy';
import type { TerminalsRpcEvents, TerminalsRpcMethods } from './terminals';
import type { SharedProjectsRpcEvents, SharedProjectsRpcMethods } from './shared-projects';
import type { ThreadsRpcEvents, ThreadsRpcMethods } from './threads';
import type { TodosRpcEvents, TodosRpcMethods } from './todos';
import type { TraceRpcEvents, TraceRpcMethods } from './trace';
import type { TurnsRpcEvents, TurnsRpcMethods } from './turns';
import type { UsageRpcMethods } from './usage';
import type { PolicyRpcEvents, PolicyRpcMethods } from './policy';
export * from './ids';
export * from './providers';
export * from './local-acp';
export * from './accounts';
export * from './plugins';
export * from './projects';
export * from './threads';
export * from './usage';
export * from './turns';
export * from './messages';
export * from './permissions';
export * from './questions';
export * from './secrets';
export * from './trace';
export * from './scheduler';
export * from './settings';
export * from './subscription-proxy';
export * from './keybindings';
export * from './imports';
export * from './core';
export * from './agent-door';
export * from './panel';
export * from './todos';
export * from './git';
export * from './files';
export * from './pairing';
export * from './speech';
export * from './coordination';
export * from './group';
export * from './delegation';
export * from './brain';
export * from './settings-sync';
export * from './hooks';
export * from './terminals';
export * from './shared-projects';
export * from './wire';
export * from './policy';

/**
 * Boite 2 wire contract: the JSON-RPC methods and events between the core
 * (the host process that runs the agents) and its clients (the desktop shell,
 * the phone PWA, tests, benches).
 *
 * The core is the only side that executes anything. Clients drive it over an
 * authenticated WebSocket. This file is the whole vocabulary; a method or an
 * event that is not here does not exist.
 */

export const PROTOCOL_VERSION = 2 as const;

export { IMAGE_MIME_TYPES, IMAGE_MAX_EDGE, ATTACHMENT_MAX_BYTES, ATTACHMENTS_PER_TURN, ATTACHMENTS_TOTAL_MAX_BYTES, RPC_MAX_FRAME_BYTES } from './attachment-limits.ts';
export type { ImageMimeType } from './attachment-limits.ts';

export { PREVIEW_REFERENCES_PER_TURN, previewReferencesError, previewPrompt } from './preview';
export { previewToolOutputs, previewToolPart, inputPreview, longerThan, TOOL_OUTPUT_INLINE_CHARS, TOOL_OUTPUT_PREVIEW_CHARS, TOOL_OUTPUT_FOLDED_CHARS, TOOL_INPUT_INLINE_CHARS, TOOL_INPUT_PREVIEW_CHARS, TOOL_DOCUMENTS_INLINE_CHARS } from './message-preview';
export { forTransport, projectLiveMessage, projectLivePart, projectMessage, MESSAGE_SENT_MAX_BYTES, type TransportOptions } from './transport.ts';
export { boundedMessageWindow } from './message-window.ts';
export { lastAgentText, notificationExcerpt, requestExcerpt, requestKind, NOTIFICATION_TEXT_CHARS } from './notification-text';
export { nativeAgentsOfTool, collectNativeAgents } from './native-agents.ts';
export { collectProcessAgents, processAgentCommand } from './process-agents.ts';

export interface RpcMethods extends
  ComposerRpcMethods,
  AgentsRpcMethods,
  WorkflowsRpcMethods,
  BrowserRpcMethods,
  PullRequestsRpcMethods,
  MobileDevicesRpcMethods,
  WindowsRpcMethods,
  DesktopRpcMethods,
  DiagnosticsRpcMethods,
  ProvidersRpcMethods,
  AccountsRpcMethods,
  PluginsRpcMethods,
  ProjectsRpcMethods,
  ThreadsRpcMethods,
  UsageRpcMethods,
  TurnsRpcMethods,
  MessagesRpcMethods,
  PermissionsRpcMethods,
  QuestionsRpcMethods,
  SecretsRpcMethods,
  TraceRpcMethods,
  SchedulerRpcMethods,
  SettingsRpcMethods,
  SubscriptionProxyRpcMethods,
  KeybindingsRpcMethods,
  ImportsRpcMethods,
  CoreRpcMethods,
  AgentDoorRpcMethods,
  PanelRpcMethods,
  TodosRpcMethods,
  GitRpcMethods,
  FilesRpcMethods,
  PairingRpcMethods,
  SpeechRpcMethods,
  CoordinationRpcMethods,
  GroupRpcMethods,
  DelegationRpcMethods,
  BrainRpcMethods,
  HooksRpcMethods,
  SharedProjectsRpcMethods,
  TerminalsRpcMethods,
  PolicyRpcMethods {}

export type RpcMethodName = keyof RpcMethods;
export type RpcParams<M extends RpcMethodName> = RpcMethods[M]['params'];
export type RpcResult<M extends RpcMethodName> = RpcMethods[M]['result'];

export interface RpcEvents extends
  ComposerRpcEvents,
  AgentsRpcEvents,
  WorkflowsRpcEvents,
  BrowserRpcEvents,
  PullRequestsRpcEvents,
  MobileDevicesRpcEvents,
  WindowsRpcEvents,
  ProvidersRpcEvents,
  AccountsRpcEvents,
  PluginsRpcEvents,
  ProjectsRpcEvents,
  ThreadsRpcEvents,
  TurnsRpcEvents,
  MessagesRpcEvents,
  PermissionsRpcEvents,
  QuestionsRpcEvents,
  SecretsRpcEvents,
  TraceRpcEvents,
  SchedulerRpcEvents,
  SettingsRpcEvents,
  SubscriptionProxyRpcEvents,
  KeybindingsRpcEvents,
  ImportsRpcEvents,
  CoreRpcEvents,
  PanelRpcEvents,
  TodosRpcEvents,
  CoordinationRpcEvents,
  GroupRpcEvents,
  DelegationRpcEvents,
  BrainRpcEvents,
  HooksRpcEvents,
  SharedProjectsRpcEvents,
  TerminalsRpcEvents,
  PolicyRpcEvents {}

export type RpcEventName = keyof RpcEvents;

export { attachmentError, answerAttachmentError, decodedBytes } from './attachment-validation.ts';
export { AUTO_COMPACT_MOMENTS, AUTO_COMPACT_TOKENS, AUTO_GOAL_MIN_CHARS, BROWSER_ORIGINS_MAX, CACHE_KEEPALIVE_HOURS, MODEL_FAVORITES_MAX, checkSettingsPatch, compareModelFavorites, keepLaterFavorites, type AutoCompact, type AutoCompactMoment, type CacheKeepalive, type SettingsPatchCheck } from './settings-validation.ts';
export { checkRpcParams, type RpcParamsCheck } from './rpc-params.ts';
export { TITLE_MODEL_DEFAULTS, defaultTitleModel, newestModel } from './title-models.ts';
export { ChangeLog, LIST_CHANGES_IDS, listCursorProblem } from './list-changes.ts';
export { GOAL_TRACKER_DEFAULTS, GOAL_CHECKLIST_MAX_ITEMS, GOAL_CHECKLIST_SOURCE_MAX, GOAL_CHECKLIST_TEXT_MAX, defaultTrackerModel, trackerEffort, type GoalTrackerRule } from './goal-tracker.ts';
export { DEVICE_METHODS, DEVICE_EVENTS, AGENT_EVENTS, AGENT_METHODS, SUBSCRIBED_EVENTS, accessRefusal, agentHearsEvent, deviceDiffRef, eventThreadId, mayHearEvent, type AccessRefusal, type Caller } from './access.ts';
export {
  APP_LANGUAGES, CLIENT_APP_PATTERN, CLIENT_LABELS_MAX, CLIENT_LABEL_CHARS, EXPERIMENT_IDS, MACHINE_SETTINGS, REQUESTABLE_SETTINGS, REQUESTABLE_SETTING_KEYS, SETTING_REASON_MAX, SETTINGS_PAGES, SETTINGS_SECTION_PATTERN,
  checkClientPreferences, checkSettingRequest, settledExperiment, currentSetting, effectiveSetting, experimentOf, isExperimentId, isExperimentKey, isMachineSetting, isRequestableSetting, isSettingsPage, readSettings,
  sameClientPreferences, sameSetting, settingAnswerText, settledMachineSetting, settledSetting,
  type AppLanguage, type ClientPreferences, type ExperimentId, type ExperimentSettingKey, type MachineSetting, type RequestableKey, type RequestableSetting, type SettingAsk,
  type SettingMachine, type SettingNormalizer, type SettingOutcome, type SettingPlace, type SettingReading, type SettingRequestCheck, type SettingRequestParams, type SettingsPage,
  type SettingsReading,
} from './setting-requests.ts';
export {
  AGENT_AVATAR_MAX, AGENT_DAILY_BUDGET, AGENT_DOMAIN_MAX, AGENT_INSTRUCTIONS_MAX, AGENT_NAME_MAX, AGENT_PROJECTS_MAX, AGENT_SETTING_KEYS, AGENT_STATUSES,
  agentModelRef, agentModelRoute, agentProjectIds, agentSettingAnswerText, agentSettingProposal, agentSettingValue, checkAgentSettingRequest, isAgentSettingKey,
  normalizeAgentSetting, settledAgentSetting,
  type AgentSettingApplyParams, type AgentSettingAsk, type AgentSettingChoice, type AgentSettingContext, type AgentSettingKey, type AgentSettingReading,
  type AgentSettingRequestCheck, type AgentSettingRequestParams, type AgentSettingsReading, type AgentSettingsReadParams,
} from './agent-setting-requests.ts';
export {
  checkAgentCreate,
  type AgentCreateCheck, type AgentCreateContext, type AgentCreateParams, type AgentCreateResult, type AgentCreation,
} from './agent-create.ts';
export { SPEECH_CATALOGUE, SPEECH_CUSTOM_ID, SPEECH_DEFAULT_MODEL, isSpeechModelId, speechUrlProblem, type SpeechCatalogueModel, type SpeechModelTier, type SpeechBackend } from './speech-models.ts';

export { sideQuestionSnapshot } from './side-question-snapshot.ts';
export { deriveThreadCapabilities, protocolSupportsSteering, type ThreadCapabilitySnapshot } from './thread-capabilities.ts';
export { resumeAnchor, snapshotOptionsProblem } from './thread-sync.ts';
export { IMAGE_INLINE_CHARS, previewFileData, previewImageData, type ImagePreviews } from './file-preview.ts';
export { imageSize } from './image-size.ts';
export {
  VIEW_ROUTE, VIEW_MAX_BYTES, VIEW_BLOCK_MAX_BYTES, VIEW_WIDTH, VIEW_NARROW_WIDTH, VIEW_BLEED, VIEW_NARROW_BELOW, VIEW_MIN_HEIGHT, VIEW_MAX_HEIGHT, VIEW_DEFAULT_HEIGHT, VIEW_TITLE_MAX,
  VIEW_CONTENT_POLICY, VIEW_SANDBOX, VIEW_TOKENS, VIEW_HEIGHT_EXPRESSION, VIEW_GUIDE_LINE, VIEW_HELP,
  clampViewHeight, viewFrameHeight, viewThemeFragment, readViewMessage, viewDocument, viewTitleOf,
  type InlineView, type ViewCheckCapture, type ViewTheme, type ViewHostMessage, type ViewPageMessage,
} from './view.ts';

export { effectiveCompaction, type CompactionTarget, type CompactionPolicy } from './settings';

export { composerBatch, type ComposerBatch } from './composer-batch';
export { composerActivity, isComposerActivity, stableComposerValue } from './composer-activity';
export { permissionAutoDecision } from './permissions';
