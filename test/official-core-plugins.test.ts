import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { packOfficialPlugin } from '../scripts/pack-official-plugin.ts';
import type { OfficialPlugin } from '../src/core/plugin.ts';
import type { OfficialManifest } from '../src/official-plugin-package.ts';
import { OfficialPluginUpdates, OfficialUpdateError } from '../src/official-plugin-updates.ts';
import { REPO_ROOT } from '../src/main.ts';
import { officialPlugins } from '../src/plugins/index.ts';
import { holdScript, memberHeaders, rawFetch, startTestHub, tempDir, TEST_TOKEN, type TestHub } from './helpers.ts';
import './plugin-host-hook.ts';

const KEY_ID = 'orrery-official-1';
const UPDATE = '/api/plugins/official-updates';
const EXPECTED_SHIP_SCRIPT = resolve(REPO_ROOT, 'scripts/ship.ts').replaceAll('\\', '/');

function releaseMetadata(id: string): Omit<OfficialManifest, 'files'> {
  return JSON.parse(readFileSync(join(REPO_ROOT, 'src/plugins', id, 'release.json'), 'utf8'));
}

function packFromRepoPayload(
  workRoot: string,
  tag: string,
  id: string,
  privateKey: KeyObject,
  opts: {
    overrides?: Partial<Omit<OfficialManifest, 'files'>>;
    customizePayload?: (payloadDir: string) => void;
    useCli?: boolean;
  } = {},
): Buffer {
  const stageDir = join(workRoot, 'stage-' + tag);
  const payloadDir = join(stageDir, 'package');
  mkdirSync(stageDir, { recursive: true });
  cpSync(join(REPO_ROOT, 'src/plugins', id, 'package'), payloadDir, { recursive: true });
  opts.customizePayload?.(payloadDir);
  const metadata: Omit<OfficialManifest, 'files'> = { ...releaseMetadata(id), ...opts.overrides };
  if (opts.useCli) {
    const metaPath = join(stageDir, 'release.json');
    const keyPath = join(stageDir, 'key.pem');
    const outZip = join(stageDir, `${id}-${metadata.version}.zip`);
    writeFileSync(metaPath, JSON.stringify(metadata, null, 2) + '\n');
    writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }));
    const stdout = execFileSync(
      process.execPath,
      ['scripts/pack-official-plugin.ts', payloadDir, metaPath, keyPath, outZip],
      { cwd: REPO_ROOT, encoding: 'utf8', windowsHide: true },
    );
    const bytes = readFileSync(outZip);
    assert.match(stdout.trim(), new RegExp(`^SHA-256 ${createHash('sha256').update(bytes).digest('hex')}$`));
    return bytes;
  }
  return packOfficialPlugin(payloadDir, metadata, privateKey);
}

const migrationVersion = (app: TestHub, id: string): number =>
  Number(app.store.db.prepare('SELECT version FROM plugin_migrations WHERE plugin_id = ?').get(id)?.version ?? 0);

const cardOf = async (app: TestHub, id: string) =>
  (await app.api('GET', '/api/plugins')).installed.find((p: any) => p.id === id);

async function expectPrepareFailure(app: TestHub, id: string, version: string, expectedCode: string): Promise<void> {
  const res = await rawFetch(app.url + UPDATE + '/prepare', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TEST_TOKEN}` },
    body: JSON.stringify({ id, version }),
  });
  assert.equal(res.status, 400);
  const body = await res.json() as { code?: string; error?: string };
  assert.equal(body.code, expectedCode, JSON.stringify(body));
}

async function stageAndConfirm(app: TestHub, id: string, version: string): Promise<void> {
  const check = await app.api('POST', UPDATE + '/check', {});
  assert.ok(check.candidates.some((c: { id: string; version: string; compatible: boolean }) =>
    c.id === id && c.version === version && c.compatible));
  const preview = await app.api('POST', UPDATE + '/prepare', { id, version });
  assert.equal(preview.id, id);
  assert.equal(preview.version, version);
  const confirmed = await app.api('POST', UPDATE + '/confirm', { prepareId: preview.prepareId });
  assert.deepEqual(confirmed, { id, version, restartRequired: true });
}

test('bookmarks, tasks and coordinator upgrade sequentially from signed ZIPs while enforcing dependencies, shipScript and live i18n', async (t: TestContext) => {
  const rootPkgBefore = readFileSync(join(REPO_ROOT, 'package.json'));
  const desktopPkgBefore = readFileSync(join(REPO_ROOT, 'desktop/package.json'));

  const dir = tempDir();
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const catalog: { id: string; version: string; tag: string; asset: string; sha256: string; bytes: Buffer }[] = [];
  const publish = (id: string, version: string, tag: string, bytes: Buffer) => {
    catalog.push({ id, version, tag, asset: `${id}-${version}.zip`, sha256: createHash('sha256').update(bytes).digest('hex'), bytes });
  };

  publish('bookmarks', '1.0.0', 'bookmarks-1.0.0', packFromRepoPayload(dir, 'bm-1', 'bookmarks', privateKey, {
    useCli: true,
    overrides: { version: '1.0.0' },
    customizePayload: (pkgDir) => {
      const enPath = join(pkgDir, 'web/i18n/en.json');
      const en = JSON.parse(readFileSync(enPath, 'utf8'));
      en['成员收藏'] = 'Member bookmarks 1.0.0';
      writeFileSync(enPath, JSON.stringify(en, null, 2) + '\n');
    },
  }));
  publish('tasks', '2.0.0', 'tasks-2.0.0', packFromRepoPayload(dir, 'tasks-2', 'tasks', privateKey, {
    overrides: { version: '2.0.0' },
  }));
  publish('tasks', '1.0.0', 'tasks-1.0.0', packFromRepoPayload(dir, 'tasks-1', 'tasks', privateKey, {
    overrides: { version: '1.0.0' },
  }));
  publish('coordinator', '1.0.0', 'coordinator-1.0.0', packFromRepoPayload(dir, 'coord-1', 'coordinator', privateKey, {
    overrides: {
      version: '1.0.0',
      requires: [{ id: 'tasks', minVersion: '1.0.0', beforeVersion: '2.0.0' }],
    },
  }));

  const fetcher: typeof fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/index.json')) {
      return Response.json({
        format: 1,
        releases: catalog.map(({ id, version, tag, asset, sha256 }) => ({ id, version, tag, asset, sha256 })),
      });
    }
    const found = catalog.find((item) => url.pathname.endsWith(`/${item.tag}/${item.asset}`));
    return found ? new Response(new Uint8Array(found.bytes)) : new Response(null, { status: 404 });
  };

  let hold = holdScript();
  const start = () => {
    hold = holdScript();
    return startTestHub({
      dir,
      mock: { script: hold.script },
      officialUpdates: {
        hubVersion: '0.10.0-beta.4',
        keys: new Map([[KEY_ID, { publicKey, ids: ['bookmarks', 'tasks', 'coordinator'] }]]),
        fetcher,
      },
    });
  };

  let app = await start();
  t.after(async () => {
    hold.release();
    await app.close();
    assert.deepEqual(readFileSync(join(REPO_ROOT, 'package.json')), rootPkgBefore, 'root package.json unchanged');
    assert.deepEqual(readFileSync(join(REPO_ROOT, 'desktop/package.json')), desktopPkgBefore, 'desktop/package.json unchanged');
  });

  // Seed git repo inside app.project so all members' cwd resolves directly to this repo.
  const g = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
  g(app.project, 'init', '-q', '-b', 'main');
  g(app.project, 'config', 'user.name', 'tester');
  g(app.project, 'config', 'user.email', 'tester@example.invalid');
  g(app.project, 'config', 'core.autocrlf', 'false');
  mkdirSync(join(app.project, '.premerge'), { recursive: true });
  writeFileSync(join(app.project, '.premerge/checks.json'), JSON.stringify({
    checks: [{ name: 'ok', timeout_seconds: 60, argv: ['node', '-e', 'process.exit(0)'] }],
  }));
  writeFileSync(join(app.project, 'README.md'), 'init\n');
  g(app.project, 'add', '-A');
  g(app.project, 'commit', '-qm', 'base');
  g(app.project, 'checkout', '-q', '-b', 'feat/core');
  writeFileSync(join(app.project, 'src.txt'), 'change\n');
  g(app.project, 'add', '-A');
  g(app.project, 'commit', '-qm', '[tester] feat: Core change');
  const featureSha = g(app.project, 'rev-parse', 'HEAD');
  g(app.project, 'checkout', '-q', 'main');
  const reviewerTree = join(dir, 'reviewer-tree');
  g(app.project, 'worktree', 'add', '-q', '--detach', reviewerTree, 'main');

  // Verify built-in copies start as bundled.
  for (const id of ['bookmarks', 'tasks', 'coordinator']) {
    const card = await cardOf(app, id);
    assert.equal(card.version, '0.10.0-beta.4');
    assert.equal(card.officialUpdate.source, 'bundled');
    assert.equal(card.enabled, true);
  }
  assert.equal(migrationVersion(app, 'bookmarks'), 1);
  assert.equal(migrationVersion(app, 'tasks'), 8);
  assert.equal(migrationVersion(app, 'coordinator'), 0);

  // Seed cluster, coordinator policy + standing instruction, bookmark, label, batch, and approved task awaiting ship.
  const { cluster, members: [coord, worker, reviewer] } = await app.cluster('core-up', ['Coord', 'Worker', 'Reviewer']);
  const collab = (body: Record<string, unknown>) => app.api('POST', `/api/clusters/${cluster.id}/collaboration`, body);
  const msg = await app.api('POST', `/api/clusters/${cluster.id}/messages`, { body: 'Remember this detail', to: [worker.id] });
  await collab({ action: 'bookmark.set', operationId: 'bm-1', messageId: msg.id, labels: ['keep'] });
  await collab({ action: 'coordinator.set', operationId: 'coord-1', memberId: coord.id, enabled: true, mode: 'execute' });
  await collab({ action: 'coordinator.instruction.add', operationId: 'inst-1', instructionText: 'Keep ship checks clean' });
  await collab({ action: 'label.create', operationId: 'lbl-1', name: 'core-pack' });

  const created = await collab({
    action: 'task.create',
    operationId: 'task-1',
    title: 'Ship core task',
    scope: 'ship scope',
    acceptance: 'ship checks pass',
    labels: ['core-pack'],
    memberId: worker.id,
    reviewer: { kind: 'member', memberId: reviewer.id },
  });
  const taskId = created.task.id as string;

  const started = await app.hub.collaboration.commandAsync({ kind: 'member', memberId: worker.id }, cluster.id, {
    action: 'task.start', operationId: 'start-1', taskId, expectedRevision: created.task.revision,
  });
  const submitted = await app.hub.collaboration.commandAsync({ kind: 'member', memberId: worker.id }, cluster.id, {
    action: 'task.submit', operationId: 'sub-1', taskId, expectedRevision: started.task!.revision,
    assignmentId: started.assignment!.id, summary: 'Ready on branch', commitSha: featureSha,
  });
  await app.hub.collaboration.commandAsync({ kind: 'member', memberId: reviewer.id }, cluster.id, {
    action: 'task.review', operationId: 'rev-1', taskId, expectedRevision: submitted.task!.revision,
    submissionId: submitted.submission!.id, verdict: 'approve', reason: 'looks clean',
  });

  const batch = await collab({
    action: 'batch.create', operationId: 'batch-1', title: 'Core batch', reviewer: { kind: 'member', memberId: reviewer.id },
  });
  const batchTask = await collab({
    action: 'task.create', operationId: 'task-2', title: 'Batched task', scope: 's', acceptance: 'a', batchId: batch.batch.id,
  });

  // 1) Upgrade bookmarks 1.0.0 -> restart -> verify live i18n, served files, icon, and preserved bookmark.
  await stageAndConfirm(app, 'bookmarks', '1.0.0');
  hold.release();
  await app.close();
  app = await start();

  const bmCard = await cardOf(app, 'bookmarks');
  assert.equal(bmCard.version, '1.0.0');
  assert.equal(bmCard.officialUpdate.source, 'package');
  assert.equal(bmCard.enabled, true);
  assert.equal(bmCard.iconUrl, '/api/plugins/bookmarks/icon');
  assert.equal((await fetch(app.url + '/api/plugins/bookmarks/icon')).headers.get('content-type'), 'image/svg+xml');
  assert.equal(migrationVersion(app, 'bookmarks'), 1);

  const list = await app.api('GET', '/api/plugins');
  const bmFront = list.officialFrontend.find((item: { id: string }) => item.id === 'bookmarks');
  assert.ok(bmFront?.entry && bmFront?.english);
  const enRes = await fetch(app.url + bmFront.english);
  assert.equal(enRes.status, 200);
  const upgradedEn = await enRes.json() as Record<string, string>;
  assert.equal(upgradedEn['成员收藏'], 'Member bookmarks 1.0.0');

  const entryRes = await fetch(app.url + bmFront.entry);
  assert.equal(entryRes.status, 200);
  const entrySource = await entryRes.text();
  const wordsPath = bmFront.entry.replace(/\/index\.js$/, '/words.js');
  const wordsRes = await fetch(app.url + wordsPath);
  assert.equal(wordsRes.status, 200);
  const webProbeDir = join(dir, 'bm-web-probe');
  mkdirSync(webProbeDir, { recursive: true });
  writeFileSync(join(webProbeDir, 'package.json'), JSON.stringify({ type: 'module' }));
  writeFileSync(join(webProbeDir, 'words.js'), await wordsRes.text());
  writeFileSync(join(webProbeDir, 'index.js'), entrySource);

  const { detachPluginSlots, loadPluginSlots } = await import(pathToFileURL(join(REPO_ROOT, 'src/web/public/plugin-slots.js')).href);
  const { setLanguage } = await import(pathToFileURL(join(REPO_ROOT, 'src/web/public/i18n.js')).href);
  const { isLive } = await import(pathToFileURL(join(REPO_ROOT, 'src/web/public/ui.js')).href);

  const slots = await loadPluginSlots(
    { plugins: [{ id: 'bookmarks' }], frontend: [], trustedFrontend: [], officialFrontend: [bmFront] },
    { api: async () => ({}), ui: {} },
    () => assert.fail('must use officialFrontend'),
    () => assert.fail('must use officialFrontend'),
    () => true,
    {
      loadEnglish: async () => upgradedEn,
      loadOfficial: () => import(pathToFileURL(join(webProbeDir, 'index.js')).href),
    },
  );
  try {
    assert.equal(slots.workbench.length, 1);
    assert.equal(slots.panel.length, 1);
    assert.equal(slots.panel[0].key, 'bookmarks:bookmarks');
    const tab = slots.workbench[0]({});
    assert.equal(isLive(tab.label), true, 'upgraded bookmarks tab label uses live translation');
    setLanguage('zh');
    assert.equal(String(tab.label), '成员收藏');
    setLanguage('en');
    assert.equal(String(tab.label), 'Member bookmarks 1.0.0');
  } finally {
    detachPluginSlots(slots, ['bookmarks']);
    setLanguage('zh');
  }

  const savedCollections = app.hub.collaboration.query({ kind: 'user' }, cluster.id, { kind: 'collections' }) as { items: { message: { id: string } }[] };
  assert.ok(savedCollections.items.some((item) => item.message.id === msg.id));

  // 2) Incompatible candidate checks before tasks upgrade.
  const preCheck = await app.api('POST', UPDATE + '/check', {});
  assert.ok(preCheck.candidates.some((c: { id: string; version: string }) => c.id === 'tasks' && c.version === '2.0.0'));
  assert.ok(preCheck.candidates.some((c: { id: string; version: string }) => c.id === 'coordinator' && c.version === '1.0.0'));
  await expectPrepareFailure(app, 'tasks', '2.0.0', 'OFFICIAL_DEPENDENCY_CONFLICT');
  await expectPrepareFailure(app, 'coordinator', '1.0.0', 'OFFICIAL_DEPENDENCY_CONFLICT');
  assert.equal((await cardOf(app, 'tasks')).officialUpdate.pendingVersion, undefined);
  assert.equal((await cardOf(app, 'coordinator')).officialUpdate.pendingVersion, undefined);

  // 3) Upgrade tasks 1.0.0 -> restart -> verify persisted data, migration count, and REPO_ROOT scripts/ship.ts resolution.
  await stageAndConfirm(app, 'tasks', '1.0.0');
  hold.release();
  await app.close();
  app = await start();

  const tasksCard = await cardOf(app, 'tasks');
  assert.equal(tasksCard.version, '1.0.0');
  assert.equal(tasksCard.officialUpdate.source, 'package');
  assert.equal((await cardOf(app, 'coordinator')).version, '0.10.0-beta.4');
  assert.equal((await cardOf(app, 'coordinator')).officialUpdate.source, 'bundled');
  assert.equal(migrationVersion(app, 'tasks'), 8);

  const client = new Client({ name: 't', version: '0' });
  const transport = new StreamableHTTPClientTransport(new URL(app.url + '/mcp'), { requestInit: { headers: memberHeaders(app, reviewer.id) } });
  await client.connect(transport);
  try {
    const taskRes = await client.callTool({ name: 'get_task', arguments: { taskId } });
    const parsed = JSON.parse((taskRes.content as { type: string; text: string }[])[0].text);
    assert.equal(parsed.task.status, 'completed');
    assert.ok(parsed.ship?.command?.includes(`node "${EXPECTED_SHIP_SCRIPT}" --ticket `), parsed.ship?.command);
    assert.equal(parsed.ship.command.includes('official-plugins'), false, 'ship script stays in the Hub checkout, not inside package state');
  } finally {
    await client.close();
  }

  // 4) Upgrade coordinator 1.0.0 -> restart -> verify all 3 run as upgraded signed packages and preserve state + ship works end-to-end.
  await stageAndConfirm(app, 'coordinator', '1.0.0');
  hold.release();
  await app.close();
  app = await start();

  for (const id of ['bookmarks', 'tasks', 'coordinator']) {
    const card = await cardOf(app, id);
    assert.equal(card.version, '1.0.0');
    assert.equal(card.officialUpdate.source, 'package');
    assert.equal(card.enabled, true);
  }
  assert.equal(migrationVersion(app, 'coordinator'), 0);

  const workspace = app.hub.collaboration.query({ kind: 'user' }, cluster.id, { kind: 'workspace', includeClosed: true }) as any;
  assert.equal(workspace.coordinator?.memberId, coord.id);
  assert.equal(workspace.coordinator?.standingInstructions?.[0]?.text, 'Keep ship checks clean');
  assert.ok(workspace.tasks.some((tItem: { id: string; title: string }) => tItem.id === taskId && tItem.title === 'Ship core task'));
  assert.ok(workspace.tasks.some((tItem: { id: string; batchId?: string }) => tItem.id === batchTask.task.id && tItem.batchId === batch.batch.id));
  assert.ok(workspace.labels?.includes('core-pack'));

  const revClient = new Client({ name: 't', version: '0' });
  const revTransport = new StreamableHTTPClientTransport(new URL(app.url + '/mcp'), { requestInit: { headers: memberHeaders(app, reviewer.id) } });
  await revClient.connect(revTransport);
  try {
    const res = await revClient.callTool({ name: 'get_task', arguments: { taskId } });
    const parsed = JSON.parse((res.content as { type: string; text: string }[])[0].text);
    const shipCommandLine: string = parsed.ship.command;
    const ticket = /--ticket (\S+)/.exec(shipCommandLine)![1];
    assert.ok(shipCommandLine.includes(`node "${EXPECTED_SHIP_SCRIPT}" --ticket `));
    assert.equal(shipCommandLine.includes('official-plugins'), false);

    const run = await new Promise<{ status: number | null; stderr: string }>((done) => {
      const child = spawn(
        process.execPath,
        [EXPECTED_SHIP_SCRIPT, '--ticket', ticket, '--hub', app.url, '--agent', 'gemini', '--type', 'feat', '--summary', 'Ship after core package upgrades'],
        { cwd: reviewerTree, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true },
      );
      let stderr = '';
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('close', (status) => done({ status, stderr }));
    });
    assert.equal(run.status, 0, run.stderr);
    assert.equal((app.hub.collaboration.query({ kind: 'user' }, cluster.id, { kind: 'task', taskId }) as any).task.status, 'merged');
  } finally {
    await revClient.close();
  }
});

test('OfficialPluginUpdates refuses all-bundled incompatible dependencies, metadata mismatches, and higher DB migration floors', async () => {
  const dir = tempDir();
  const baseTasks = officialPlugins.find((p) => p.id === 'tasks')!;
  const baseCoord = officialPlugins.find((p) => p.id === 'coordinator')!;
  const dummyPlugin = (base: OfficialPlugin, overrides: Partial<OfficialPlugin> = {}): OfficialPlugin => ({
    ...base,
    packageSource: undefined,
    ...overrides,
  });

  // 1) All-bundled incompatible dependency versions (tasks 2.0.0 breaks bundled coordinator requires beforeVersion 2.0.0).
  const conflictHome = join(dir, 'conflict-home');
  mkdirSync(conflictHome, { recursive: true });
  const conflictDir = join(dir, 'conflict-coord');
  cpSync(join(REPO_ROOT, 'src/plugins/coordinator/package'), conflictDir, { recursive: true });
  const conflictUpdates = new OfficialPluginUpdates({
    home: conflictHome,
    dbPath: join(dir, 'conflict.db'),
    hubVersion: '0.10.0-beta.4',
    builtins: [
      dummyPlugin(baseTasks, { version: '2.0.0' }),
      {
        ...baseCoord,
        packageSource: { directory: conflictDir, metadata: releaseMetadata('coordinator') },
      },
    ],
    switches: () => ({ disabled: [], enabled: [] }),
    envDisabled: [],
  });
  await assert.rejects(() => conflictUpdates.boot(), (err: unknown) =>
    err instanceof OfficialUpdateError && err.code === 'OFFICIAL_NO_COMPATIBLE_SET');

  // 2) bundled() detects release metadata mismatch (migrationVersion or requires mismatch).
  const mismatchHome = join(dir, 'mismatch-home');
  mkdirSync(mismatchHome, { recursive: true });
  const mismatchMeta = { ...releaseMetadata('tasks'), migrationVersion: 99 };
  const mismatchUpdates = new OfficialPluginUpdates({
    home: mismatchHome,
    dbPath: join(dir, 'mismatch.db'),
    hubVersion: '0.10.0-beta.4',
    builtins: [
      {
        ...baseTasks,
        packageSource: { directory: join(REPO_ROOT, 'src/plugins/tasks/package'), metadata: mismatchMeta },
      },
    ],
    switches: () => ({ disabled: [], enabled: [] }),
    envDisabled: [],
  });
  await assert.rejects(() => mismatchUpdates.boot(), (err: unknown) =>
    err instanceof OfficialUpdateError && err.code === 'OFFICIAL_NO_COMPATIBLE_SET' && /不一致/.test(err.message));

  const requiresMismatchMeta = { ...releaseMetadata('coordinator'), requires: [] };
  const requiresUpdates = new OfficialPluginUpdates({
    home: mismatchHome,
    dbPath: join(dir, 'requires-mismatch.db'),
    hubVersion: '0.10.0-beta.4',
    builtins: [
      dummyPlugin(baseTasks),
      {
        ...baseCoord,
        packageSource: { directory: join(REPO_ROOT, 'src/plugins/coordinator/package'), metadata: requiresMismatchMeta },
      },
    ],
    switches: () => ({ disabled: [], enabled: [] }),
    envDisabled: [],
  });
  await assert.rejects(() => requiresUpdates.boot(), (err: unknown) =>
    err instanceof OfficialUpdateError && err.code === 'OFFICIAL_NO_COMPATIBLE_SET' && /不一致/.test(err.message));

  // 3) Higher DB migration floor refuses bundled tasks (tasks=9 > bundled 8).
  const dbHome = join(dir, 'db-home');
  mkdirSync(dbHome, { recursive: true });
  const dbPath = join(dir, 'higher.db');
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE plugin_migrations (plugin_id TEXT PRIMARY KEY, version INTEGER NOT NULL)');
  db.prepare('INSERT INTO plugin_migrations (plugin_id, version) VALUES (?, ?)').run('tasks', 9);
  db.close();

  const floorUpdates = new OfficialPluginUpdates({
    home: dbHome,
    dbPath,
    hubVersion: '0.10.0-beta.4',
    builtins: [baseTasks],
    switches: () => ({ disabled: [], enabled: [] }),
    envDisabled: [],
  });
  await assert.rejects(() => floorUpdates.boot(), (err: unknown) =>
    err instanceof OfficialUpdateError && err.code === 'OFFICIAL_NO_COMPATIBLE_SET' && /迁移/.test(err.message));
});

test('older Hub (0.10.0-beta.3) refuses 0.10.0-beta.4 / 2.0.0 Star Map 2.0 official packages and stays on prior packages', async (t) => {
  const dir = tempDir();
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const catalog: { id: string; version: string; tag: string; asset: string; hub: { api: number; minVersion: string }; bytes: Buffer; sha256: string }[] = [];
  const publish = (id: string, version: string, tag: string, hub: { api: number; minVersion: string }, bytes: Buffer) => {
    catalog.push({ id, version, tag, asset: `${id}.zip`, hub, bytes, sha256: createHash('sha256').update(bytes).digest('hex') });
  };
  for (const id of ['tasks', 'coordinator', 'bookmarks', 'starmap'] as const) {
    const meta = releaseMetadata(id);
    assert.equal(meta.hub.minVersion, '0.10.0-beta.4', `${id} release.json bumps hub.minVersion to 0.10.0-beta.4`);
    // Publish a newer package requiring Hub >= 0.10.0-beta.4 (next patch over built-in release metadata).
    const nextVersion = id === 'starmap' ? '2.0.1' : '0.10.0-beta.5';
    publish(id, nextVersion, `${id}-${nextVersion}`, meta.hub, packFromRepoPayload(dir, `${id}-next`, id, privateKey, {
      overrides: { version: nextVersion },
    }));
  }
  const fetcher: typeof fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/index.json')) {
      return Response.json({ format: 1, releases: catalog.map(({ id, version, tag, asset, hub, sha256 }) => ({ id, version, tag, asset, hub, sha256 })) });
    }
    const found = catalog.find((item) => url.pathname.endsWith(`/${item.tag}/${item.asset}`));
    return found ? new Response(new Uint8Array(found.bytes)) : new Response(null, { status: 404 });
  };

  // Simulate an older 0.10.0-beta.3 Hub running prior built-in plugins compatible with 0.10.0-beta.3.
  const priorBuiltins: OfficialPlugin[] = officialPlugins.map((plugin) => {
    if (!plugin.packageSource) return plugin;
    return {
      ...plugin,
      version: plugin.id === 'starmap' ? '1.0.0' : '0.10.0-beta.2',
      packageSource: {
        directory: plugin.packageSource.directory,
        metadata: {
          ...(plugin.packageSource.metadata as Record<string, unknown>),
          version: plugin.id === 'starmap' ? '1.0.0' : '0.10.0-beta.2',
          hub: { api: 1, minVersion: '0.10.0-beta.3' },
          ...(plugin.id === 'coordinator' ? { requires: [{ id: 'tasks', minVersion: '0.10.0-beta.2', beforeVersion: '2.0.0' }] } : {}),
        },
      },
    };
  });
  const updates = new OfficialPluginUpdates({
    home: join(dir, 'old-hub-home'),
    dbPath: join(dir, 'old-hub.db'),
    hubVersion: '0.10.0-beta.3',
    builtins: priorBuiltins,
    keys: new Map([[KEY_ID, { publicKey, ids: ['tasks', 'coordinator', 'bookmarks', 'starmap'] }]]),
    fetcher,
    switches: () => ({ disabled: [], enabled: ['starmap'] }),
    envDisabled: [],
  });
  const booted = await updates.boot();
  t.after(() => {});
  assert.equal(booted.find((p) => p.id === 'tasks')?.version, '0.10.0-beta.2');
  assert.equal(booted.find((p) => p.id === 'starmap')?.version, '1.0.0');
  const check = await updates.check();
  for (const id of ['tasks', 'coordinator', 'bookmarks', 'starmap']) {
    const nextVersion = id === 'starmap' ? '2.0.1' : '0.10.0-beta.5';
    const candidate = check.candidates.find((c) => c.id === id && c.version === nextVersion);
    assert.ok(candidate, `${id} candidate listed`);
    assert.equal(candidate.compatible, false, `${id} marked incompatible with 0.10.0-beta.3 Hub`);
    await assert.rejects(() => updates.prepare(id, nextVersion), (err: unknown) =>
      err instanceof OfficialUpdateError && err.code === 'OFFICIAL_HUB_INCOMPATIBLE');
  }
  // Confirm active selection stayed untouched on prior versions.
  const rebooted = await updates.boot();
  assert.equal(rebooted.find((p) => p.id === 'tasks')?.version, '0.10.0-beta.2');
  assert.equal(rebooted.find((p) => p.id === 'bookmarks')?.version, '0.10.0-beta.2');
  assert.equal(rebooted.find((p) => p.id === 'coordinator')?.version, '0.10.0-beta.2');
  assert.equal(rebooted.find((p) => p.id === 'starmap')?.version, '1.0.0');
});

test('official cluster panels keep independent instances across two clusters and match desktop/root beta.4 version', async () => {
  const rootPkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
  const desktopPkg = JSON.parse(readFileSync(join(REPO_ROOT, 'desktop', 'package.json'), 'utf8'));
  const desktopLock = JSON.parse(readFileSync(join(REPO_ROOT, 'desktop', 'package-lock.json'), 'utf8'));
  assert.equal(desktopPkg.version, rootPkg.version, 'desktop/package.json version must match root package.json');
  assert.equal(desktopLock.version, rootPkg.version, 'desktop/package-lock.json version must match root package.json');
  assert.equal(desktopLock.packages['']?.version, rootPkg.version, 'desktop/package-lock.json root package version must match');

  // Verify tasks isolates cluster A and B instances, coordinator adds no duplicate Dock panel,
  // and bookmarks only registers a standalone panel when tasks is disabled.
  const active = new Map<unknown, string>();
  const unmounted: string[] = [];
  const workbench = {
    tasksEnabled: () => true,
    stalledCount: () => 0,
    mountEmbedded(el: unknown, opts: { clusterId?: string; tab?: string }) {
      const tag = `${opts.tab}:${opts.clusterId}`;
      active.set(el, tag);
      return {
        unmount() {
          if (active.has(el)) {
            unmounted.push(active.get(el)!);
            active.delete(el);
          }
        },
      };
    },
  };
  const tasksMod = await import(pathToFileURL(join(REPO_ROOT, 'src/plugins/tasks/package/web/index.js')).href);
  const coordMod = await import(pathToFileURL(join(REPO_ROOT, 'src/plugins/coordinator/package/web/index.js')).href);
  const bmMod = await import(pathToFileURL(join(REPO_ROOT, 'src/plugins/bookmarks/package/web/index.js')).href);
  const tasksPanel = tasksMod.register({ workbench }).panel.find((p: { id: string }) => p.id === 'tasks');
  assert.equal(coordMod.register({ workbench }).panel, undefined, 'coordinator lives inside the unified tasks tabbed workbench');
  assert.equal(bmMod.register({ workbench }).panel, undefined, 'bookmarks lives inside the unified tasks workbench when tasks is enabled');
  const bmStandalone = bmMod.register({ workbench: { ...workbench, tasksEnabled: () => false } }).panel;
  assert.equal(bmStandalone?.id, 'bookmarks', 'bookmarks provides a standalone Star Map panel when tasks is disabled');

  const elA = { replaceChildren() {} };
  const elB = { replaceChildren() {} };
  const cleanA = tasksPanel.mount(elA, { clusterId: 'cluster-a', close() {}, openCluster() {}, openMember() {} });
  const cleanB = tasksPanel.mount(elB, { clusterId: 'cluster-b', close() {}, openCluster() {}, openMember() {} });
  assert.equal(active.size, 2, 'both cluster panel instances remain mounted independently');

  cleanA();
  tasksPanel.unmount(elA);
  assert.equal(active.size, 1, 'closing tasks(cluster-a) keeps cluster-b alive');
  assert.deepEqual(unmounted, ['tasks:cluster-a']);

  cleanB();
  assert.equal(active.size, 0);
  assert.deepEqual(unmounted, ['tasks:cluster-a', 'tasks:cluster-b']);
});
