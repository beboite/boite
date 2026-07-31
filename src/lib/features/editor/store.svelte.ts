import { readTextFile, writeTextFile, gitFileVersions } from "./api";
import { notifications } from "$lib/features/notifications/store.svelte";
import { confirmDialog } from "$lib/shared/components/confirm.svelte";
import { logger } from "$lib/shared/services/logger.svelte";
import { t } from "$lib/i18n/index.svelte";
import { basename } from "$lib/shared/utils/path";

export type DiffMode = "staged" | "unstaged";

export type Buffer = FileBuffer | DiffBuffer;

export interface BaseBuffer {
  id: string;
  kind: "file" | "diff";
  path: string;
  displayName: string;
  loading: boolean;
  error: string | null;
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
}

function fileBufferId(path: string): string {
  return `file:${path}`;
}

function diffBufferId(repoPath: string, file: string, mode: DiffMode): string {
  return `diff:${mode}:${repoPath}::${file}`;
}

class EditorStore {
  buffers = $state<Buffer[]>([]);
  activeId = $state<string | null>(null);

  get active(): Buffer | null {
    return this.buffers.find((b) => b.id === this.activeId) ?? null;
  }

  isDirty(b: Buffer): boolean {
    return b.kind === "file" && b.dirty;
  }

  async openFile(path: string): Promise<string> {
    // One separator convention so the same file opened from the explorer
    // (forward slashes) and the git panel (native) shares one buffer.
    const normalized = path.replace(/\\/g, "/");
    const id = fileBufferId(normalized);
    const existing = this.buffers.find((b) => b.id === id);
    if (existing) {
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
        title: "Reload from disk?",
        message: `${b.displayName} has unsaved changes. Reloading will discard them.`,
        confirmLabel: "Reload",
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
  }): Promise<string> {
    const id = diffBufferId(args.repoPath, args.file, args.mode);
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
      const v = await gitFileVersions(
        b.repoPath,
        relativeTo(b.repoPath, b.path),
        b.headFile ?? undefined,
      );
      let leftLabel: string;
      let rightLabel: string;
      let leftContent: string;
      let rightContent: string;
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
        binary: v.binary,
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
            title: "File changed on disk",
            message: `${b.displayName} was modified outside the editor. Saving will overwrite those changes.`,
            confirmLabel: "Overwrite",
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
        title: "Discard unsaved changes?",
        message: `${b.displayName} has unsaved changes.`,
        confirmLabel: "Discard",
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
