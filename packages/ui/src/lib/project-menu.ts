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

export function projectMenu(event: MouseEvent, owner: Store, project: Project, reorder?: {
  up: boolean;
  down: boolean;
  move: (direction: -1 | 1) => void;
}) {
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
          ...(project.kind !== 'drafts' && project.repository !== false ? [{ id: 'worktrees', label: strings.settings.worktrees.heading, glyph: GitBranch }] : []),
          ...(project.kind === 'drafts' ? [] : [{ id: 'refresh-icon', label: strings.sidebar.refreshIcon, glyph: RefreshCw }])
        ]
      : []),
    ...(owner.owner && project.kind !== 'drafts' ? [separator('archive-sep')] : []),
    ...(project.kind === 'drafts' ? [] : [{ id: 'archive-project', label: strings.sidebar.archiveProject, glyph: Archive, disabled: project.archived === true }]),
    ...(owner.owner ? [{ id: 'remove', label: strings.sidebar.removeProject, glyph: Trash2, danger: true }] : [])
  ];
  const main: MenuItem[] = [
    { id: 'new', label: strings.sidebar.newThread, glyph: Plus },
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
      if (action === 'archive-project' && owner.projects.some(p => p.id === project.id && !p.archived) && (await owner.archiveProject(project.id, true)))
        undo.offer(fill(strings.sidebar.projectArchivedToast, { project: projectName(project) }), async () => {
          await owner.archiveProject(project.id, false);
        });
      if (action === 'worktrees') {
        if (workspace.active !== owner) await workspace.select(owner);
        owner.showSettings('general', 'worktrees');
      }
      if (action === 'refresh-icon') await owner.refreshProjectIcon(project.id);
      if (action === 'import') {
        await workspace.select(owner);
        await owner.openImports(project.id);
      }
      if (
        action === 'remove' &&
        (await confirm.ask({
          title: fill(strings.sidebar.removeProjectTitle, { project: projectName(project) }),
          body: strings.sidebar.removeProjectBody,
          confirmLabel: strings.sidebar.remove,
          cancelLabel: strings.common.cancel,
          danger: true
        }))
      )
        await owner.removeProject(project.id);
    }
  );
}
