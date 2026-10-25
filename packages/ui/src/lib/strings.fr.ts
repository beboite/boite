/*
 * Le catalogue français, calqué sur `strings.en.ts`, un fichier par clé de
 * premier niveau dans `./strings/fr/`, nommé comme son modèle anglais.
 *
 * Le type vient de l'anglais : une clé inconnue de l'anglais arrête
 * `svelte-check`. Une phrase pas encore traduite peut manquer ici, elle
 * s'affiche alors en anglais (`lib/i18n.svelte.ts`) et passe en nightly, mais
 * `scripts/ci/translations.ts --release` bloque la release tant qu'elle manque.
 * Les accolades sont des emplacements remplis par `fill`, leur nom ne se
 * traduit pas.
 */
import type { Translation } from './i18n.svelte';
import { fr as subscriptionProxy } from './strings/fr/subscriptionProxy';
import { fr as settingRequest } from './strings/fr/settingRequest';
import { fr as agentSettingRequest } from './strings/fr/agentSettingRequest';
import { fr as remoteBrowser } from './strings/fr/remoteBrowser';
import { fr as agentBrowser } from './strings/fr/agentBrowser';
import { fr as devicePanel } from './strings/fr/devicePanel';
import { fr as agents } from './strings/fr/agents';
import { fr as previewComments } from './strings/fr/previewComments';
import { fr as artifacts } from './strings/fr/artifacts';
import { fr as brain } from './strings/fr/brain';
import { fr as hooks } from './strings/fr/hooks';
import { fr as diagnostics } from './strings/fr/diagnostics';
import { fr as telemetry } from './strings/fr/telemetry';
import { fr as speech } from './strings/fr/speech';
import { fr as phone } from './strings/fr/phone';
import { fr as mobile } from './strings/fr/mobile';
import { fr as machines } from './strings/fr/machines';
import { fr as group } from './strings/fr/group';
import { fr as app } from './strings/fr/app';
import { fr as titlebar } from './strings/fr/titlebar';
import { fr as serverUpdate } from './strings/fr/serverUpdate';
import { fr as desktopUpdate } from './strings/fr/desktopUpdate';
import { fr as appUpdate } from './strings/fr/appUpdate';
import { fr as updateAll } from './strings/fr/updateAll';
import { fr as connection } from './strings/fr/connection';
import { fr as threadStatus } from './strings/fr/threadStatus';
import { fr as drafts } from './strings/fr/drafts';
import { fr as firstRun } from './strings/fr/firstRun';
import { fr as connect } from './strings/fr/connect';
import { fr as drop } from './strings/fr/drop';
import { fr as sidebar } from './strings/fr/sidebar';
import { fr as threadMove } from './strings/fr/threadMove';
import { fr as palette } from './strings/fr/palette';
import { fr as imports } from './strings/fr/imports';
import { fr as agentShape } from './strings/fr/agentShape';
import { fr as media } from './strings/fr/media';
import { fr as btw } from './strings/fr/btw';
import { fr as secrets } from './strings/fr/secrets';
import { fr as slash } from './strings/fr/slash';
import { fr as activity } from './strings/fr/activity';
import { fr as mention } from './strings/fr/mention';
import { fr as notify } from './strings/fr/notify';
import { fr as permissionMode } from './strings/fr/permissionMode';
import { fr as permissionModeLong } from './strings/fr/permissionModeLong';
import { fr as permissionModeCodex } from './strings/fr/permissionModeCodex';
import { fr as thread } from './strings/fr/thread';
import { fr as chat } from './strings/fr/chat';
import { fr as agentMessages } from './strings/fr/agentMessages';
import { fr as coordination } from './strings/fr/coordination';
import { fr as resident } from './strings/fr/resident';
import { fr as contextMode } from './strings/fr/contextMode';
import { fr as delegation } from './strings/fr/delegation';
import { fr as workflow } from './strings/fr/workflow';
import { fr as composer } from './strings/fr/composer';
import { fr as rightPanel } from './strings/fr/rightPanel';
import { fr as changes } from './strings/fr/changes';
import { fr as tasks } from './strings/fr/tasks';
import { fr as board } from './strings/fr/board';
import { fr as files } from './strings/fr/files';
import { fr as browserTools } from './strings/fr/browserTools';
import { fr as browser } from './strings/fr/browser';
import { fr as browserProfiles } from './strings/fr/browserProfiles';
import { fr as terminal } from './strings/fr/terminal';
import { fr as trace } from './strings/fr/trace';
import { fr as protection } from './strings/fr/protection';
import { fr as taskManager } from './strings/fr/taskManager';
import { fr as resources } from './strings/fr/resources';
import { fr as install } from './strings/fr/install';
import { fr as accounts } from './strings/fr/accounts';
import { fr as usage } from './strings/fr/usage';
import { fr as controls } from './strings/fr/controls';
import { fr as settings } from './strings/fr/settings';
import { fr as keyboard } from './strings/fr/keyboard';
import { fr as experiments } from './strings/fr/experiments';
import { fr as features } from './strings/fr/features';
import { fr as quotas } from './strings/fr/quotas';
import { fr as harnessUpdates } from './strings/fr/harnessUpdates';
import { fr as providerSettings } from './strings/fr/providerSettings';
import { fr as plugins } from './strings/fr/plugins';
import { fr as time } from './strings/fr/time';
import { fr as errors } from './strings/fr/errors';
import { fr as units } from './strings/fr/units';
import { fr as effortLevels } from './strings/fr/effortLevels';
import { fr as parts } from './strings/fr/parts';
import { fr as common } from './strings/fr/common';
import { fr as onboarding } from './strings/fr/onboarding';
import { fr as contacts } from './strings/fr/contacts';
import { fr as shared } from './strings/fr/shared';
import { fr as windows } from './strings/fr/windows';

export const fr: Translation = {
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
};
