import {
  readTextFile,
  writeTextFile,
  gitFileVersions,
  turnFileVersions,
  readBase64,
} from "./api";
import { notifications } from "$lib/features/notifications/store.svelte";
import { confirmDialog } from "$lib/shared/components/confirm.svelte";
import { logger } from "$lib/shared/services/logger.svelte";
import { t } from "$lib/i18n/index.svelte";
import { basename } from "$lib/shared/utils/path";
import { projectOwning } from "./owner";

/**
 * Which two versions of a file a diff buffer holds.
 *
 * `turn` is the odd one and says why the others are named after git's own
 * nouns: it compares two checkpoints, neither of which is HEAD, the index or
 * the working tree.
 */
export type DiffMode = "staged" | "unstaged" | "turn";

export type Buffer = FileBuffer | DiffBuffer | PreviewBuffer;

export interface BaseBuffer {
  id: string;
  kind: "file" | "diff" | "preview";
  path: string;
  displayName: string;
  loading: boolean;
  error: string | null;
  /**
   * The project this buffer belongs to, so the tab strip can show one project's
   * files rather than every project's at once. Null for a file that sits under
   * none of them — it stays open and reachable, it just has no strip to be in.
   */
  projectId: string | null;
}

export interface FileBuffer extends BaseBuffer {
  kind: "file";
  content: string;
  savedContent: string;
  isReadonly: boolean;
  saving: boolean;
  /** Disk content diverged while the buffer holds unsaved edits. */
  externalChange: boolean;
  /**
   * Cached `content !== savedContent`. Comparing the two in the markup meant a
   * full-document comparison per tab per render; every write path below keeps
   * this in step instead.
   */
  dirty: boolean;
}

export interface DiffBuffer extends BaseBuffer {
  kind: "diff";
  mode: DiffMode;
  projectId: string;
  repoPath: string;
  /** HEAD-side path for renames (old file name). */
  headFile: string | null;
  leftLabel: string;
  rightLabel: string;
  leftContent: string;
  rightContent: string;
  binary: boolean;
  /** The two checkpoints a `turn` diff spans. Null for the other modes. */
  range: { from: string; to: string } | null;
}

/**
 * A document to be drawn rather than read: a PDF, an image.
 *
 * `read_text_file` refuses these outright — it stops at the first NUL byte and
 * answers "binary file" — so before this they were a tab showing an error.
 *
 * The bytes come across whole rather than as a URL the webview fetches: a data
 * URL is what `img-src 'self' data: blob:` already allows for an image, and
 * pdf.js wants an array either way. Nothing to serve, nothing to authorise, and
 * the same road for both kinds — so there is one answer to "what happens when
 * you open a file the editor cannot read".
 */
export interface PreviewBuffer extends BaseBuffer {
  kind: "preview";
  /** The file itself. Empty until it has been read. */
  bytes: Uint8Array;
  /** `pdf` renders through pdf.js, `image` through a data URL. */
  media: "pdf" | "image";
  /** Populated for images only; a data URL the CSP's `img-src` already allows. */
  dataUrl: string;
}

/** Extensions handed to the webview rather than to the text editor. */
const PREVIEWABLE = new Set([
  "pdf",
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "avif",
  "bmp",
  "ico",
  "svg",
]);

/** Whether opening this path should draw it rather than try to read it. */
export function isPreviewable(path: string): boolean {
  return PREVIEWABLE.has(extensionOf(path));
}

function extensionOf(path: string): string {
  const dot = path.lastIndexOf(".");
  return dot < 0 ? "" : path.slice(dot + 1).toLowerCase();
}

const IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  ico: "image/x-icon",
  svg: "image/svg+xml",
};

function imageMime(path: string): string {
  return IMAGE_MIME[extensionOf(path)] ?? "application/octet-stream";
}

/** base64 → bytes. `atob` gives a binary string; pdf.js wants the array. */
function decodeBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function fileBufferId(path: string): string {
  return `file:${path}`;
}

function diffBufferId(
  repoPath: string,
  file: string,
  mode: DiffMode,
  range?: { from: string; to: string },
): string {
  // The range is in the id for `turn`, or two turns touching the same file
  // would be one tab that keeps replacing itself.
  const span = range ? `${range.from}..${range.to}:` : "";
  return `diff:${mode}:${span}${repoPath}::${file}`;
}

/**
 * What a caller can say about an open beyond the path itself.
 *
 * `owner` is the project the buffer belongs to when the caller knows better
 * than the disk does. An agent's `pane_open kind=editor` is that caller: the
 * pane lands in the caller thread's group, so the file has to be in that
 * project's strip whatever `projectOwning` makes of the path. Without it a plan
 * written to the scratchpad opened a pane the strip filtered out, and the agent
 * was told `opened` over an empty panel.
 */
export interface OpenOptions {
  owner?: string | null;
}

/** The project a new buffer is filed under: the caller's word first. */
function ownerOf(path: string, opts?: OpenOptions): string | null {
  return opts?.owner ?? projectOwning(path);
}

class EditorStore {
  buffers = $state<Buffer[]>([]);
  activeId = $state<string | null>(null);

  get active(): Buffer | null {
    return this.buffers.find((b) => b.id === this.activeId) ?? null;
  }

  /**
   * Re-file a buffer already open under whichever project asked for it last.
   *
   * One path is one buffer, so a file opened from its own explorer and then
   * shown by an agent in another project would otherwise keep the first strip
   * and be invisible in the second. Only a caller that named an owner moves it;
   * the explorer and the git panel say nothing and change nothing.
   */
  private adopt(b: Buffer, opts?: OpenOptions): void {
    const owner = opts?.owner;
    if (owner === undefined || b.projectId === owner) return;
    if (b.kind === "diff") return;
    b.projectId = owner;
  }

  isDirty(b: Buffer): boolean {
    return b.kind === "file" && b.dirty;
  }

  /**
   * Open a file the one way it can be read: as text, or drawn by the webview.
   *
   * The single entry point on purpose. Every caller — the explorer, the git
   * panel, the palette, an agent — wants "show me this path", and none of them
   * should have to know that a PDF takes a different road than a `.ts`.
   *
   * `owner` names the project whose strip the buffer belongs in, for a caller
   * that knows better than the path does. See `OpenOptions`.
   */
  async open(path: string, opts?: OpenOptions): Promise<string> {
    return isPreviewable(path) ? this.openPreview(path, opts) : this.openFile(path, opts);
  }

  /** A PDF or an image, handed to the webview as a URL it can render. */
  async openPreview(path: string, opts?: OpenOptions): Promise<string> {
    const normalized = path.replace(/\\/g, "/");
    const id = `preview:${normalized}`;
    const existing = this.buffers.find((b) => b.id === id);
    if (existing) {
      this.adopt(existing, opts);
      this.activeId = id;
      return id;
    }
    const media = normalized.toLowerCase().endsWith(".pdf") ? "pdf" : "image";
    const buf: PreviewBuffer = {
      id,
      kind: "preview",
      path: normalized,
      displayName: basename(normalized),
      loading: true,
      error: null,
      projectId: ownerOf(normalized, opts),
      bytes: new Uint8Array(),
      media,
      dataUrl: "",
    };
    this.buffers = [...this.buffers, buf];
    this.activeId = id;
    try {
      const b64 = await readBase64(normalized);
      // An image goes straight to a data URL — `img-src 'self' data: blob:` is
      // already in the app's CSP, so nothing has to be decoded by hand. A PDF
      // goes to pdf.js, which wants the bytes.
      if (media === "image") {
        this.patch(id, { loading: false, dataUrl: `data:${imageMime(normalized)};base64,${b64}` });
      } else {
        this.patch(id, { loading: false, bytes: decodeBase64(b64) });
      }
    } catch (err) {
      const msg = String(err);
      logger.warn("editor", `no view url for ${normalized}`, msg);
      this.patch(id, {
        loading: false,
        error: msg.includes("not-supported-remote")
          ? t("editor.previewRemote")
          : msg,
      });
    }
    return id;
  }

  async openFile(path: string, opts?: OpenOptions): Promise<string> {
    // One separator convention so the same file opened from the explorer
    // (forward slashes) and the git panel (native) shares one buffer.
    const normalized = path.replace(/\\/g, "/");
    const id = fileBufferId(normalized);
    const existing = this.buffers.find((b) => b.id === id);
    if (existing) {
      this.adopt(existing, opts);
      this.activeId = id;
      if (existing.kind === "file" && !existing.loading && !existing.error) {
        void this.syncFromDisk(id);
      }
      return id;
    }
    const buf: FileBuffer = {
      id,
      kind: "file",
      path: normalized,
      displayName: basename(normalized),
      loading: true,
      error: null,
      projectId: ownerOf(normalized, opts),
      content: "",
      savedContent: "",
      isReadonly: false,
      saving: false,
      externalChange: false,
      dirty: false,
    };
    this.buffers = [...this.buffers, buf];
    this.activeId = id;

    try {
      const file = await readTextFile(normalized);
      // Lossy decode = replacement chars instead of the original bytes;
      // saving would silently corrupt the file. Open read-only instead.
      this.patch(id, {
        loading: false,
        content: file.content,
        savedContent: file.content,
        isReadonly: file.isReadonly || file.lossy,
        dirty: false,
      });
      if (file.lossy) {
        notifications.error(
          t("editor.notUtf8", { name: basename(normalized) }),
        );
      }
    } catch (err) {
      const msg = String(err);
      logger.warn("editor", `read_text_file failed for ${normalized}`, msg);
      this.patch(id, { loading: false, error: msg });
      notifications.error(
        t("editor.openFailed", { name: basename(normalized), error: msg }),
      );
    }
    return id;
  }

  // Re-read the file on activation: clean buffers silently pick up agent
  // edits; dirty buffers get flagged instead of clobbered.
  private async syncFromDisk(id: string): Promise<void> {
    const b = this.buffers.find((x) => x.id === id);
    if (!b || b.kind !== "file" || b.saving) return;
    try {
      const file = await readTextFile(b.path);
      const fresh = this.buffers.find((x) => x.id === id);
      if (!fresh || fresh.kind !== "file" || fresh.saving) return;
      if (file.content === fresh.savedContent) {
        fresh.externalChange = false;
        return;
      }
      if (!fresh.dirty) {
        fresh.content = file.content;
        fresh.savedContent = file.content;
        fresh.isReadonly = file.isReadonly || file.lossy;
        fresh.externalChange = false;
        fresh.dirty = false;
      } else {
        fresh.externalChange = true;
      }
    } catch {
      // Unreadable or deleted; keep the buffer as the last good copy.
    }
  }

  async reloadFromDisk(id: string): Promise<void> {
    const b = this.buffers.find((x) => x.id === id);
    if (!b || b.kind !== "file") return;
    if (this.isDirty(b)) {
      const ok = await confirmDialog.ask({
        title: t("editor.reloadTitle"),
        message: t("editor.reloadMessage", { name: b.displayName }),
        confirmLabel: t("editor.reloadConfirm"),
        danger: true,
      });
      if (!ok) return;
    }
    try {
      const file = await readTextFile(b.path);
      this.patch(id, {
        content: file.content,
        savedContent: file.content,
        isReadonly: file.isReadonly || file.lossy,
        externalChange: false,
        dirty: false,
      });
    } catch (err) {
      notifications.error(t("editor.reloadFailed", { error: String(err) }));
    }
  }

  async openDiff(args: {
    projectId: string;
    repoPath: string;
    file: string;
    mode: DiffMode;
    headFile?: string;
    range?: { from: string; to: string };
  }): Promise<string> {
    const id = diffBufferId(args.repoPath, args.file, args.mode, args.range);
    const fullPath = joinPath(args.repoPath, args.file);
    const existing = this.buffers.find((b) => b.id === id);
    if (existing) {
      if (existing.kind === "diff") {
        existing.headFile = args.headFile ?? null;
      }
      this.activeId = id;
      void this.refreshDiff(id);
      return id;
    }
    const buf: DiffBuffer = {
      id,
      kind: "diff",
      path: fullPath,
      displayName: `${basename(args.file)} · ${args.mode}`,
      loading: true,
      error: null,
      mode: args.mode,
      projectId: args.projectId,
      repoPath: args.repoPath,
      headFile: args.headFile ?? null,
      leftLabel: "",
      rightLabel: "",
      leftContent: "",
      rightContent: "",
      binary: false,
      range: args.range ?? null,
    };
    this.buffers = [...this.buffers, buf];
    this.activeId = id;
    await this.refreshDiff(id);
    return id;
  }

  private async refreshDiff(id: string): Promise<void> {
    const b = this.buffers.find((x) => x.id === id);
    if (!b || b.kind !== "diff") return;
    this.patch(id, { loading: true, error: null });
    try {
      const file = relativeTo(b.repoPath, b.path);
      let leftLabel: string;
      let rightLabel: string;
      let leftContent: string;
      let rightContent: string;
      let binary: boolean;
      if (b.mode === "turn" && b.range) {
        const v = await turnFileVersions(b.repoPath, b.range.from, b.range.to, file);
        leftLabel = t("turns.before");
        rightLabel = t("turns.after");
        leftContent = v.before ?? "";
        rightContent = v.after ?? "";
        binary = v.binary;
        this.patch(id, {
          loading: false,
          leftLabel,
          rightLabel,
          leftContent,
          rightContent,
          binary,
        });
        return;
      }
      const v = await gitFileVersions(b.repoPath, file, b.headFile ?? undefined);
      binary = v.binary;
      if (b.mode === "staged") {
        leftLabel = "HEAD";
        rightLabel = "Index";
        leftContent = v.head ?? "";
        rightContent = v.index ?? "";
      } else {
        leftLabel = v.index !== null ? "Index" : "HEAD";
        rightLabel = "Working";
        leftContent = (v.index ?? v.head) ?? "";
        rightContent = v.work ?? "";
      }
      this.patch(id, {
        loading: false,
        leftLabel,
        rightLabel,
        leftContent,
        rightContent,
        binary,
      });
    } catch (err) {
      const msg = String(err);
      logger.warn("editor", `git_file_versions failed for ${b.path}`, msg);
      this.patch(id, { loading: false, error: msg });
    }
  }

  setContent(id: string, content: string) {
    const b = this.buffers.find((x) => x.id === id);
    if (!b || b.kind !== "file") return;
    b.content = content;
    b.dirty = content !== b.savedContent;
  }

  async save(id: string): Promise<boolean> {
    const b = this.buffers.find((x) => x.id === id);
    if (!b || b.kind !== "file") return false;
    if (b.isReadonly) {
      notifications.error(t("editor.readOnlyError"));
      return false;
    }
    if (!b.dirty) return true;
    this.patch(id, { saving: true });
    try {
      // Lost-update guard: someone (an agent, most likely) may have written
      // the file since we loaded it.
      try {
        const disk = await readTextFile(b.path);
        if (disk.content !== b.savedContent) {
          const ok = await confirmDialog.ask({
            title: t("editor.externalTitle"),
            message: t("editor.externalMessage", { name: b.displayName }),
            confirmLabel: t("editor.externalConfirm"),
            danger: true,
          });
          if (!ok) {
            this.patch(id, { saving: false, externalChange: true });
            return false;
          }
        }
      } catch {
        // Unreadable or deleted on disk; proceed and recreate it.
      }
      await writeTextFile(b.path, b.content);
      const fresh = this.buffers.find((x) => x.id === id);
      if (fresh && fresh.kind === "file") {
        fresh.savedContent = fresh.content;
        fresh.saving = false;
        fresh.externalChange = false;
        fresh.dirty = false;
      }
      notifications.success(t("editor.saved", { name: b.displayName }));
      return true;
    } catch (err) {
      const msg = String(err);
      logger.warn("editor", `write_text_file failed for ${b.path}`, msg);
      this.patch(id, { saving: false });
      notifications.error(t("editor.saveFailed", { error: msg }));
      return false;
    }
  }

  async close(id: string, force = false): Promise<boolean> {
    const b = this.buffers.find((x) => x.id === id);
    if (!b) return true;
    if (!force && this.isDirty(b)) {
      const ok = await confirmDialog.ask({
        title: t("editor.discardTitle"),
        message: t("editor.discardMessage", { name: b.displayName }),
        confirmLabel: t("editor.discardConfirm"),
        danger: true,
      });
      if (!ok) return false;
    }
    const idx = this.buffers.findIndex((x) => x.id === id);
    this.buffers = this.buffers.filter((x) => x.id !== id);
    if (this.activeId === id) {
      const next = this.buffers[idx] ?? this.buffers[idx - 1] ?? null;
      this.activeId = next?.id ?? null;
    }
    return true;
  }

  /**
   * Drop every buffer, so a switch cannot write one machine's bytes onto
   * another.
   *
   * A buffer holds an absolute path and whatever was read at that path on the
   * machine that answered at the time, while `save` resolves its destination
   * through `backendForPath` against the project list of whatever answers now.
   * Left open across a switch, a file read on one boite and saved after landing
   * on the next overwrote that path on the new machine, with nothing on screen
   * saying which machine was being written to.
   *
   * Unsaved edits go with them, and flushing them to disk first is not the
   * cheaper answer it looks like: `connectBoite` calls `createRemote` before
   * `adoptRemote`, and that disposes the previous socket and installs the new
   * one while the mode is still `remote`, so on a boite-to-boite switch
   * `backend()` already answers as the machine being switched TO by the time
   * this runs. A flush there would commit the exact overwrite this drop exists
   * to prevent, without a keystroke. The loss is written to the log rather than
   * raised on screen because saying it needs a sentence in every dictionary,
   * and the repo's two existing guards for this event (`CloseGuard`,
   * `prepareForInstall`) each own their own wording rather than borrowing one.
   */
  reset() {
    const dirty = this.buffers.filter((b) => this.isDirty(b));
    if (dirty.length > 0) {
      logger.error(
        "editor",
        `workspace switch discarded ${dirty.length} unsaved buffer(s)`,
        dirty.map((b) => b.path).join(", "),
      );
    }
    this.buffers = [];
    this.activeId = null;
  }

  /**
   * The buffers one project owns, which is what the strip and the titlebar
   * count show.
   *
   * Everything stays open across a project switch — walking away from a project
   * is not closing its files, and coming back finds them where they were. It is
   * only what is on screen that narrows, so eight files from three projects
   * stop sharing one strip with nothing to say which is which.
   */
  forProject(projectId: string | null): Buffer[] {
    if (!projectId) return [];
    return this.buffers.filter((b) => b.projectId === projectId);
  }

  /**
   * Put the dragged tab where it was dropped.
   *
   * Order is the strip's own, not the order files happened to be opened in, and
   * it is the one thing about a tab the user can arrange. Takes ids rather than
   * indices because the strip reads them off the DOM, and a stale index after a
   * close would silently move the wrong buffer.
   */
  reorder(draggedId: string, beforeId: string | null) {
    const from = this.buffers.findIndex((b) => b.id === draggedId);
    if (from < 0) return;
    const next = this.buffers.slice();
    const [moved] = next.splice(from, 1);
    // Resolved after the removal: an index taken before it is off by one for
    // every target to the right of where the tab came from.
    const to = beforeId === null ? next.length : next.findIndex((b) => b.id === beforeId);
    if (to < 0) return;
    next.splice(to, 0, moved);
    this.buffers = next;
  }

  setActive(id: string) {
    const b = this.buffers.find((x) => x.id === id);
    if (!b) return;
    this.activeId = id;
    if (b.kind === "file" && !b.loading && !b.error) {
      void this.syncFromDisk(id);
    } else if (b.kind === "diff") {
      void this.refreshDiff(id);
    }
  }

  private patch(id: string, fields: Partial<Buffer>) {
    const b = this.buffers.find((x) => x.id === id);
    if (!b) return;
    Object.assign(b, fields);
  }
}

function joinPath(base: string, rel: string): string {
  const sep = base.includes("\\") ? "\\" : "/";
  const trimmed = base.endsWith(sep) ? base.slice(0, -1) : base;
  return `${trimmed}${sep}${rel.replace(/[\\/]/g, sep)}`;
}

function relativeTo(repo: string, full: string): string {
  const sep = repo.includes("\\") ? "\\" : "/";
  const root = repo.endsWith(sep) ? repo : repo + sep;
  if (full.startsWith(root)) return full.slice(root.length).replace(/\\/g, "/");
  return full.replace(/\\/g, "/");
}

export const editorStore = new EditorStore();
