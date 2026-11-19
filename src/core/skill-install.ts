// Installs a skill into the user's shared skills folder (docs/files.md「安装 skill」), the only place orrery writes for
// skills: never into an app's own folder. A source is a local folder (an app's skill, or a folder the user names) or a
// ZIP the user uploaded (zip.ts). Every step refuses links instead of following them: in the source, in the shared
// folder and its parents, at the destination and in an old copy being replaced. Bytes go to a temporary folder inside
// the shared folder first and are renamed into place, so a half-copied skill never shows under its name.
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readdir, rename, rmdir, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { head, isSkillName, skillInfoOf, type SkillInfo } from './skills.ts';
import { readZip, ZipRefused, type ZipEntry } from './zip.ts';

export const INSTALL_LIMITS = { files: 1000, bytes: 50 * 1024 * 1024, depth: 16, zipBytes: 20 * 1024 * 1024 };
const TEMP_PREFIX = '.orrery-install-';
const OLD_PREFIX = '.orrery-old-';
const MAX_OLD_ENTRIES = 50_000;
const outside = (path: string) => path === '..' || path.startsWith('..' + sep) || isAbsolute(path);

/** A refusal with a code the page explains (docs/files.md lists them). Messages never hold a path or file content. */
export class InstallRefused extends Error {
  readonly code: string;
  /** For `exists`: the skill's name, so the page can ask whether to replace it. */
  readonly skill?: string;
  constructor(code: string, message: string, skill?: string) {
    super(message);
    this.code = code;
    if (skill) this.skill = skill;
  }
}

export interface Installed extends SkillInfo {
  replaced: boolean;
  /** Only after a replace: false when the old copy could not be removed (it stays in a hidden .orrery-old-* folder). */
  oldRemoved?: boolean;
}

type Planned = { segments: string[]; dir: true } | { segments: string[]; dir: false; write: (to: string) => Promise<void> };

/** Codes Windows gives a rename while a scanner or indexer still has a just-written file open. */
const BUSY = new Set(['EPERM', 'EACCES', 'EBUSY']);
async function renameRetry(from: string, to: string): Promise<void> {
  for (const wait of [10, 20, 40, 80, 160, 300, 500, 0]) {
    try { return await rename(from, to); } catch (e) {
      if (!BUSY.has((e as NodeJS.ErrnoException).code ?? '') || wait === 0) throw e;
      await sleep(wait);
    }
  }
}

const lstatOrNull = (p: string) => lstat(p).catch((e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return null; throw e; });

/**
 * The shared folder, checked for writing: it and every folder above it are real folders, none a link or junction (so it
 * resolves to itself). Created when missing.
 */
async function checkedShared(sharedDir: string | undefined): Promise<string> {
  if (!sharedDir) throw new InstallRefused('not_configured', 'no shared skills folder is configured');
  const dir = resolve(sharedDir);
  try {
    // Links first, so a missing folder is never created through one.
    for (let p = dir; ; p = dirname(p)) {
      if ((await lstatOrNull(p))?.isSymbolicLink()) throw new InstallRefused('shared_dir_link', 'the shared skills folder, or a folder above it, is a link or junction');
      if (dirname(p) === p) break;
    }
    if (!(await lstatOrNull(dir))) await mkdir(dir, { recursive: true });
    const st = await lstat(dir);
    if (st.isSymbolicLink()) throw new InstallRefused('shared_dir_link', 'the shared skills folder is a link or junction');
    if (!st.isDirectory()) throw new InstallRefused('shared_dir_invalid', 'the shared skills folder is not a folder');
  } catch (e) {
    if (e instanceof InstallRefused) throw e;
    throw new InstallRefused('shared_dir_invalid', `the shared skills folder cannot be used (${(e as NodeJS.ErrnoException).code ?? 'error'})`);
  }
  return dir;
}

/**
 * Removes a folder the installer made or moved aside, without following anything: a link inside stops the removal and
 * the rest stays (false). Only `.orrery-*` folders directly in the shared folder.
 */
async function removeOwnFolder(shared: string, dir: string): Promise<boolean> {
  if (dirname(dir) !== shared || !(basename(dir).startsWith(TEMP_PREFIX) || basename(dir).startsWith(OLD_PREFIX))) return false;
  const remove = async (folder: string): Promise<boolean> => {
    const st = await lstatOrNull(folder);
    if (!st) return true;
    if (st.isSymbolicLink() || !st.isDirectory()) return false;
    for (const name of await readdir(folder)) {
      const p = join(folder, name);
      const e = await lstat(p);
      if (e.isSymbolicLink()) return false;
      if (e.isDirectory()) { if (!(await remove(p))) return false; } else if (e.isFile()) await unlink(p);
      else return false;
    }
    await rmdir(folder);
    return true;
  };
  try { return await remove(dir); } catch { return false; }
}

/** Counts a folder tree without following links; refuses one that holds a link (or is too large to check). */
async function checkNoLinks(dir: string): Promise<void> {
  let count = 0;
  const walk = async (folder: string): Promise<void> => {
    for (const name of await readdir(folder)) {
      if (++count > MAX_OLD_ENTRIES) throw new InstallRefused('existing_too_large', 'the installed copy is too large to check before replacing it');
      const st = await lstat(join(folder, name));
      if (st.isSymbolicLink()) throw new InstallRefused('existing_has_link', 'the installed copy contains a link or junction; replace it by hand');
      if (st.isDirectory()) await walk(join(folder, name));
    }
  };
  await walk(dir);
}

/**
 * A local folder as a source: every entry lstat'ed (never followed), regular files and folders only, within the caps,
 * with SKILL.md at its root. Each file is copied through a handle that must be the file that was checked.
 */
async function planFolder(root: string): Promise<Planned[]> {
  const top = await lstatOrNull(root);
  if (!top) throw new InstallRefused('path_not_found', 'the folder does not exist');
  if (top.isSymbolicLink()) throw new InstallRefused('source_has_link', 'the folder is a link or junction');
  if (!top.isDirectory()) throw new InstallRefused('path_not_directory', 'the path is not a folder');
  const plan: Planned[] = [];
  let files = 0, bytes = 0, skillMd = false;
  const walk = async (folder: string, segments: string[]): Promise<void> => {
    let names: string[];
    try { names = await readdir(folder); } catch { throw new InstallRefused('source_unreadable', 'a folder in the source cannot be read'); }
    for (const name of names.sort()) {
      const path = join(folder, name);
      const st = await lstat(path, { bigint: true });
      const here = [...segments, name];
      if (st.isSymbolicLink()) throw new InstallRefused('source_has_link', 'the source contains a link or junction');
      if (st.isDirectory()) {
        if (here.length >= INSTALL_LIMITS.depth) throw new InstallRefused('too_deep', `the source nests folders more than ${INSTALL_LIMITS.depth} deep`);
        if (++files > INSTALL_LIMITS.files) throw new InstallRefused('too_many_files', `the source has more than ${INSTALL_LIMITS.files} files and folders`);
        plan.push({ segments: here, dir: true });
        await walk(path, here);
      } else if (st.isFile()) {
        if (++files > INSTALL_LIMITS.files) throw new InstallRefused('too_many_files', `the source has more than ${INSTALL_LIMITS.files} files and folders`);
        bytes += Number(st.size);
        if (bytes > INSTALL_LIMITS.bytes) throw new InstallRefused('too_large', `the source is larger than ${INSTALL_LIMITS.bytes / 1024 / 1024} MB`);
        if (!segments.length && name === 'SKILL.md') skillMd = true;
        plan.push({ segments: here, dir: false, write: async (to) => {
          const handle = await open(path, 'r');
          try {
            const now = await handle.stat({ bigint: true });
            if (!now.isFile() || now.dev !== st.dev || now.ino !== st.ino) throw new InstallRefused('source_changed', 'a file in the source changed while it was being copied');
            const data = await handle.readFile();
            if (data.length > INSTALL_LIMITS.bytes) throw new InstallRefused('too_large', `the source is larger than ${INSTALL_LIMITS.bytes / 1024 / 1024} MB`);
            await writeFile(to, data, { flag: 'wx' });
          } finally { await handle.close(); }
        } });
      } else throw new InstallRefused('source_bad_entry', 'the source contains something that is neither a file nor a folder');
    }
  };
  await walk(root, []);
  if (!skillMd) throw new InstallRefused('missing_skill_md', 'there is no SKILL.md at the top of the folder');
  return plan;
}

/** A ZIP's entries as a source: SKILL.md at the root, or inside the one top-level folder every entry is in. */
function planZip(entries: ZipEntry[]): { plan: Planned[]; top: string | null } {
  const kept = entries.filter((e) => e.path.split('/')[0] !== '__MACOSX');   // the macOS archiver's resource-fork folder
  const tops = new Set(kept.map((e) => e.path.split('/')[0]));
  const has = (path: string) => kept.some((e) => !e.dir && e.path === path);
  let top: string | null = null;
  if (!has('SKILL.md')) {
    const [only] = tops;
    if (tops.size !== 1 || !has(`${only}/SKILL.md`)) throw new InstallRefused('missing_skill_md', 'there is no SKILL.md at the top of the archive or of its one folder');
    top = only;
  }
  const plan: Planned[] = [];
  for (const e of kept) {
    const segments = e.path.split('/').slice(top ? 1 : 0);
    if (!segments.length) continue;
    plan.push(e.dir ? { segments, dir: true } : { segments, dir: false, write: (to) => writeFile(to, e.data, { flag: 'wx' }) });
  }
  return { plan, top };
}

/**
 * Writes `plan` into a new temporary folder in the shared folder, reads the skill's name from its SKILL.md (frontmatter,
 * else `fallback`), then puts it at <shared>/<name>: renamed into place, or, with `overwrite`, swapped with the
 * installed copy, which is removed only after the new one is in place. Any failure removes the temporary folder.
 */
async function place(shared: string, plan: Planned[], fallback: string, overwrite: boolean): Promise<Installed> {
  const tmp = join(shared, `${TEMP_PREFIX}${randomUUID()}`);
  try {
    await mkdir(tmp);
    for (const item of plan) {
      const to = join(tmp, ...item.segments);
      if (outside(relative(tmp, to))) throw new InstallRefused('source_bad_entry', 'an entry would leave the skill folder');
      if (item.dir) await mkdir(to, { recursive: true });
      else {
        await mkdir(dirname(to), { recursive: true });
        await item.write(to);
      }
    }
    const info = skillInfoOf(fallback, head(join(tmp, 'SKILL.md')) ?? '');
    if (!info) throw new InstallRefused('invalid_name', 'the skill has no valid name (letters, digits and _ . : - only, at most 64)');
    const dest = join(shared, info.name);
    const existing = await lstatOrNull(dest);
    if (existing?.isSymbolicLink()) throw new InstallRefused('target_is_link', 'a link or junction with this name is already in the shared folder');
    if (existing && !overwrite) throw new InstallRefused('exists', 'a skill with this name is already in the shared folder', info.name);
    if (existing && !existing.isDirectory()) throw new InstallRefused('target_not_folder', 'a file with this name is already in the shared folder');
    if (!existing) {
      try { await renameRetry(tmp, dest); } catch (e) {
        throw (await lstatOrNull(dest)) ? new InstallRefused('exists', 'a skill with this name appeared in the shared folder meanwhile', info.name)
          : new InstallRefused('busy', `the new skill could not be moved into place (${(e as NodeJS.ErrnoException).code ?? 'error'})`);
      }
      return { ...info, replaced: false };
    }
    await checkNoLinks(dest);
    const old = join(shared, `${OLD_PREFIX}${randomUUID()}`);
    try { await renameRetry(dest, old); } catch (e) {
      throw new InstallRefused('busy', `the installed copy could not be moved aside; an app may be using it (${(e as NodeJS.ErrnoException).code ?? 'error'})`);
    }
    try { await renameRetry(tmp, dest); } catch (e) {
      await renameRetry(old, dest).catch(() => {});
      throw new InstallRefused('busy', `the new skill could not be moved into place (${(e as NodeJS.ErrnoException).code ?? 'error'})`);
    }
    return { ...info, replaced: true, oldRemoved: await removeOwnFolder(shared, old) };
  } catch (e) {
    await removeOwnFolder(shared, tmp);
    if (e instanceof InstallRefused || e instanceof ZipRefused) throw e;
    // A file system error: its message would carry a path, so only its code goes back.
    throw new InstallRefused('io_error', `the copy failed (${(e as NodeJS.ErrnoException).code ?? 'file system error'})`);
  }
}

/** Installs the skill folder `folder` (an app's skill, found by the caller, or a folder the user named). */
export async function installFromFolder(sharedDir: string | undefined, folder: string, overwrite: boolean): Promise<Installed> {
  const shared = await checkedShared(sharedDir);
  const root = resolve(folder);
  const inside = relative(root, shared);
  if (!inside || !outside(inside)) throw new InstallRefused('source_contains_shared', 'the folder contains the shared skills folder');
  let plan: Planned[];
  try { plan = await planFolder(root); } catch (e) {
    if (e instanceof InstallRefused) throw e;
    throw new InstallRefused('source_unreadable', `the folder cannot be read (${(e as NodeJS.ErrnoException).code ?? 'error'})`);
  }
  return place(shared, plan, basename(root), overwrite);
}

/**
 * A folder path the user typed: absolute, on a local drive (no UNC or device path, checked as a string before any file
 * system call, so the Hub never reaches out to a network share), at most 1024 characters.
 */
export function localFolderPath(path: unknown): string {
  if (typeof path !== 'string' || !path.trim() || path.length > 1024 || /[\u0000-\u001f]/.test(path)) throw new InstallRefused('bad_request', 'fromPath must be a folder path');
  const p = path.trim();
  if (/^[\\/]{2}/.test(p)) throw new InstallRefused('path_not_local', 'network and device paths are not accepted');
  if (!isAbsolute(p) || (process.platform === 'win32' && !/^[A-Za-z]:[\\/]/.test(p))) throw new InstallRefused('path_not_absolute', 'the path must be absolute (start with a drive letter)');
  return resolve(p);
}

/** Installs from a ZIP the user uploaded; `fileName` (the upload's name) names the skill when nothing else does. */
export async function installFromZip(sharedDir: string | undefined, zip: Buffer, fileName: string, overwrite: boolean): Promise<Installed> {
  const shared = await checkedShared(sharedDir);
  const { plan, top } = planZip(readZip(zip));
  const fromFile = fileName.replace(/\.zip$/i, '');
  return place(shared, plan, top ?? (isSkillName(fromFile) ? fromFile : ''), overwrite);
}
