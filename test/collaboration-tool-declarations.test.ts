import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { REPO_ROOT } from '../src/main.ts';

test('collaboration tool names are allowed for isolated Claude and signed by the Antigravity hook', async () => {
  const hook = await import(pathToFileURL(join(REPO_ROOT, 'plugins', 'antigravity-orrery', 'hook.mjs')).href);
  const names = ['skip_unread', 'get_deliveries', 'list_tasks', 'list_labels', 'manage_labels', 'get_task', 'get_task_context', 'list_bookmarks', 'create_task', 'task_action',
    'raise_attention', 'resolve_attention', 'set_task_summary', 'link_message_tasks', 'bookmark_message', 'manage_roles', 'set_cluster_paused'];
  for (const name of names) {
    assert.deepEqual(hook.answer({ conversationId: 'conversation', toolCall: { name: `mcp_orrery_${name}`, args: {} } }, 'secret'),
      { decision: 'ask', overwrite: { orreryCaller: hook.callerValue('conversation', 'secret') } }, name);
  }
});
