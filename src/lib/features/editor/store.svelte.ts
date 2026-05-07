import { readTextFile, writeTextFile, gitFileVersions } from "./api";
import { notifications } from "$lib/features/notifications/store.svelte";
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
}

export interface DiffBuffer extends BaseBuffer {
  kind: "diff";
  mode: DiffMode;
  projectId: string;
  repoPath: string;
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
    const id = fileBufferId(path);
    const existing = this.buffers.find((b) => b.id === id);
    if (existing) {
      this.activeId = id;
      return id;
    }
    const buf: FileBuffer = {
      id,
      kind: "file",
      path,
      displayName: basename(path),
      language: null,
      loading: true,
      error: null,
      content: "",
      savedContent: "",
      isReadonly: false,
      saving: false,
    };
    this.buffers = [...this.buffers, buf];
    this.activeId = id;

    try {
      const file = await readTextFile(path);
      this.patch(id, {
        loading: false,
        content: file.content,
        savedContent: file.content,
        isReadonly: file.isReadonly,
      });
    } catch (err) {
      const msg = String(err);
      logger.warn("editor", `read_text_file failed for ${path}`, msg);
      this.patch(id, { loading: false, error: msg });
      notifications.error(`Cannot open ${basename(path)}: ${msg}`);
    }
    return id;
  }

  async openDiff(args: {
    projectId: string;
    repoPath: string;
    file: string;
    mode: DiffMode;
  }): Promise<string> {
    const id = diffBufferId(args.repoPath, args.file, args.mode);
    const fullPath = joinPath(args.repoPath, args.file);
    const existing = this.buffers.find((b) => b.id === id);
    if (existing) {
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
      const v = await gitFileVersions(b.repoPath, relativeTo(b.repoPath, b.path));
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
      await writeTextFile(b.path, b.content);
      const fresh = this.buffers.find((x) => x.id === id);
      if (fresh && fresh.kind === "file") {
        fresh.savedContent = fresh.content;
        fresh.saving = false;
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

  close(id: string, force = false): boolean {
    const b = this.buffers.find((x) => x.id === id);
    if (!b) return true;
    if (!force && this.isDirty(b)) {
      const ok = confirm(
        `${b.displayName} has unsaved changes. Discard?`,
      );
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
    if (this.buffers.some((b) => b.id === id)) this.activeId = id;
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
