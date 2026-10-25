/**
 * Every user-facing string of the UI. No literal UI text lives anywhere else.
 *
 * One file per top-level key in `./strings/en/`, so two changes to different
 * parts of the UI never edit the same file. A new key goes in the file of its
 * part; a new part is a file here and in every translation, and a line in each
 * index.
 */
import { strings as subscriptionProxy } from './strings/en/subscriptionProxy';
import { strings as settingRequest } from './strings/en/settingRequest';
import { strings as agentSettingRequest } from './strings/en/agentSettingRequest';
import { strings as remoteBrowser } from './strings/en/remoteBrowser';
import { strings as agentBrowser } from './strings/en/agentBrowser';
import { strings as devicePanel } from './strings/en/devicePanel';
import { strings as agents } from './strings/en/agents';
import { strings as previewComments } from './strings/en/previewComments';
import { strings as artifacts } from './strings/en/artifacts';
import { strings as brain } from './strings/en/brain';
import { strings as hooks } from './strings/en/hooks';
import { strings as diagnostics } from './strings/en/diagnostics';
import { strings as telemetry } from './strings/en/telemetry';
import { strings as speech } from './strings/en/speech';
import { strings as phone } from './strings/en/phone';
import { strings as mobile } from './strings/en/mobile';
import { strings as machines } from './strings/en/machines';
import { strings as group } from './strings/en/group';
import { strings as app } from './strings/en/app';
import { strings as titlebar } from './strings/en/titlebar';
import { strings as serverUpdate } from './strings/en/serverUpdate';
import { strings as desktopUpdate } from './strings/en/desktopUpdate';
import { strings as appUpdate } from './strings/en/appUpdate';
import { strings as updateAll } from './strings/en/updateAll';
import { strings as connection } from './strings/en/connection';
import { strings as threadStatus } from './strings/en/threadStatus';
import { strings as drafts } from './strings/en/drafts';
import { strings as firstRun } from './strings/en/firstRun';
import { strings as connect } from './strings/en/connect';
import { strings as drop } from './strings/en/drop';
import { strings as sidebar } from './strings/en/sidebar';
import { strings as threadMove } from './strings/en/threadMove';
import { strings as palette } from './strings/en/palette';
import { strings as imports } from './strings/en/imports';
import { strings as agentShape } from './strings/en/agentShape';
import { strings as media } from './strings/en/media';
import { strings as btw } from './strings/en/btw';
import { strings as secrets } from './strings/en/secrets';
import { strings as slash } from './strings/en/slash';
import { strings as activity } from './strings/en/activity';
import { strings as mention } from './strings/en/mention';
import { strings as notify } from './strings/en/notify';
import { strings as permissionMode } from './strings/en/permissionMode';
import { strings as permissionModeLong } from './strings/en/permissionModeLong';
import { strings as permissionModeCodex } from './strings/en/permissionModeCodex';
import { strings as thread } from './strings/en/thread';
import { strings as chat } from './strings/en/chat';
import { strings as agentMessages } from './strings/en/agentMessages';
import { strings as coordination } from './strings/en/coordination';
import { strings as resident } from './strings/en/resident';
import { strings as contextMode } from './strings/en/contextMode';
import { strings as delegation } from './strings/en/delegation';
import { strings as workflow } from './strings/en/workflow';
import { strings as composer } from './strings/en/composer';
import { strings as rightPanel } from './strings/en/rightPanel';
import { strings as changes } from './strings/en/changes';
import { strings as tasks } from './strings/en/tasks';
import { strings as board } from './strings/en/board';
import { strings as files } from './strings/en/files';
import { strings as browserTools } from './strings/en/browserTools';
import { strings as browser } from './strings/en/browser';
import { strings as browserProfiles } from './strings/en/browserProfiles';
import { strings as terminal } from './strings/en/terminal';
import { strings as trace } from './strings/en/trace';
import { strings as protection } from './strings/en/protection';
import { strings as taskManager } from './strings/en/taskManager';
import { strings as resources } from './strings/en/resources';
import { strings as install } from './strings/en/install';
import { strings as accounts } from './strings/en/accounts';
import { strings as usage } from './strings/en/usage';
import { strings as controls } from './strings/en/controls';
import { strings as settings } from './strings/en/settings';
import { strings as keyboard } from './strings/en/keyboard';
import { strings as experiments } from './strings/en/experiments';
import { strings as features } from './strings/en/features';
import { strings as quotas } from './strings/en/quotas';
import { strings as harnessUpdates } from './strings/en/harnessUpdates';
import { strings as providerSettings } from './strings/en/providerSettings';
import { strings as plugins } from './strings/en/plugins';
import { strings as time } from './strings/en/time';
import { strings as errors } from './strings/en/errors';
import { strings as units } from './strings/en/units';
import { strings as effortLevels } from './strings/en/effortLevels';
import { strings as parts } from './strings/en/parts';
import { strings as common } from './strings/en/common';
import { strings as onboarding } from './strings/en/onboarding';
import { strings as contacts } from './strings/en/contacts';
import { strings as shared } from './strings/en/shared';
import { strings as windows } from './strings/en/windows';

export const strings = {
  ...subscriptionProxy,
  ...settingRequest,
  ...agentSettingRequest,
  ...remoteBrowser,
  ...agentBrowser,
  ...devicePanel,
  ...agents,
  ...previewComments,
  ...artifacts,
  ...brain,
  ...hooks,
  ...diagnostics,
  ...telemetry,
  ...speech,
  ...phone,
  ...mobile,
  ...machines,
  ...group,
  ...app,
  ...titlebar,
  ...serverUpdate,
  ...desktopUpdate,
  ...appUpdate,
  ...updateAll,
  ...connection,
  ...threadStatus,
  ...drafts,
  ...firstRun,
  ...connect,
  ...drop,
  ...sidebar,
  ...threadMove,
  ...palette,
  ...imports,
  ...agentShape,
  ...media,
  ...btw,
  ...secrets,
  ...slash,
  ...activity,
  ...mention,
  ...notify,
  ...permissionMode,
  ...permissionModeLong,
  ...permissionModeCodex,
  ...thread,
  ...chat,
  ...agentMessages,
  ...coordination,
  ...resident,
  ...contextMode,
  ...delegation,
  ...workflow,
  ...composer,
  ...rightPanel,
  ...changes,
  ...tasks,
  ...board,
  ...files,
  ...browserTools,
  ...browser,
  ...browserProfiles,
  ...terminal,
  ...trace,
  ...protection,
  ...taskManager,
  ...resources,
  ...install,
  ...accounts,
  ...usage,
  ...controls,
  ...settings,
  ...keyboard,
  ...experiments,
  ...features,
  ...quotas,
  ...harnessUpdates,
  ...providerSettings,
  ...plugins,
  ...time,
  ...errors,
  ...units,
  ...effortLevels,
  ...parts,
  ...common,
  ...onboarding,
  ...contacts,
  ...shared,
  ...windows,
} as const;

export type Strings = typeof strings;
