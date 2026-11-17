// The coordinator's half of collaboration_policies: data_json and generation (docs/plugins.md). The core owns paused and
// paused_by on the same row and writes only those; neither side overwrites the other's columns.
import type { CoordinatorPolicy } from '../../core/collaboration-types.ts';
import type { Store } from '../../core/store.ts';

export function coordinatorSnapshot(store: Store, clusterId: string): { coordinator: CoordinatorPolicy | null; generation: number } {
  const row = store.db.prepare('SELECT data_json, generation FROM collaboration_policies WHERE cluster_id = ?').get(clusterId) as
    { data_json: string; generation: number } | undefined;
  return row ? { coordinator: JSON.parse(row.data_json) as CoordinatorPolicy | null, generation: row.generation } : { coordinator: null, generation: 0 };
}

export function saveCoordinator(store: Store, clusterId: string, coordinator: CoordinatorPolicy | null, generation: number): void {
  store.db.prepare(`INSERT INTO collaboration_policies (cluster_id, data_json, paused, generation, paused_by) VALUES (?, ?, 0, ?, NULL)
    ON CONFLICT(cluster_id) DO UPDATE SET data_json = excluded.data_json, generation = excluded.generation`)
    .run(clusterId, JSON.stringify(coordinator), generation);
}
