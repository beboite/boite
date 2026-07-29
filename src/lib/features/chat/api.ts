import { invoke } from "@tauri-apps/api/core";
import { app } from "$lib/app/store.svelte";
import { backend } from "$lib/backend";
import type { PtyEvent } from "$lib/backend/types";
import { ptyKill } from "$lib/storage/pty";
import { addProjectByPath } from "$lib/features/project/api";
import { launchShortcut } from "$lib/features/thread/api";
import { writeTextFile } from "$lib/features/editor/api";
import { notifications } from "$lib/features/notifications/store.svelte";
import { logger } from "$lib/shared/services/logger.svelte";
import { uuid } from "$lib/shared/utils/uuid";
import { basename } from "$lib/shared/utils/path";
import { CLI_PRESETS } from "$lib/features/settings/cliPresets";
import { parseCommand, settings } from "$lib/features/settings/store.svelte";
import { mcpArgsFor } from "$lib/features/thread/agentMcp";
import { chats } from "./store.svelte";
import { recipeFor, stripAnsi } from "./recipes";
import { stagePrompt } from "./pendingPrompt";
import type { ChatEvent } from "./recipes";
import type { Chat, ChatMessage, IconKey } from "$lib/types";

/**
 * One decoder per turn, never a shared one.
 *
 * `{ stream: true }` keeps the bytes of a character split across two chunks in
 * the decoder itself, and two chats answer at the same time as soon as the user
 * opens a second one. A module-level decoder would hand chat A's half character
 * to chat B's next chunk and put mojibake in both bubbles, rarely enough to
 * look like the agent's own doing.
 */
function newDecoder(): TextDecoder {
  return new TextDecoder();
}

function nowMessage(chatId: string, role: ChatMessage["role"], text: string): ChatMessage {
  return {
    id: uuid(),
    chatId,
    role,
    text,
    raw: null,
    state: "done",
    createdAt: Date.now(),
  };
}

/**
 * Opens a chat on an agent, with a scratch directory of its own.
 *
 * The directory exists before the first turn because the agent has to run
 * somewhere, and because the handover needs a place to leave the transcript.
 * A chat bound to a project skips it and runs in the project folder, which is
 * what lets that agent actually see the code.
 */
export async function createChat(
  agentKey: IconKey,
  command: string,
  projectId: string | null = null,
): Promise<Chat | null> {
  const id = uuid();
  const parsed = parseCommand(command);
  if (!parsed.cmd) {
    notifications.error("That agent has no command to run");
    return null;
  }

  let cwd: string;
  const project = projectId ? app.projects.find((p) => p.id === projectId) : null;
  if (project) {
    cwd = project.cwd;
  } else {
    try {
      cwd = await invoke<string>("chat_dir", { chatId: id });
    } catch (err) {
      logger.error("chat", "could not make a directory for the chat", String(err));
      notifications.error("Could not start a chat");
      return null;
    }
  }

  const chat: Chat = {
    id,
    title: null,
    agentKey,
    cmd: parsed.cmd,
    args: parsed.args,
    cwd,
    projectId: projectId ?? null,
    // Empty until an agent has actually written a session. The first turn is
    // what creates one, and only then is there anything to resume.
    sessionId: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  await chats.upsert(chat);
  await chats.ensureMessages(id);
  return chat;
}

export async function removeChat(chatId: string): Promise<void> {
  const chat = chats.byId(chatId);
  // A turn still running holds a process in a directory about to be deleted.
  await stopTurn(chatId);
  await chats.remove(chatId);
  // Only a chat that made one: a chat scoped to a project runs in the user's
  // own folder, and there is nothing here that gets to delete that.
  if (chat && !chat.projectId) {
    await invoke("chat_dir_remove", { chatId }).catch((err) => {
      logger.warn("chat", `could not remove the directory of ${chatId}`, String(err));
    });
  }
}

/**
 * Asks the chat's agent one question and fills a bubble with the answer.
 *
 * One process per turn, always — that is what makes every agent reachable with
 * no per-agent process management. What differs is only how the output is read
 * (see `recipes.ts`): parsed events, plain stdout, or kept as raw bytes for a
 * terminal to draw.
 */
export async function sendTurn(chatId: string, prompt: string): Promise<void> {
  const chat = chats.byId(chatId);
  if (!chat) return;
  const text = prompt.trim();
  if (!text || chats.running[chatId]) return;

  await chats.append(nowMessage(chatId, "user", text));
  // The first thing asked names the chat until the user says otherwise; a list
  // of "New chat" tells them nothing about which is which.
  if (!chat.title) {
    chat.title = text.length > 60 ? `${text.slice(0, 57)}…` : text;
  }
  chat.updatedAt = Date.now();
  await chats.upsert({ ...chat });

  const recipe = recipeFor(chat.agentKey);
  const answer: ChatMessage = {
    id: uuid(),
    chatId,
    role: "agent",
    text: "",
    raw: recipe ? null : "",
    state: "streaming",
    createdAt: Date.now(),
  };
  await chats.append(answer);
  chats.setRunning(chatId, true);

  // A session the agent has written to is resumed; one it has never seen is
  // named. Only the CLIs that accept a name get one, and only on the turn that
  // creates it — replaying `--resume` against an id nothing wrote fails the
  // turn with a message about a conversation that was never there.
  const newSessionId = !chat.sessionId && recipe?.mintsSession ? uuid() : null;
  // The same registration a thread gets, and the reason the handover tools are
  // reachable at all: without it the agent has the credentials in its
  // environment and no server to present them to. Honours the same setting —
  // one endpoint, one switch — so a user who turned agent access off gets a
  // chat that talks and never proposes anything.
  const mcp = await mcpArgsFor(chat.agentKey, settings.state.agentTodoAccess);
  const args = recipe
    ? [
        ...chat.args,
        ...mcp,
        ...recipe.args({ prompt: text, sessionId: chat.sessionId, newSessionId }),
      ]
    : [...chat.args, ...mcp];

  try {
    await runTurn(chat, args, answer.id, !recipe, text);
  } catch (err) {
    logger.error("chat", `turn failed in ${chatId}`, String(err));
    chats.patch(chatId, answer.id, { state: "error", text: String(err) });
  } finally {
    chats.setRunning(chatId, false);
    const finished = chats.current(chatId, answer.id);
    if (finished) {
      // A turn that ended with nothing to show is a failure however the process
      // exited: an empty bubble reads as an answer, and it is not one.
      const empty = !finished.text.trim() && !finished.raw?.trim();
      const settled: ChatMessage = {
        ...finished,
        state:
          finished.state !== "streaming" ? finished.state : empty ? "error" : "done",
        text: finished.text || (empty ? "the agent produced no output" : ""),
      };
      chats.patch(chatId, answer.id, settled);
      await chats.persist(settled);
      // Recorded only once the turn actually produced something: an id kept
      // after a failed first turn would be resumed on the next one, and there
      // would be nothing under it to resume.
      if (newSessionId && settled.state === "done") {
        await chats.upsert({ ...chats.byId(chatId)!, sessionId: newSessionId });
      }
    }
    // The handover proposal is written by the agent endpoint, straight into the
    // table, so the only way to see it is to look again once the turn is over.
    await chats.refreshMessages(chatId);
  }
}

/** PTYs of turns still running, so a chat can be stopped. */
const livePty = new Map<string, string>();

export async function stopTurn(chatId: string): Promise<void> {
  const key = livePty.get(chatId);
  if (!key) return;
  await ptyKill(key, true).catch(() => {});
}

/**
 * Spawns one turn and resolves when the process exits.
 *
 * The PTY is 200 columns wide on purpose: agents wrap their output to the
 * terminal, and a bubble that reflows would inherit hard line breaks taken at
 * 80. It is a pipe with a size, not a screen anyone looks at.
 */
function runTurn(
  chat: Chat,
  args: string[],
  messageId: string,
  rawMode: boolean,
  prompt: string,
): Promise<void> {
  const recipe = recipeFor(chat.agentKey);
  return new Promise((resolve, reject) => {
    let settled = false;
    let pending = "";
    let streamed = "";
    const decoder = newDecoder();

    const finish = (err?: unknown) => {
      if (settled) return;
      settled = true;
      livePty.delete(chat.id);
      if (err) reject(err);
      else resolve();
    };

    const onEvent = (event: PtyEvent) => {
      if (event.type === "error") {
        chats.patch(chat.id, messageId, { state: "error", text: event.message });
        finish();
        return;
      }
      if (event.type === "exit") {
        // Flush whatever the last chunk left without a newline behind it.
        if (pending) consumeLine(pending);
        finish();
        return;
      }
      if (event.type !== "output") return;

      const chunk = decoder.decode(event.bytes, { stream: true });
      if (rawMode) {
        const current = chats.current(chat.id, messageId);
        chats.patch(chat.id, messageId, { raw: (current?.raw ?? "") + chunk });
        return;
      }
      if (recipe?.mode === "text") {
        streamed += chunk;
        chats.patch(chat.id, messageId, { text: stripAnsi(streamed).trim() });
        return;
      }
      // `json`: the unit is a line, and a chunk boundary lands mid-line often
      // enough that parsing chunks would drop roughly every long answer.
      pending += chunk;
      let at = pending.indexOf("\n");
      while (at >= 0) {
        consumeLine(pending.slice(0, at));
        pending = pending.slice(at + 1);
        at = pending.indexOf("\n");
      }
    };

    const consumeLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed || !recipe?.read) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        // Not every line is an event: CLIs print warnings and progress on the
        // same stream. Skipping is right — surfacing them as the answer is how
        // a bubble ends up containing a deprecation notice.
        return;
      }
      const event = recipe.read(parsed);
      if (!event) return;
      applyEvent(event);
    };

    const applyEvent = (event: ChatEvent) => {
      switch (event.kind) {
        case "text":
          streamed += event.text;
          chats.patch(chat.id, messageId, { text: streamed });
          break;
        case "session":
          if (chat.sessionId !== event.id) {
            chat.sessionId = event.id;
            void chats.upsert({ ...chat });
          }
          break;
        case "done":
          if (!streamed && event.text) {
            streamed = event.text;
            chats.patch(chat.id, messageId, { text: streamed });
          }
          break;
        case "error":
          // Whatever the agent already said survives: a turn that answered and
          // then hit a limit still answered, and replacing that with the
          // reason throws away the only part anyone wanted. The reason goes to
          // the log, which is where a failure nobody can act on belongs.
          if (!streamed && event.text) streamed = event.text;
          logger.warn("chat", `${chat.id}: turn ended with ${event.message}`, {
            agent: chat.agentKey,
          });
          chats.patch(chat.id, messageId, {
            state: "error",
            text: streamed || event.message,
          });
          break;
      }
    };

    backend()
      .pty.spawn(
        {
          cwd: chat.cwd,
          cmd: chat.cmd,
          // A fallback agent's args carry no prompt: it has no flag to put one
          // in. The message is typed into its TUI below instead.
          args,
          cols: 200,
          rows: 50,
        },
        chat.id,
        onEvent,
      )
      .then((ptyKey) => {
        livePty.set(chat.id, ptyKey);
        if (rawMode) void typeIntoFallback(ptyKey, prompt);
      })
      .catch(finish);
  });
}

/**
 * Types the message into an agent that has no print mode, once its TUI is up.
 *
 * A newline IS sent here, unlike everywhere else in Boite: the user already
 * pressed enter in the composer, and a message that sits unsent in a terminal
 * nobody is looking at is not a chat. The delay is for the TUI to finish
 * drawing — keystrokes sent into a screen that is still initialising are eaten.
 */
async function typeIntoFallback(ptyKey: string, prompt: string) {
  const { ptyWrite } = await import("$lib/storage/pty");
  const encoder = new TextEncoder();
  await new Promise((r) => setTimeout(r, 1200));
  const oneLine = prompt.replace(/\s*[\r\n]+\s*/g, " ").trim();
  await ptyWrite(ptyKey, encoder.encode(oneLine)).catch(() => {});
  await new Promise((r) => setTimeout(r, 120));
  await ptyWrite(ptyKey, encoder.encode("\r")).catch(() => {});
}

/** What the agent proposed, when a system message carries a proposal. */
export interface Handover {
  path: string | null;
  name: string | null;
  projectId: string | null;
  prompt: string | null;
}

/**
 * Reads a handover out of a system message, or gives back null.
 *
 * System messages are stored as the JSON the endpoint wrote, so this is where
 * that shape is checked rather than trusted. Anything that does not match is
 * not a proposal and is drawn as plain text.
 */
export function readHandover(message: ChatMessage): Handover | null {
  if (message.role !== "system") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(message.text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const raw = parsed as Record<string, unknown>;
  if (raw.kind !== "handover") return null;
  const text = (key: string) =>
    typeof raw[key] === "string" && raw[key] ? (raw[key] as string) : null;
  const handover = {
    path: text("path"),
    name: text("name"),
    projectId: text("projectId"),
    prompt: text("prompt"),
  };
  return handover.path || handover.projectId ? handover : null;
}

/**
 * Does what the agent asked for, now that the user has said yes.
 *
 * Everything the proposal could not be trusted with happens here, on this side
 * of the click: creating the directory, registering the project — which widens
 * the filesystem boundary the explorer and the editor are checked against — and
 * opening a terminal in it.
 */
export async function acceptHandover(
  chatId: string,
  handover: Handover,
): Promise<boolean> {
  const chat = chats.byId(chatId);
  if (!chat) return false;

  let projectId = handover.projectId;
  if (!projectId) {
    if (!handover.path) return false;
    try {
      await invoke("create_project_dir", { path: handover.path });
    } catch (err) {
      notifications.error(String(err));
      return false;
    }
    const project = await addProjectByPath(handover.path);
    if (!project) return false;
    projectId = project.id;
  }

  // Into the project, not the chat's scratch directory: deleting the chat takes
  // that directory with it, and the terminal would be left pointing at a file
  // that used to exist. It lands where the conversation it describes now lives,
  // which is also where someone would look for it.
  const target = app.projects.find((p) => p.id === projectId);
  const transcript = await exportTranscript(chatId, target?.cwd ?? chat.cwd);
  const preset = CLI_PRESETS.find((p) => p.iconKey === chat.agentKey);
  const thread = await launchShortcut(
    {
      id: uuid(),
      label: preset?.label ?? "Agent",
      command: preset?.command ?? `${chat.cmd} ${chat.args.join(" ")}`.trim(),
      iconKey: chat.agentKey,
    },
    projectId,
  );
  if (!thread) return false;

  // The transcript is the whole point of the handover: the terminal picks the
  // conversation up from a file Boite wrote itself, so this works the same for
  // an agent whose session format nothing here can read.
  const opening = [
    transcript
      ? `Continue this conversation. It is transcribed at ${transcript}.`
      : "Continue the conversation this terminal was opened from.",
    handover.prompt,
  ]
    .filter(Boolean)
    .join(" ");
  stagePrompt(thread.id, opening);

  await chats.upsert({ ...chat, projectId, updatedAt: Date.now() });
  return true;
}

/**
 * Writes the conversation next to the chat, and answers with the path.
 *
 * Markdown, and Boite's own copy: in bubble mode it received every turn itself,
 * so the transcript owes nothing to any agent's private session format. Null
 * when it could not be written — the handover still goes ahead, because a
 * terminal with no transcript is worse than no terminal only slightly.
 */
export async function exportTranscript(
  chatId: string,
  dir: string,
): Promise<string | null> {
  await chats.ensureMessages(chatId);
  const chat = chats.byId(chatId);
  const messages = chats.messages[chatId] ?? [];
  const body = messages
    .filter((m) => m.role !== "system")
    .map((m) => {
      const who = m.role === "user" ? "User" : chat?.agentKey ?? "Agent";
      return `## ${who}\n\n${m.text || m.raw || ""}`;
    })
    .join("\n\n");
  const path = `${dir}/boite-chat-${chatId.slice(0, 8)}.md`;
  const header = `# ${chat?.title ?? "Chat"}\n\n`;
  try {
    await writeTextFile(path, header + body + "\n");
    return path;
  } catch (err) {
    logger.warn("chat", `could not write the transcript for ${chatId}`, String(err));
    return null;
  }
}

/** A folder name to suggest when the agent proposed a path. */
export function suggestedName(handover: Handover): string {
  return handover.name ?? (handover.path ? basename(handover.path) : "project");
}
