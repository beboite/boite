import { app } from "$lib/app/store.svelte";
import { backend } from "$lib/backend";
import { CLI_PRESETS } from "$lib/features/settings/cliPresets";
import { cliDetection } from "$lib/features/settings/cliDetection.svelte";
import { notifications } from "$lib/features/notifications/store.svelte";
import { t } from "$lib/i18n/index.svelte";
import { createChat } from "./api";
import { chatModeFor } from "./recipes";
import type { Chat } from "$lib/types";

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
function defaultAgent() {
  const installed = CLI_PRESETS.filter((p) => cliDetection.found[p.executable]);
  return (
    installed.find((p) => chatModeFor(p.iconKey) === "json") ??
    installed.find((p) => chatModeFor(p.iconKey) === "text") ??
    installed[0] ??
    null
  );
}

/**
 * Opens a new chat and shows it.
 *
 * `projectId` scopes it to a project — the agent then starts in that folder and
 * can see the code. Left out, the chat has no project, which is the case the
 * whole feature exists for: talking through an idea before there is anything to
 * open.
 */
export async function startChat(projectId: string | null = null): Promise<Chat | null> {
  if (!canChat()) return null;
  // The probe may not have run yet on a cold start, and picking from an empty
  // answer would open a chat on nothing.
  await cliDetection.ensure();
  const agent = defaultAgent();
  if (!agent) {
    notifications.error(t("chat.noAgents"));
    return null;
  }
  const chat = await createChat(agent.iconKey, agent.command, projectId);
  if (!chat) return null;
  app.activeChatId = chat.id;
  app.view = "chat";
  return chat;
}
