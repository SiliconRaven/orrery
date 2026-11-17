import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const NODE_VERSION = '24.19.0';
// Pinned independently from https://nodejs.org/en/blog/release/v24.19.0/ (official signed SHASUMS).
export const NODE_SHA256 = '57f71ab3652e797d84acddc79c81cc9ff1c6ddb2a1974cdb83f00fee9bff4c73';
const archiveName = `node-v${NODE_VERSION}-win-x64.zip`;
const release = `https://nodejs.org/dist/v${NODE_VERSION}/`;
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const HUB_INPUTS = ['src', 'plugins', 'package.json', 'package-lock.json', 'LICENSE', 'scripts/ship.ts', 'scripts/test-queue.ts'];

export function verifySha256(bytes, expected = NODE_SHA256) {
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== expected) throw new Error(`Node archive SHA256 mismatch: expected ${expected}, got ${actual}`);
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, windowsHide: true, stdio: 'inherit' });
  if (result.error || result.status !== 0) throw new Error(`${command} failed: ${result.error?.message ?? `exit ${result.status}`}`);
}

export async function stageHub(source, destination) {
  const result = spawnSync('git', ['ls-files', '-z', '--', ...HUB_INPUTS], { cwd: source, encoding: 'utf8', windowsHide: true });
  if (result.error || result.status !== 0) throw new Error(`Cannot list tracked Hub inputs: ${result.error?.message ?? result.stderr}`);
  const files = result.stdout.split('\0').filter(Boolean);
  for (const required of ['src/main.ts', 'package.json', 'package-lock.json', 'LICENSE', 'scripts/ship.ts', 'scripts/test-queue.ts']) {
    if (!files.includes(required)) throw new Error(`Missing tracked Hub runtime input: ${required}`);
  }
  for (const file of files) {
    await mkdir(dirname(join(destination, file)), { recursive: true });
    await cp(join(source, file), join(destination, file));
  }
}

async function download(url, destination) {
  if (existsSync(destination)) return;
  console.log(`Downloading ${url}`);
  const response = await fetch(url, { signal: AbortSignal.timeout(180_000) });
  if (!response.ok) throw new Error(`Download failed (${response.status}): ${url}`);
  await writeFile(`${destination}.part`, Buffer.from(await response.arrayBuffer()));
  await rename(`${destination}.part`, destination);
}

export async function prepareResources() {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Resource preparation requires Windows x64.');
  const cache = join(root, 'desktop', '.cache');
  const build = join(root, 'desktop', 'build');
  const archive = join(cache, archiveName);
  const sums = join(cache, `SHASUMS256-${NODE_VERSION}.txt`);
  await mkdir(cache, { recursive: true });
  await download(`${release}SHASUMS256.txt`, sums);
  const official = (await readFile(sums, 'utf8')).split(/\r?\n/).find((line) => line.endsWith(`  ${archiveName}`));
  if (official !== `${NODE_SHA256}  ${archiveName}`) throw new Error('Official Node checksum list disagrees with the pinned SHA256.');
  await download(`${release}${archiveName}`, archive);
  verifySha256(await readFile(archive));
  // Re-extract the verified archive; an earlier interrupted extraction is never trusted.
  const unpack = join(cache, `unpack-${NODE_VERSION}`);
  await rm(unpack, { recursive: true, force: true });
  const quoted = (value) => `'${value.replaceAll("'", "''")}'`;
  run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `$ErrorActionPreference='Stop'; Expand-Archive -LiteralPath ${quoted(archive)} -DestinationPath ${quoted(unpack)} -Force`], root);
  const distribution = join(unpack, `node-v${NODE_VERSION}-win-x64`);
  const node = join(distribution, 'node.exe');
  run(node, ['--version'], root);
  await mkdir(build, { recursive: true });
  for (const name of ['hub', 'node']) await rm(join(build, name), { recursive: true, force: true });
  const hub = join(build, 'hub');
  const nodeStage = join(build, 'node');
  await stageHub(root, hub);
  await mkdir(nodeStage, { recursive: true });
  for (const name of ['node.exe', 'LICENSE']) await cp(join(distribution, name), join(nodeStage, name));
  // npm gets empty config files and a local cache; no user npm configuration or system PATH changes.
  const userConfig = join(cache, 'npm-user.npmrc');
  const globalConfig = join(cache, 'npm-global.npmrc');
  await writeFile(userConfig, '');
  await writeFile(globalConfig, '');
  run(node, [join(distribution, 'node_modules/npm/bin/npm-cli.js'), 'ci', '--omit=dev', '--ignore-scripts',
    '--no-audit', '--no-fund', `--userconfig=${userConfig}`, `--globalconfig=${globalConfig}`, `--cache=${join(cache, 'npm')}`], hub);
  console.log(`Prepared Hub and Node ${NODE_VERSION} under ${build}`);
}

if (import.meta.main) prepareResources().catch((error) => {
  console.error(`Resource preparation failed: ${error.message}`);
  process.exitCode = 1;
});
