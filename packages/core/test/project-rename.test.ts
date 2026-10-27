import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from '../src/client.ts';
import { startTestCore, waitFor } from './harness.ts';

test('a paired phone renames a project, another client hears it and a restarted core retains it', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'boite-project-rename-'));
  let harness = await startTestCore({ dataDir });
  try {
    const owner = await harness.connect();
    const project = await owner.call('projects.add', { path: dataDir, name: 'before' });
    const { grant } = await owner.call('pairing.grant', {});
    const phone = await connect(harness.url, '', { grant, client: { name: 'pwa', version: 'test' } });
    let heard = '';
    owner.on('project.updated', p => { if (p.id === project.id) heard = p.name; });
    try {
      const renamed = await phone.call('projects.rename', { projectId: project.id, name: 'After' });
      expect(renamed.path).toBe(dataDir);
      await waitFor(() => heard === 'After');
    } finally { phone.close(); }
    await harness.stop();
    harness = await startTestCore({ dataDir });
    const reconnected = await harness.connect();
    expect((await reconnected.call('projects.list', {})).find(p => p.id === project.id)).toMatchObject({ name: 'After', path: dataDir });
  } finally {
    await harness.stop();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
