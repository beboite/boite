import { app } from "$lib/app/store.svelte";
import { backend } from "$lib/backend";
import { CLI_PRESETS, type CliPreset } from "$lib/features/settings/cliPresets";
import { cliDetection } from "$lib/features/settings/cliDetection.svelte";
import { notifications } from "$lib/features/notifications/store.svelte";
import { t } from "$lib/i18n/index.svelte";
import { createChat } from "./api";
import { chatModeFor } from "./recipes";
import type { Chat, IconKey } from "$lib/types";

/**
 * Whether a chat can be started at all on this workspace.
 *
 * A chat turn is a process outside any thread, and the remote protocol keys
 * every PTY it knows by a thread the server owns. Rather than offer a button
 * that fails, the button is simply not there.
 */
export function canChat(): boolean {
  return backend().caps.chat;
}

/**
 * Which agent a new chat opens on.
 *
 * The one that can answer in bubbles is preferred over one that can only be
 * driven as a terminal — both work, and there is no reason to hand someone the
 * lesser experience by default when they expressed no preference. Within that,
 * preset order decides, which is the order the setup wizard already showed.
 */
export function defaultAgent(installed: CliPreset[] = installedAgents()) {
  return (
    installed.find((p) => chatModeFor(p.iconKey) === "json") ??
    installed.find((p) => chatModeFor(p.iconKey) === "text") ??
    installed[0] ??
    null
  );
}

/** Same list, as the key the composer draws with before a chat exists. */
export function defaultAgentKey(installed: CliPreset[]): IconKey {
  return defaultAgent(installed)?.iconKey ?? null;
}

export function installedAgents(): CliPreset[] {
  return CLI_PRESETS.filter((p) => cliDetection.found[p.executable]);
}

/**
 * Opens a new chat and shows it.
 *
 * `projectId` scopes it to a project — the agent then starts in that folder and
 * can see the code. Left out, the chat has no project, which is the case the
 * whole feature exists for: talking through an idea before there is anything to
 * open.
 *
 * `agentKey` is the composer's pick, made before there was a chat to record it
 * on. Absent, the default applies.
 *
 * The view only moves for a chat with no project. A project's chat is already
 * on screen — the project page is where it was typed — and switching away from
 * it the moment someone pressed enter would take the page out from under them.
 */
export async function startChat(
  projectId: string | null = null,
  agentKey: IconKey = null,
): Promise<Chat | null> {
  if (!canChat()) return null;
  // The probe may not have run yet on a cold start, and picking from an empty
  // answer would open a chat on nothing.
  await cliDetection.ensure();
  const installed = installedAgents();
  const agent =
    (agentKey && installed.find((p) => p.iconKey === agentKey)) || defaultAgent(installed);
  if (!agent) {
    notifications.error(t("chat.noAgents"));
    return null;
  }
  const chat = await createChat(agent.iconKey, agent.command, projectId);
  if (!chat) return null;
  app.activeChatId = chat.id;
  if (!projectId) app.view = "chat";
  return chat;
}
