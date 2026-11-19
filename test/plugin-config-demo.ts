import { cpSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../src/core/store.ts';
import { REPO_ROOT } from '../src/main.ts';
import { startTestHub, tempDir } from './helpers.ts';

/** An isolated Hub with two mock groups. Interactive previews can supply their own empty dir and shutdown callback. */
export async function startPluginConfigDemo(port = 0, options: { dir?: string; onShutdown?: () => void } = {}) {
  if (port === 4317) throw new Error('The demo needs its own port');
  const dir = options.dir ?? tempDir();
  if (options.dir) {
    mkdirSync(dir, { recursive: true });
    if (readdirSync(dir).length) throw new Error('The demo needs an empty directory');
  }
  const projectId = 'config-project';
  const weeklyId = 'config-weekly';
  const groups = [
    { id: projectId, name: '项目讨论', members: ['小林', '小周'] },
    { id: weeklyId, name: '周会', members: ['小陈'] },
  ];
  const store = new Store(join(dir, 'test.db'));
  try {
    for (const group of groups) {
      store.insertCluster({ id: group.id, name: group.name, category: '', createdAt: '2026-01-01' },
        group.members.map((name, index) => ({
          id: `${group.id}-${index}`, clusterId: group.id, name, avatar: '', harness: 'mock',
          model: null, effort: null, workerSessionId: `${group.id}-${index}`, cwd: dir, origin: 'attached', removedAt: null,
        })));
    }
  } finally { store.close(); }

  const plugin = join(dir, 'plugins', 'config-demo');
  cpSync(join(REPO_ROOT, 'test', 'fixtures', 'config-demo'), plugin, { recursive: true });
  const home = join(dir, 'home');
  mkdirSync(home);
  writeFileSync(join(home, 'external-plugins.json'), JSON.stringify({ plugins: [{
    manifest: join(plugin, 'orrery-plugin.json'), clusterIds: groups.map(group => group.id),
  }] }));
  const app = await startTestHub({ dir, port, onShutdown: options.onShutdown });
  return Object.assign(app, { projectId, weeklyId });
}
