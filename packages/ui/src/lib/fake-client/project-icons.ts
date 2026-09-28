/** Project icons as the core answers them: a version or a stack on the project, the bytes on `projects.icon`. */
import { RpcErrorCode, type Project, type ProjectIcon } from '@boite/contracts';
import { RpcFailure } from '../client';
import { describedProject } from './project-archive';
import type { FakeContext, FakeMethods } from './context';

/** A shelf with two boxes on an orange square: what a folder's `logo.svg` could hold. */
const BOITE_LOGO =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" rx="5" fill="#e8622c"/>' +
  '<g fill="none" stroke="#fff" stroke-width="1.75" stroke-linejoin="round"><rect x="5" y="4" width="14" height="16" rx="1.5"/><path d="M5 10h14"/></g>' +
  '<rect x="6.75" y="5.5" width="3" height="3" rx=".5" fill="#fff"/><rect x="6.75" y="12" width="6" height="6" rx=".6" fill="#fff"/></svg>';

/** What the seeded folders hold: boite a logo, notes only a `pyproject.toml`. */
export function seedProjectIcons(ctx: FakeContext): void {
  ctx.projectImages.set('p-boite', { version: '3f2a9c10b7e4', dataUrl: `data:image/svg+xml;base64,${btoa(BOITE_LOGO)}` });
  const icons: Record<string, ProjectIcon> = {
    'p-boite': { kind: 'image', version: '3f2a9c10b7e4' },
    'p-notes': { kind: 'tech', id: 'python' }
  };
  for (const project of ctx.projects) {
    const icon = icons[project.id];
    if (icon) project.icon = icon;
  }
}

export function projectIconMethods(ctx: FakeContext) {
  return {
    'projects.icon': async (params) => {
      const project = ctx.projects.find((p) => p.id === params.projectId);
      if (!project) throw ctx.notFound('project', params.projectId);
      const image = ctx.projectImages.get(project.id);
      if (project.icon?.kind !== 'image' || !image) {
        throw new RpcFailure({
          code: RpcErrorCode.Refused,
          message: 'projects.icon: this project has no image icon; its icon field says which kind it has',
          data: { field: 'projectId', projectId: project.id, expected: "a project whose icon.kind is 'image'" }
        });
      }
      return { ...image };
    },
    // No disk here: the folder reads as it did, so a refresh answers the project and announces nothing.
    'projects.refreshIcon': async (params): Promise<Project> => {
      const project = ctx.projects.find((p) => p.id === params.projectId);
      if (!project) throw ctx.notFound('project', params.projectId);
      return describedProject(ctx, project);
    }
  } satisfies Partial<FakeMethods>;
}

