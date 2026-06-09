import { readTextFile, writeTextFile, gitFileVersions } from "./api";
import { notifications } from "$lib/features/notifications/store.svelte";
import { confirmDialog } from "$lib/shared/components/confirm.svelte";
import { logger } from "$lib/shared/services/logger.svelte";

export type DiffMode = "staged" | "unstaged";

export type Buffer = FileBuffer | DiffBuffer;

export interface BaseBuffer {
  id: string;
  kind: "file" | "diff";
  path: string;
  displayName: string;
  language: string | null;
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

function basename(p: string): string {
  const idx = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return idx >= 0 ? p.slice(idx + 1) : p;
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

  get hasDirty(): boolean {
    return this.buffers.some(
      (b) => b.kind === "file" && b.content !== b.savedContent,
    );
  }

  isDirty(b: Buffer): boolean {
    return b.kind === "file" && b.content !== b.savedContent;
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
      language: null,
      loading: true,
      error: null,
      content: "",
      savedContent: "",
      isReadonly: false,
      saving: false,
      externalChange: false,
    };
    this.buffers = [...this.buffers, buf];
    this.activeId = id;

    try {
      const file = await readTextFile(normalized);
      this.patch(id, {
        loading: false,
        content: file.content,
        savedContent: file.content,
        isReadonly: file.isReadonly,
      });
    } catch (err) {
      const msg = String(err);
      logger.warn("editor", `read_text_file failed for ${normalized}`, msg);
      this.patch(id, { loading: false, error: msg });
      notifications.error(`Cannot open ${basename(normalized)}: ${msg}`);
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
      if (fresh.content === fresh.savedContent) {
        fresh.content = file.content;
        fresh.savedContent = file.content;
        fresh.isReadonly = file.isReadonly;
        fresh.externalChange = false;
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
        isReadonly: file.isReadonly,
        externalChange: false,
      });
    } catch (err) {
      notifications.error(`Reload failed: ${err}`);
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
      language: null,
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
  }

  async save(id: string): Promise<boolean> {
    const b = this.buffers.find((x) => x.id === id);
    if (!b || b.kind !== "file") return false;
    if (b.isReadonly) {
      notifications.error("File is read-only");
      return false;
    }
    if (b.content === b.savedContent) return true;
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
      }
      notifications.success(`Saved ${b.displayName}`);
      return true;
    } catch (err) {
      const msg = String(err);
      logger.warn("editor", `write_text_file failed for ${b.path}`, msg);
      this.patch(id, { saving: false });
      notifications.error(`Save failed: ${msg}`);
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

  closeAll(): void {
    this.buffers = [];
    this.activeId = null;
  }

  setLanguage(id: string, name: string | null) {
    const b = this.buffers.find((x) => x.id === id);
    if (!b) return;
    b.language = name;
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
