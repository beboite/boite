import type { ThreadLink } from './agent-door';
import type { AgentSettingAsk } from './agent-setting-requests.ts';
import type { ImageMimeType } from './attachment-limits.ts';
import type { NativeAgentUpdate } from './delegation';
import type { MessageId, ProjectId, RequestId, ThreadId, Timestamp, TurnId } from './ids';
import type { RpcMethods } from './index';
import type { QuestionAnswer, QuestionOption } from './questions';
import type { SecretRequestStatus } from './secrets';
import type { AppLanguage, SettingAsk } from './setting-requests.ts';
import type { ActivityTurn } from './threads';
import type { TeamAsk, TeamPostRef } from './teams';
import type { Turn } from './turns';
import type { InlineView, ViewCheckCapture } from './view.ts';
import type { WindowCaptureKind, WindowConsentAnswer } from './windows';

export type MessageRole = 'user' | 'assistant' | 'system';

export type ToolStatus = 'running' | 'done' | 'error' | 'denied';

/** What a tool call produced or changed, shown under the card's input and output. */
export type ToolDocument =
  /** A file the tool wrote: the two texts, the UI computes the line diff. */
  | { kind: 'diff'; path: string; oldText: string; newText: string }
  | { kind: 'markdown'; title: string | null; text: string }
  /** `data` is base64 with no `data:` prefix. The core caps it before it is journalled. */
  | { kind: 'image'; mimeType: string; data: string; alt: string | null };

/**
 * An image sent with a prompt. `data` is base64 with no `data:` prefix. The
 * core refuses one over `ATTACHMENT_MAX_BYTES`, more than `ATTACHMENTS_PER_TURN`
 * of them, a format outside `IMAGE_MIME_TYPES`, and any of them on a provider
 * whose `capabilities.images` is false, each by name.
 */
export interface ImageAttachment {
  kind: 'image';
  mimeType: ImageMimeType;
  data: string;
  /** The file name when it came from one, for the timeline's tooltip. */
  name: string | null;
}

/** A file uploaded to the core and made available to the agent as a local path. */
export interface FileAttachment {
  kind: 'file';
  mimeType: string;
  data: string;
  name: string | null;
}

export type Attachment = ImageAttachment | FileAttachment;

/** A user-selected element. Page text is untrusted context, never instructions. */
export interface PreviewReference {
  id: string;
  url: string;
  selector: string;
  shadowPath?: string[];
  text: string;
  bounds: { x: number; y: number; width: number; height: number };
  surfaceId?: string;
  /** UTF-16 offsets of the visible mention in the prompt/displayText. */
  mention?: { start: number; end: number };
}

/** One end of a thread move: the project and the folder the agent works in. */
export interface MoveEnd {
  projectId: ProjectId;
  /** The project's display name when the move happened. */
  name: string;
  cwd: string;
}

/**
 * Carried by the first user message after `threads.move`: where the thread
 * came from and where it works now. `note` is the plain sentence the core
 * put before the prompt for the agent; the UI shows a marker line instead.
 * Several moves before that message keep the first `from` and the last `to`.
 * With `by: 'agent'` it rides on a system message instead: the agent moved
 * its own thread (`agent.move`), nothing was put before a prompt, and `note`
 * is only what a fresh session's history says about it.
 */
export interface MoveNotice {
  from: MoveEnd;
  to: MoveEnd;
  note: string;
  by?: 'agent';
  /** Epoch milliseconds of the last move. */
  at: number;
}

/** A move waiting for the thread's turn to end (`ThreadSummary.pendingMove`). */
export interface PendingMove {
  projectId: ProjectId;
  /** The target project's name, for the row's "Moves to ... after this turn". */
  project: string;
  /** Who asked: the user from a menu or a drag, or the agent with `boite thread move`. */
  by: 'user' | 'agent';
  /** Epoch milliseconds of the request. */
  at: number;
}

/** Outgoing files live on disk above the inline attachment limit. */
export const ARTIFACT_MAX_BYTES = 512 * 1024 * 1024;
export interface ArtifactContent { url: string; bytes: number; mimeType: string; name: string; }

/**
 * The app a user prompt was sent from, as its connection said hello
 * (`hello` `client`). Carried by the prompt's text part and never shown: the
 * core tells the agent in one line when a session starts and when the
 * origin changes. `device` is the computer's name for the shell, `phone` or
 * `browser` for the web app, null when the client did not say.
 */
export interface SentFrom {
  client: 'shell' | 'pwa';
  device: string | null;
  /** The language the app spoke when the prompt left it (`client.preferences`); unset when it had not said. */
  language?: AppLanguage;
}

/** The longest `hello` `client.device` the core keeps. */
export const CLIENT_DEVICE_MAX = 64;

export type MessagePart =
  /**
   * `omitted`: characters a page left out of the end of `text` because the
   * message was too heavy to send whole (`MESSAGE_SENT_MAX_BYTES`). Never persisted.
   */
  | { type: 'text'; text: string; complete?: boolean; displayText?: string; previewReferences?: PreviewReference[]; activity?: ActivityTurn; moved?: MoveNotice; startedBy?: ThreadLink; started?: ThreadLink; sentFrom?: SentFrom; omitted?: number; teamPost?: TeamPostRef }
  /**
   * An image the user sent with the prompt, journalled with the message. A page
   * asked with `compactImages` leaves a large one's `data` empty, with
   * `dataDeferred` and its decoded `bytes`: `messages.attachment` reads it.
   * Such a page also gives it `width` and `height`, the size it is drawn at,
   * read from its header with JPEG's EXIF orientation applied, and `preview`,
   * a ThumbHash blur of at most 32 px as a `data:image/png` URL, once the core
   * made one. Never persisted.
   */
  | { type: 'image'; mimeType: ImageMimeType; data: string; alt: string | null; dataDeferred?: true; bytes?: number; width?: number; height?: number; preview?: string }
  /** A deferred picture file (`previewFileData`) carries `width`, `height` and `preview` as a deferred image does. */
  | { type: 'file'; mimeType: string; data: string; name: string | null; dataDeferred?: true; bytes?: number; width?: number; height?: number; preview?: string }
  /**
   * An immutable published file; resolve its bytes with artifacts.read, never as a disk path.
   * With `view` it is a page the agent published with `boite view`: a client draws it at the
   * end of its turn instead of a file card, and one that does not know the field still offers
   * the download.
   */
  | { type: 'artifact'; id: string; mimeType: string; bytes: number; name: string; view?: InlineView }
  /** The model's reasoning as the provider streams it, folded in the UI. */
  | { type: 'thinking'; text: string; startedAt?: Timestamp; finishedAt?: Timestamp | null; omitted?: number }
  | {
      type: 'tool';
      toolId: string;
      name: string;
      input: unknown;
      /** The input's JSON as the model streams it, before `input` is complete. Absent or null once `input` is final. */
      inputText?: string | null;
      output: string | null;
      /** A bounded output preview. Fetch messages.toolPart when its disclosure opens. Never persisted. */
      outputDeferred?: true;
      /** `input` is a preview cut to its first strings and entries (`compactToolParts`). Never persisted. */
      inputDeferred?: true;
      /** `documents` are stubs with their kind, path, title or caption and no content (`compactToolParts`). Never persisted. */
      documentsDeferred?: true;
      status: ToolStatus;
      /** A command's exit code when the provider reports it. Absent on older rows and other tools. */
      exitCode?: number | null;
      /**
       * The agent's own one-line account of the calls this one ran with ("Read
       * rules.md and data.txt"), written after they finished. Claude's
       * `tool_use_summary`; absent for other agents and on older rows.
       */
      summary?: string;
      /** Provider-reported child activity. These are not Boite thread IDs or team budget entries. */
      nativeAgents?: NativeAgentUpdate[];
      /** What the call produced or changed, under the input and the output. Absent on a journal row written before documents existed. */
      documents?: ToolDocument[];
      /** Stamped by the core when the card first shows up, for every driver. Absent on older rows. */
      startedAt?: Timestamp;
      /** Stamped by the core when the status leaves `running`. */
      finishedAt?: Timestamp | null;
    }
  | { type: 'permission'; requestId: RequestId; toolName: string; decision: 'allow' | 'deny' | null }
  /**
   * A free-form question the agent asked. The card is answered from the
   * timeline, and `answer` is written back into the part once it is. Null or
   * absent means it is still waiting.
   */
  | {
      type: 'question';
      questionId: RequestId;
      text: string;
      options: QuestionOption[];
      /** A question with no options and this true is a plain free-text prompt. */
      allowText: boolean;
      multiple: boolean;
      answer?: QuestionAnswer | null;
      /** Asked without stopping: see `QuestionRequest.async`. */
      async?: boolean;
      /** A settings card: see `QuestionRequest.setting`. */
      setting?: SettingAsk;
      /** An agent setting card: see `QuestionRequest.agentSetting`. */
      agentSetting?: AgentSettingAsk;
      /** A bot's team proposal: see `QuestionRequest.team`. */
      team?: TeamAsk;
      /** A page to open: see `QuestionRequest.open`. */
      open?: { url: string };
    }
  /**
   * A secret card (`boite secret ask`): the name, the reason and how it ended,
   * never the value. Answered with `secrets.answer`; `status` and `ref` are
   * written back once it closes.
   */
  | {
      type: 'secret_request';
      requestId: RequestId;
      name: string;
      reason: string;
      placeholder: string | null;
      status: SecretRequestStatus;
      ref: string | null;
      /** It replaces a key kept for the project. */
      replace?: boolean;
      /** The user kept it for the project. */
      kept?: boolean;
      expiresAt?: Timestamp;
    }
  /**
   * The agent compacted its context mid-turn: what it held before, what is
   * left after when it says so. Drawn as a divider in the timeline.
   * `background`: the summary was made ahead, on a copy of the session, and
   * the thread switched to it between turns (`backgroundCompaction`).
   */
  | { type: 'compaction'; trigger: 'auto' | 'manual'; preTokens: number | null; postTokens: number | null; background?: true }
  /**
   * One of the user's own hooks ended the turn: it blocked the prompt, or told
   * the agent to stop. `event` is the agent's own name for the hook event. A
   * hook that denied a tool call shows on that tool's card instead.
   */
  | { type: 'hook'; event: string; outcome: 'blocked' | 'stopped'; message: string }
  /**
   * A native window an agent captured with `boite window`, or whose stream a
   * viewer started in the Window panel: no capture is silent. `thumbnail` is a
   * JPEG of at most `WINDOW_THUMBNAIL_MAX` pixels as base64, null when it could
   * not be made; `path` is the file the agent asked for, `width` and `height`
   * that file's size (the window's for a stream).
   */
  | { type: 'window_capture'; kind: WindowCaptureKind; windowId: string; process: string; width: number; height: number; at: Timestamp; thumbnail: { data: string; width: number; height: number } | null; path?: string; frames?: number }
  /**
   * An agent asked to capture an app the project does not allow: the owner
   * answers Allow once, Always for this project or Refuse. `answer` is null
   * while the capture waits, `expired` once `expiresAt` passed or the core
   * restarted. The window's title is left out: the agent can read its thread.
   */
  | { type: 'window_consent'; requestId: string; kind: WindowCaptureKind; process: string; path: string; expiresAt: Timestamp; answer: WindowConsentAnswer | 'expired' | null }
  | { type: 'error'; message: string };

export interface Message {
  id: MessageId;
  threadId: ThreadId;
  turnId: TurnId;
  role: MessageRole;
  parts: MessagePart[];
  state: 'streaming' | 'complete' | 'error';
  createdAt: Timestamp;
}

/** The default page size of `threads.get` and `messages.list` when no limit is supplied. */
export const MESSAGE_PAGE = 120;
/** The first paint needs a small tail; older history uses the ordinary page size. */
export const INITIAL_MESSAGE_PAGE = 40;
/**
 * The core's generic notification body, named so a phone can show it in the
 * language it speaks: the service worker looks the label up in the words the
 * page left it, and falls back on the English body.
 */
export type NotificationLabel = 'done' | 'failed' | 'needsYou' | 'connected' | 'limitFiveHour' | 'limitWeekly';
/**
 * What a notification is about, the unit a device turns on or off: a
 * permission or a change to approve, a question, a finished turn, a failed
 * one, a subscription limit crossing its alert threshold.
 */
export type NotificationKind = 'approvals' | 'questions' | 'finished' | 'errors' | 'limits';
/** Every kind, in the order the settings list them. A device that never chose gets them all. */
export const NOTIFICATION_KINDS: readonly NotificationKind[] = ['approvals', 'questions', 'finished', 'errors', 'limits'];
/** A Web Push payload, as the core sends it and the service worker reads it. */
export interface PushPayload {
  title: string;
  body: string;
  threadId: string | null;
  tag: string;
  label?: NotificationLabel;
  /** What the notification is about; the test notification has none. */
  kind?: NotificationKind;
  /** The app icon's count after this notification. */
  badge?: number;
  /** What a label's words leave a place for: `{percent}` in a limit alert. */
  values?: { percent: string };
  /**
   * The id of the machine the thread is on. Every push to a device of the
   * group carries it, direct or passed on by another member through the
   * device's push home: the app's own page belongs to no machine and opens the
   * thread there. A key of the older kind gets it only when passed on.
   */
  core?: string;
}
/** The most `messages.list` will ever hand back in one call, whatever `limit` says. */
export const MESSAGE_PAGE_MAX = 200;
/**
 * Serialized UTF-8 bytes of a page's message array, including its brackets and
 * commas, shared by both halves of a page around a saved reading position.
 * One complete message may exceed this budget to advance pagination,
 * provided the full RPC response still fits `RPC_MAX_FRAME_BYTES`. A reconnect
 * tail must fit this budget in full; otherwise `threads.get` returns a page.
 */
export const MESSAGE_PAGE_MAX_BYTES = 12 * 1024 * 1024;
/**
 * The `maxBytes` of a first visit: about what a desktop screen draws, once
 * successful tool outputs stay on the core. Forty messages of one long thread
 * weighed 9.5 MB on 2026-10-13, for one screen of answers and folded runs.
 */
export const INITIAL_PAGE_BYTES = 128 * 1024;
/** The `maxBytes` of each page a reader scrolls into, above or below the window. */
export const READING_PAGE_BYTES = 256 * 1024;
/** Why a `maxBytes` is refused, or null: a positive whole count of bytes. */
export function pageBytesProblem(maxBytes: unknown): { field: 'maxBytes'; expected: string } | null {
  return maxBytes === undefined || (Number.isSafeInteger(maxBytes) && (maxBytes as number) > 0) ? null
    : { field: 'maxBytes', expected: 'a positive integer count of serialized UTF-8 bytes' };
}
/** The byte budget a page read with `maxBytes` gets: never above `MESSAGE_PAGE_MAX_BYTES`. */
export function pageBytes(maxBytes: number | undefined): number {
  return maxBytes === undefined ? MESSAGE_PAGE_MAX_BYTES : Math.min(maxBytes, MESSAGE_PAGE_MAX_BYTES);
}
/** The longer side, in pixels, of the copy `messages.attachment` sends with `display`. */
export const DISPLAY_IMAGE_MAX = 1280;
/**
 * The longer side of the copy `messages.attachment` sends with `display` and
 * `thumb`: a prompt's thumbnail is 88 px tall and at most 1.8 times as wide,
 * so 320 px stays sharp on a 2x screen with 16 times fewer pixels than 1,280.
 */
export const DISPLAY_THUMB_MAX = 320;

export interface MessagesRpcMethods {
  /** Explicitly publish a bounded file snapshot from this thread's working directory. */
  'artifacts.publish': { params: { threadId: ThreadId; path: string }; result: Message };
  /**
   * `view: true` asks for the address a published view opens as a page at
   * (`VIEW_ROUTE`), which only an artifact carrying `view` has; without it the
   * address downloads.
   */
  'artifacts.read': { params: { threadId: ThreadId; messageId: MessageId; artifactId: string; renew?: string; view?: true }; result: ArtifactContent };
  /**
   * Publish an HTML page of this thread's working directory as an inline view
   * (`boite view`). Local files it names are embedded, a remote resource or a
   * script error refuses it with the reason, and `checked` says whether a
   * headless browser loaded it on this machine before it was accepted.
   * `advice` is what would make the page look more like the app (a fixed
   * color, a font of its own): it never refuses a publish.
   */
  'artifacts.view': { params: { threadId: ThreadId; path: string; title?: string }; result: { message: Message; checked: boolean; advice: string[] } };
  /** Render a private draft with the view kit; optionally run an async DOM check at each width. Publishes nothing. */
  'artifacts.viewCheck': { params: { threadId: ThreadId; path: string; script?: string; scheme?: 'dark' | 'light' }; result: { checked: boolean; errors: string[]; advice: string[]; captures: ViewCheckCapture[] } };
  /**
   * The address (`VIEW_ROUTE`) where a ```` ```view ```` block of an answer
   * opens as a page: its HTML, at most `VIEW_BLOCK_MAX_BYTES`, wrapped like a
   * published view (policy, theme, kit) and held in memory, never on disk or
   * in the journal. The same HTML keeps its address while the ticket lives.
   */
  'artifacts.viewBlock': { params: { html: string }; result: { url: string } };
  'artifacts.preview': { params: { threadId: ThreadId; path: string }; result: { url: string; shown: boolean } };
  'artifacts.previewClose': { params: { threadId: ThreadId; path: string }; result: { ok: true } };
  /** Push credentials are owned by the authenticated pairing, never a caller-supplied session id. */
  /** `kinds` is what this device's subscription receives, every kind when it never chose. */
  'push.status': { params: Record<string, never>; result: { publicKey: string; subscribed: boolean; kinds?: NotificationKind[] } };
  /** Without `kinds`, the subscription receives every kind. */
  'push.subscribe': { params: { endpoint: string; keys: { p256dh: string; auth: string }; kinds?: NotificationKind[] }; result: { ok: true } };
  /** The kinds this device's subscription receives from now on, without subscribing again. An empty list receives nothing. */
  'push.kinds': { params: { kinds: NotificationKind[] }; result: { ok: true } };
  'push.unsubscribe': { params: Record<string, never>; result: { ok: true } };
  'push.test': { params: Record<string, never>; result: { ok: true } };
  /** Reserve the final workspace and initialize a native session without publishing a conversation or sending text. */
  'drafts.prepare': {
    params: Omit<RpcMethods['threads.create']['params'], 'title' | 'preparationId' | 'subscribe' | 'clientRequestId'> & { preparationId: string };
    result: { preparationId: string; threadId: ThreadId };
  };
  /** Release only the named reservation owned by this connection, including preparation still in flight. */
  'drafts.release': { params: { preparationId: string }; result: { ok: true } };
  /** Transfer one validated attachment before Send. The lease belongs to this connection. */
  'attachments.upload': { params: { attachment: Attachment }; result: { id: string } };
  'attachments.release': { params: { ids: string[] }; result: { ok: true } };
  /**
   * One page of older messages, oldest first inside the page: what was written
   * before `before`, at most `limit` (`MESSAGE_PAGE` by default, `MESSAGE_PAGE_MAX`
   * whatever is asked), within `MESSAGE_PAGE_MAX_BYTES`. One complete message
   * can exceed the page byte budget for progress. Without `compactToolParts`, a
   * message or full response exceeding `RPC_MAX_FRAME_BYTES` is refused by
   * name, never truncated; with it, the message is cut to `MESSAGE_SENT_MAX_BYTES`.
   * The result's own `before` is the next cursor, null once
   * the first message of the thread is in hand. An unknown thread is a not-found;
   * a `before` that is not a message of that thread is refused by name.
   *
   * `after` instead of `before` asks for the messages written after it, the
   * page a reader scrolls down into from a page cut by `around`. The result's
   * `after` is then the next cursor, null once the page reaches the last
   * message, and its `before` is null. `from` instead asks for the messages
   * from that position on, 0 being the thread's first, with `before` and
   * `after` the cursors around the page (`features.messagePositions`). Exactly
   * one of the three is given; a `from` that is not a whole number from 0 up is
   * refused by name. `offset` is the position of the page's first message,
   * left out by cores without that feature.
   * `maxBytes` lowers the byte budget as it does for `threads.get`.
   */
  'messages.list': {
    params: { threadId: ThreadId; before?: MessageId; after?: MessageId; from?: number; limit?: number; maxBytes?: number; compactTools?: boolean; compactFiles?: boolean; compactImages?: boolean; compactToolParts?: boolean };
    result: { messages: Message[]; before: MessageId | null; after?: MessageId | null; turns?: Turn[]; offset?: number };
  };
  /** The full output of a tool already visible in this conversation. No filesystem path is accepted. */
  'messages.toolOutput': {
    params: { threadId: ThreadId; messageId: MessageId; toolId: string };
    result: { output: string | null };
  };
  /**
   * The whole tool call a page deferred (`outputDeferred`, `inputDeferred`,
   * `documentsDeferred`), as journalled. No filesystem path is accepted. A call
   * too heavy for one frame is refused by name; the thread around it still reads.
   */
  'messages.toolPart': {
    params: { threadId: ThreadId; messageId: MessageId; toolId: string };
    result: { part: Extract<MessagePart, { type: 'tool' }> };
  };
  /**
   * Read one journalled attachment on demand. No filesystem path or executable
   * is accepted. With `display`, a PNG, JPEG or WebP picture comes as the copy
   * the timeline draws: WebP at quality 80, at most `DISPLAY_IMAGE_MAX` pixels
   * on its longer side, made once and kept by the core, with `mimeType`
   * `image/webp`. A screenshot of 1.5 MB becomes about 100 KB. A plain read
   * still returns the original, which the viewer and a download ask for. A GIF,
   * a picture the core cannot convert or one its copy would not shrink, and any
   * other file, come as they are, without `mimeType`. An older core ignores
   * `display` the same way.
   *
   * `thumb` with `display` asks for the copy a thumbnail draws: at most
   * `DISPLAY_THUMB_MAX` pixels, WebP at quality 75, made once and kept like
   * the larger one. An older core ignores it and sends the larger copy.
   *
   * `ticket` asks for the bytes as a `FILE_ROUTE` path instead of base64:
   * `data` is then empty, `url` is the path (`/file/<ticket>`) to resolve
   * against the origin the client reached the core by, `mimeType` is always
   * set and `bytes` is the size. The route answers it with immutable caching,
   * since the bytes of a message's part never change, or `no-store` for an
   * incognito conversation, which leaves nothing behind. The same ticket
   * comes back for the same part and copy while it lives, so the HTTP cache
   * keeps it, and each load renews it for `FILE_TICKET_TTL_MS`. A copy the
   * core could not keep comes as base64 even with `ticket`. A client that
   * cannot fetch that address (the desktop shell through a relay, whose
   * policy only admits `/file/` at a machine's own address) leaves `ticket`
   * out and gets base64, as an older core answers.
   * Measured on 2026-10-17 with `bun run bench/media-wire.ts --browser`: ten
   * 1920 by 1080 screenshots opened on a thread cost 1,762 KB as base64 large
   * copies and 86 KB as ticketed thumbnails on loopback, and Chromium went from
   * the answers to decoded pictures in 93 ms and 12 ms.
   */
  'messages.attachment': {
    params: { threadId: ThreadId; messageId: MessageId; partIndex: number; display?: boolean; thumb?: boolean; ticket?: boolean };
    result: { data: string; mimeType?: string; url?: string; bytes?: number };
  };
}

export interface MessagesRpcEvents {

  /** Subscribed threads only, from here to `permission.resolved`. */
  'message.started': Message;
  /** Text appended to the part at `partIndex`. */
  'message.delta': { threadId: ThreadId; messageId: MessageId; partIndex: number; text: string };
  /** A part created or replaced whole (tool call state, permission card). */
  'message.part': { threadId: ThreadId; messageId: MessageId; partIndex: number; part: MessagePart };
  'message.completed': { threadId: ThreadId; messageId: MessageId; state: Message['state'] };
  /**
   * `messageId` and every message after it left the thread (`threads.rewind`),
   * and so did their turns. A client holding the thread drops them; one that
   * does not hold `messageId` reads the thread again.
   */
  'message.truncated': { threadId: ThreadId; messageId: MessageId };
}
