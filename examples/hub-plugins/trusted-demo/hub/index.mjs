// A full-trust plugin's Hub entry (docs/external-plugins.md「完全信任的插件」). It runs in the Hub process only after
// the user confirmed it on the settings page, and is handed { hostApi, z }: the interface version and the Hub's zod.
// It returns the same slots an official plugin has. Its names come from the id in its own manifest, so a copy under
// another id works too: tables x_<id>_…, routes /api/x/<id>/…, the action <id>.note and the tool <id>_note.
import { readFileSync } from 'node:fs';

const { id } = JSON.parse(readFileSync(new URL('../orrery-plugin.json', import.meta.url), 'utf8'));
const name = id.replaceAll('-', '_');
const TABLE = `x_${name}_notes`;
const MAX_NOTE = 500;
const NOTES = new RegExp(`^/api/x/${id}/clusters/([^/]+)/notes$`);

/** The cluster's newest notes, newest first. */
function notesOf(store, clusterId) {
  return store.db.prepare(`SELECT id, author, body, created_at AS createdAt FROM ${TABLE} WHERE cluster_id = ? ORDER BY id DESC LIMIT 50`)
    .all(clusterId).map((row) => ({ ...row }));
}

function addNote(store, clusterId, author, body, now) {
  if (typeof body !== 'string' || !body.trim() || body.length > MAX_NOTE) throw new Error(`a note is 1 to ${MAX_NOTE} characters`);
  store.db.prepare(`INSERT INTO ${TABLE} (cluster_id, author, body, created_at) VALUES (?, ?, ?, ?)`).run(clusterId, author, body.trim(), now);
}

function cluster(hub, clusterId) {
  if (!hub.store.getCluster(clusterId)) throw new Error('unknown cluster');
  return clusterId;
}

export default function trustedDemo({ hostApi, z }) {
  if (hostApi !== 1) throw new Error(`this plugin speaks hostApi 1, not ${hostApi}`);
  return {
    migrations: [
      `CREATE TABLE ${TABLE} (id INTEGER PRIMARY KEY, cluster_id TEXT NOT NULL, author TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL);
       CREATE INDEX ${TABLE}_cluster ON ${TABLE} (cluster_id)`,
    ],
    // A member's note goes through the core's command path: identity, operationId and the event are the core's.
    actions: {
      [`${id}.note`]: ({ store, clusterId, actorId, command, now }) => {
        addNote(store, clusterId, store.getMember(actorId)?.name ?? actorId, command.body, now);
        return { notes: notesOf(store, clusterId).length };
      },
    },
    tools(api) {
      api.command(`${name}_note`, 'Leave a short note on this cluster\'s note board (an example plugin). The user sees them next to the chat input.',
        { body: z.string().min(1).max(MAX_NOTE).describe('The note, at most 500 characters') }, `${id}.note`);
    },
    // The page's own requests: under /api/x/<id>/, behind the user's login like every /api/* route.
    routes: [
      { method: 'GET', pattern: NOTES, handle: ({ hub, params }) => ({ notes: notesOf(hub.store, cluster(hub, params[0])) }) },
      { method: 'POST', pattern: NOTES, handle: ({ hub, params, body }) => {
        addNote(hub.store, cluster(hub, params[0]), '用户', body?.body, new Date().toISOString());
        return { notes: notesOf(hub.store, params[0]) };
      } },
    ],
    // The one hook: a cluster deleted for good takes its notes with it.
    clusterPurging: (store, clusterId) => { store.db.prepare(`DELETE FROM ${TABLE} WHERE cluster_id = ?`).run(clusterId); },
  };
}
