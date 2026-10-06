import { Archive, ArrowDown, ArrowLeft, ArrowUp, Copy, GitBranch, History, Import, Plus, RefreshCw, Settings, Trash2 } from '@lucide/svelte';
import type { Project } from '@boite/contracts';
import type { Store } from './store.svelte';
import { workspace } from './workspace.svelte';
import { confirm } from './confirm.svelte';
import { contextMenu } from './context-menu.svelte';
import { experimentOn } from './experiments.svelte';
import { separator, type MenuItem } from './menu';
import { fill, strings } from './strings';
import { projectName } from './format';
import { undo } from './undo.svelte';

/** Asks before a project leaves Boite, then removes it. Its folder, when there is one left, stays. */
export async function confirmRemoveProject(owner: Store, project: Project): Promise<void> {
  const sure = await confirm.ask({
    title: fill(strings.sidebar.removeProjectTitle, { project: projectName(project) }),
    body: strings.sidebar.removeProjectBody,
    confirmLabel: strings.sidebar.remove,
    cancelLabel: strings.common.cancel,
    danger: true
  });
  if (sure) await owner.removeProject(project.id);
}

/** Puts a project out of the list and offers to bring it back. An archived or unknown project is left alone. */
export async function archiveProjectWithUndo(owner: Store, project: Project): Promise<void> {
  if (!owner.projects.some(p => p.id === project.id && !p.archived) || !(await owner.archiveProject(project.id, true))) return;
  undo.offer(fill(strings.sidebar.projectArchivedToast, { project: projectName(project) }), async () => {
    await owner.archiveProject(project.id, false);
  });
}

export function projectMenu(event: MouseEvent, owner: Store, project: Project, reorder?: {
  up: boolean;
  down: boolean;
  move: (direction: -1 | 1) => void;
}) {
  const client = owner.client;
  const clientGeneration = owner.clientGeneration;
  const management: MenuItem[] = [
    { id: 'back', label: strings.sidebar.backToProjectMenu, glyph: ArrowLeft },
    separator('back-sep'),
    ...(reorder ? [
      { id: 'move-up', label: strings.sidebar.moveProjectUp, glyph: ArrowUp, disabled: !reorder.up },
      { id: 'move-down', label: strings.sidebar.moveProjectDown, glyph: ArrowDown, disabled: !reorder.down },
      separator('order-sep')
    ] : []),
    ...(owner.owner
      ? [
          ...(experimentOn('session-import') ? [{ id: 'import', label: strings.sidebar.importSession, glyph: Import }] : []),
          ...(project.kind !== 'drafts' && project.repository === true ? [{ id: 'worktree-default', label: strings.sidebar.worktreeDefault, glyph: GitBranch, checked: project.worktreeDefault === true }, { id: 'worktrees', label: strings.settings.worktrees.heading, glyph: GitBranch }] : []),
          ...(project.kind !== 'drafts' && project.repository !== false && project.autoArchiveMergedPr !== undefined ? [{
            id: 'auto-archive-merged-pr', label: strings.sidebar.autoArchiveMergedPr, glyph: Archive,
            get checked() { return (owner.projects.find(current => current.id === project.id)?.autoArchiveMergedPr ?? project.autoArchiveMergedPr) === true; },
            get disabled() { return owner.client !== client || owner.clientGeneration !== clientGeneration || !owner.owner || owner.connection !== 'ready' || owner.projectAutoArchiveMergedPrBusy(project.id); }
          }] : []),
          ...(project.kind === 'drafts' ? [] : [{ id: 'refresh-icon', label: strings.sidebar.refreshIcon, glyph: RefreshCw, disabled: project.missing === true }])
        ]
      : []),
    ...(owner.owner && project.kind !== 'drafts' ? [separator('archive-sep')] : []),
    ...(project.kind === 'drafts' ? [] : [{ id: 'archive-project', label: strings.sidebar.archiveProject, glyph: Archive, disabled: project.archived === true }]),
    ...(owner.owner ? [{ id: 'remove', label: strings.sidebar.removeProject, glyph: Trash2, danger: true }] : [])
  ];
  const main: MenuItem[] = [
    // A thread cannot start in a folder that is gone; the core refuses it too.
    { id: 'new', label: strings.sidebar.newThread, glyph: Plus, disabled: project.missing === true, ...(project.missing === true ? { title: strings.sidebar.projectMissing } : {}) },
    { id: 'copy', label: strings.sidebar.copyPath, title: project.path, glyph: Copy },
    { id: 'archived', label: strings.sidebar.viewArchivedThreads, glyph: History },
    ...(owner.owner || project.kind !== 'drafts' || reorder
      ? [separator(), { id: 'manage', label: strings.sidebar.manageProject, glyph: Settings, hint: '›' }]
      : [])
  ];
  contextMenu.open(
    event,
    main,
    async function pick(action) {
      if (action === 'manage') return contextMenu.follow(management, pick);
      if (action === 'back') return contextMenu.follow(main, pick);
      if (action === 'move-up' || action === 'move-down') reorder?.move(action === 'move-up' ? -1 : 1);
      if (action === 'new') await workspace.select(owner, undefined, project.id);
      if (action === 'copy') await owner.copy(project.path);
      if (action === 'archived') {
        if (workspace.active !== owner) await workspace.select(owner);
        owner.showSettings('general', 'archived');
      }
      if (action === 'archive-project') await archiveProjectWithUndo(owner, project);
      if (action === 'worktree-default') {
        const current = owner.projects.find(p => p.id === project.id);
        if (current) await owner.setProjectWorktreeDefault(project.id, current.worktreeDefault !== true);
      }
      if (action === 'auto-archive-merged-pr') {
        // A menu opened on another client cannot change this machine's colliding project id.
        if (owner.client !== client || owner.clientGeneration !== clientGeneration) return;
        const current = owner.projects.find(projectOnOwner => projectOnOwner.id === project.id);
        if (current?.autoArchiveMergedPr !== undefined) await owner.setProjectAutoArchiveMergedPr(project.id, !current.autoArchiveMergedPr);
      }
      if (action === 'worktrees') {
        if (workspace.active !== owner) await workspace.select(owner);
        owner.showSettings('general', 'worktrees');
      }
      if (action === 'refresh-icon') await owner.refreshProjectIcon(project.id);
      if (action === 'import') {
        await workspace.select(owner);
        await owner.openImports(project.id);
      }
      if (action === 'remove') await confirmRemoveProject(owner, project);
    }
  );
}
