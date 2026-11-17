// Acceptance criterion 10: module dependency rules from docs/architecture.md and docs/native-mode.md, checked on every import in src/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, posix, relative } from 'node:path';
import { REPO_ROOT } from '../src/main.ts';

type Source = { path: string; code: string };   // path is relative to src/, with forward slashes

const IMPORT_RE = /(?:^|\s)(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\s*\(?\s*['"]([^'"]+)['"]/g;

// shortcut: regex covers the project's import forms, not a JS parser; use one if richer computed imports are added.
// Calls keep their entire argument so concatenation and unknown templates cannot pass as a relative literal.
const BROWSER_IMPORT_RE = /(?:^|\s)(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|(?:^|\s)import\s*['"]([^'"]+)['"]|\b(?:import|require)\s*\(([^)]*)\)/g;
const browserImports = (code: string) => [...code.matchAll(BROWSER_IMPORT_RE)].map((m) => {
  if (m[1] !== undefined || m[2] !== undefined) return m[1] ?? m[2];
  const expression = m[3].trim();
  return /^(['"`])([^'"`$]*)\1$/.exec(expression)?.[2] ?? expression;
});

/** Returns one line per violation; empty means the sources follow the rules. */
export function checkBoundaries(sources: Source[]): string[] {
  const violations: string[] = [];
  for (const { path, code } of sources) {
    const area = path.includes('/') ? path.split('/')[0] : path;   // 'core' | 'adapters' | 'bridge' | 'mcp' | 'web' | 'main.ts' | 'config.ts' | 'launcher.ts'
    const browser = path.startsWith('web/public/');
    const specs = browser ? browserImports(code) : [...code.matchAll(IMPORT_RE)].map((m) => m[1] ?? m[2]);
    for (const spec of specs) {
      if (!browser && spec.startsWith('node:')) continue;
      const relativeImport = spec.startsWith('.');
      const target = relativeImport ? posix.normalize(posix.join(posix.dirname(path), spec)) : null;
      let ok: boolean;
      if (browser) {
        ok = target !== null && target.startsWith('web/public/')
          // This pure table is served explicitly at /core/system-kinds.js; only its public re-export may reach it.
          || (path === 'web/public/system-kinds.js' && spec === '../../core/system-kinds.js')
          // loadPluginSlots validates id against enabled official registry entries before invoking this loader.
          || (path === 'web/public/plugin-slots.js' && spec === '`./official-plugins/${id}.js`');
      } else if (area === 'main.ts') ok = true;
      else if (area === 'config.ts') ok = false;                  // node built-ins only
      else if (area === 'launcher.ts') ok = target === 'config.ts';   // talks to the Hub over hub.json and HTTP only
      else if (area === 'backup.ts') ok = target === 'config.ts';     // standalone backup CLI: config plus node built-ins
      else if (area === 'core') ok = target !== null && target.startsWith('core/');
      else if (area === 'adapters') {
        // adapters/<harness>/* may import core/types.ts, files in its own folder and adapters/shared/* (helpers for
        // the harnesses' own files, which import only core/types.ts); the registry (adapters/index.ts) may import any
        // adapter folder.
        const dir = posix.dirname(path);
        ok = target === null || target === 'core/types.ts'
          || (path === 'adapters/index.ts' && target.startsWith('adapters/'))
          || (dir !== 'adapters' && posix.dirname(target) === dir)
          || (dir !== 'adapters' && dir !== 'adapters/shared' && posix.dirname(target) === 'adapters/shared');
      } else if (area === 'bridge') {
        ok = target === null;   // a standalone program: node built-ins and npm packages only
      } else if (area === 'mcp' || area === 'web') {
        ok = target === null || target.startsWith('core/') || target.startsWith(`${area}/`);
      } else if (area === 'plugins') {
        // plugins/<id>/* may import core, its own folder and npm packages; only the registry (plugins/index.ts) imports
        // plugin folders, and only the composition root (main.ts) imports the registry.
        const dir = posix.dirname(path);
        ok = target === null || target.startsWith('core/')
          || (path === 'plugins/index.ts' && target.startsWith('plugins/'))
          || (dir !== 'plugins' && (target === dir || target.startsWith(`${dir}/`)));
      } else ok = false;
      if (!ok) violations.push(`${path} imports ${spec}`);
    }
  }
  return violations;
}

function srcFiles(dir: string): Source[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.ts') || /^web[\\/]public[\\/].*\.js$/.test(f))
    .map((f) => ({ path: relative(dir, join(dir, f)).replaceAll('\\', '/'), code: readFileSync(join(dir, f), 'utf8') }));
}

test('10: src/ follows the dependency rules', () => {
  const files = srcFiles(join(REPO_ROOT, 'src'));
  assert.ok(files.length >= 8, 'found the source files');
  assert.ok(files.some((f) => f.path === 'web/public/app.js'), 'includes browser scripts');
  assert.ok(files.some((f) => f.path === 'web/public/official-plugins/bookmarks.js'), 'includes browser plugin scripts');
  assert.deepEqual(checkBoundaries(files), []);
});

test('browser dependency rules reject Node, backend, desktop and computed imports', () => {
  const bad: Source[] = [
    { path: 'web/public/app.js', code: "import { readFile } from 'node:fs';" },
    { path: 'web/public/app.js', code: "import { shell } from 'electron';" },
    { path: 'web/public/app.js', code: "import '../server.ts';" },
    { path: 'web/public/app.js', code: "export { Hub } from '../../core/hub.ts';" },
    { path: 'web/public/app.js', code: "const desktop = import('../../../desktop/shell.mjs');" },
    { path: 'web/public/official-plugins/bookmarks.js', code: "import { Hub } from '../../../core/hub.ts';" },
    { path: 'web/public/app.js', code: "export * from '../../core/system-kinds.js';" },
    { path: 'web/public/app.js', code: 'import(target);' },
    { path: 'web/public/app.js', code: "import('./' + target);" },
    { path: 'web/public/plugin-slots.js', code: 'import(`./${target}.js`);' },
    { path: 'web/public/app.js', code: "require('node:fs');" },
  ];
  for (const source of bad) assert.equal(checkBoundaries([source]).length, 1, source.code);
  assert.deepEqual(checkBoundaries([
    { path: 'web/public/app.js', code: "import { h } from './ui.js';\nexport * from './task-refs.js';" },
    { path: 'web/public/official-plugins/bookmarks.js', code: "import { h } from '../ui.js';" },
    { path: 'web/public/system-kinds.js', code: "export * from '../../core/system-kinds.js';" },
    { path: 'web/public/plugin-slots.js', code: 'const load = (id) => import(`./official-plugins/${id}.js`);' },
  ]), []);
});

test('10: the checker catches deliberate violations', () => {
  const bad: Source[] = [
    { path: 'core/hub.ts', code: "import { handleWeb } from '../web/server.ts';" },
    { path: 'core/store.ts', code: "import { z } from 'zod';" },
    { path: 'adapters/mock/native.ts', code: "import type { Hub } from '../../core/hub.ts';" },
    { path: 'mcp/server.ts', code: "import { handleWeb } from '../web/server.ts';" },
    { path: 'web/server.ts', code: "const m = await import('../mcp/server.ts');" },
    { path: 'adapters/claude/native.ts', code: "export { createMockNativeAdapter } from '../mock/native.ts';" },
    { path: 'adapters/codex/native.ts', code: "import { Store } from '../../core/store.ts';" },
    { path: 'adapters/claude/native.ts', code: "import { x } from '../index.ts';" },
    { path: 'bridge/claude-bridge.ts', code: "import type { BridgePort } from '../core/types.ts';" },
    { path: 'bridge/claude-bridge.ts', code: "import { pathKey } from '../adapters/claude/store.ts';" },
    { path: 'launcher.ts', code: "import { startHub } from './main.ts';" },
    { path: 'launcher.ts', code: "import type { Hub } from './core/hub.ts';" },
    { path: 'launcher.ts', code: "import { handleWeb } from './web/server.ts';" },
    { path: 'launcher.ts', code: "import { z } from 'zod';" },
    { path: 'config.ts', code: "import type { Limits } from './core/hub.ts';" },
    { path: 'adapters/shared/jsonl.ts', code: "import { codexBinary } from '../codex/native.ts';" },
    { path: 'core/collaboration.ts', code: "import { bookmarks } from '../plugins/bookmarks/index.ts';" },
    { path: 'core/store.ts', code: "import { officialPlugins } from '../plugins/index.ts';" },
    { path: 'mcp/server.ts', code: "import { bookmarks } from '../plugins/bookmarks/index.ts';" },
    { path: 'web/server.ts', code: "import { officialPlugins } from '../plugins/index.ts';" },
    { path: 'plugins/bookmarks/index.ts', code: "import { handleWeb } from '../../web/server.ts';" },
    { path: 'plugins/bookmarks/index.ts', code: "import { tasks } from '../tasks/index.ts';" },
    { path: 'plugins/bookmarks/index.ts', code: "import { officialPlugins } from '../index.ts';" },
    { path: 'core/hub.ts', code: "import { TasksService } from '../plugins/tasks/service.ts';" },
    { path: 'mcp/server.ts', code: "import { taskTools } from '../plugins/tasks/tools.ts';" },
    { path: 'web/server.ts', code: "import { taskRoutes } from '../plugins/tasks/routes.ts';" },
    { path: 'plugins/tasks/ship.ts', code: "import { handleBridge } from '../../mcp/bridge.ts';" },
    { path: 'plugins/tasks/actions.ts', code: "import { coordinatorSnapshot } from '../coordinator/store.ts';" },
    { path: 'plugins/tasks/service.ts', code: "import { coordinator } from '../coordinator/index.ts';" },
    { path: 'plugins/coordinator/actions.ts', code: "import { allTasks } from '../tasks/model.ts';" },
    { path: 'core/hub.ts', code: "import { coordinator } from '../plugins/coordinator/index.ts';" },
    { path: 'mcp/server.ts', code: "import { COORDINATOR_RULES } from '../plugins/coordinator/coordinator-rules.ts';" },
    { path: 'web/server.ts', code: "import { coordinator } from '../plugins/coordinator/index.ts';" },
  ];
  assert.deepEqual(checkBoundaries(bad), bad.map((s) => `${s.path} imports ${/['"]([^'"]+)['"]/.exec(s.code)![1]}`));
  // And the allowed shapes stay allowed.
  assert.deepEqual(checkBoundaries([
    { path: 'core/hub.ts', code: "import type { Store } from './store.ts';\nimport { mkdirSync } from 'node:fs';" },
    { path: 'adapters/index.ts', code: "import { createMockNativeAdapter } from './mock/native.ts';" },
    { path: 'adapters/mock/native.ts', code: "import { Client } from '@modelcontextprotocol/sdk/client/index.js';" },
    { path: 'adapters/claude/native.ts', code: "import { createSessionStore } from './store.ts';\nimport type { NativeAdapter } from '../../core/types.ts';" },
    { path: 'adapters/codex/usage.ts', code: "import { lastMatch } from '../shared/jsonl.ts';" },
    { path: 'bridge/claude-bridge.ts', code: "import { Client } from '@modelcontextprotocol/sdk/client/index.js';\nimport { readFile } from 'node:fs/promises';" },
    { path: 'web/server.ts', code: "import type { Hub } from '../core/hub.ts';" },
    { path: 'main.ts', code: "import { handleMcp } from './mcp/server.ts';" },
    { path: 'launcher.ts', code: "import { resolveConfig } from './config.ts';\nimport { spawn } from 'node:child_process';" },
    { path: 'config.ts', code: "import { homedir } from 'node:os';" },
    { path: 'main.ts', code: "import { officialPlugins } from './plugins/index.ts';" },
    { path: 'plugins/index.ts', code: "import { bookmarks } from './bookmarks/index.ts';\nimport type { OfficialPlugin } from '../core/plugin.ts';" },
    { path: 'plugins/bookmarks/index.ts', code: "import { z } from 'zod';\nimport { helper } from './store.ts';\nimport type { Store } from '../../core/store.ts';" },
  ]), []);
});

test('launcher 8: the launcher imports only node built-ins and config.ts; config.ts only node built-ins', () => {
  const src = join(REPO_ROOT, 'src');
  const specs = (file: string) => [...readFileSync(join(src, file), 'utf8').matchAll(IMPORT_RE)].map((m) => m[1] ?? m[2]);
  assert.deepEqual(specs('launcher.ts').filter((s) => !s.startsWith('node:')), ['./config.ts']);
  assert.deepEqual(specs('config.ts').filter((s) => !s.startsWith('node:')), []);
});
