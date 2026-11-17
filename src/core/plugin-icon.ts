// A third-party plugin's icon (docs/external-plugins.md「图标和详细说明」): one image file inside the plugin's own directory.
// Checked again on every read, never trusted from start-up: the file can change, move or turn into a link meanwhile.
// A bad icon only costs the plugin its picture; the reason is a fixed Hub sentence, never a path or the file's text.
// Everything here is linear in the bytes it looks at: a manifest or file written to stall the Hub must not (no regex
// with nested or overlapping quantifiers; the SVG check is a token scan).
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { sniffImage } from './files.ts';

export const MAX_ICON_BYTES = 256 * 1024;
/** How much of the file the type check reads; an SVG's prolog must end inside it. */
export const SNIFF_BYTES = 4096;
const MAX_ICON_PATH = 260;
const TYPES: Record<string, string> = { '.png': 'image/png', '.webp': 'image/webp', '.ico': 'image/x-icon', '.svg': 'image/svg+xml' };
// Never block in open() on a FIFO or device swapped in after the check (POSIX; Windows has no such flag or files).
const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0);

const isSpace = (c: string) => c === ' ' || c === '\t' || c === '\r' || c === '\n';

/**
 * Whether `text` is an SVG document: after an optional BOM, any whitespace, XML declaration or processing instructions
 * (each ending at the first `?>`), comments (each ending at the first `-->`) and at most one `<!DOCTYPE svg …>` without
 * an internal subset, the root element is `<svg` followed by whitespace, `>` or `/`. One pass, each token consumed once.
 */
export function isSvgDocument(text: string): boolean {
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  let doctype = false;
  for (;;) {
    while (i < text.length && isSpace(text[i])) i++;
    if (text.startsWith('<!--', i)) {
      const end = text.indexOf('-->', i + 4);
      if (end < 0) return false;
      i = end + 3;
    } else if (text.startsWith('<?', i)) {
      const end = text.indexOf('?>', i + 2);
      if (end < 0) return false;
      i = end + 2;
    } else if (text.startsWith('<!DOCTYPE', i) && !doctype) {
      let j = i + 9;
      if (!isSpace(text[j] ?? '')) return false;
      while (j < text.length && isSpace(text[j])) j++;
      if (!text.startsWith('svg', j)) return false;
      const end = text.indexOf('>', j);
      if (end < 0 || text.slice(j, end).includes('[')) return false;   // an internal subset (entities) is refused
      doctype = true;
      i = end + 1;
    } else {
      const next = text[i + 4] ?? '';
      return text.startsWith('<svg', i) && (isSpace(next) || next === '>' || next === '/');
    }
  }
}

function sniff(ext: string, head: Buffer): boolean {
  if (ext === '.ico') return head.length >= 4 && head[0] === 0 && head[1] === 0 && head[2] === 1 && head[3] === 0;
  if (ext === '.svg') return isSvgDocument(head.toString('utf8'));
  return sniffImage(head) === TYPES[ext];
}

export type PluginIcon = { type: string; data: Buffer } | { error: string };

/**
 * Reads and checks `icon` (the manifest's value) relative to `directory` (the plugin's real directory). Refuses absolute
 * paths, drive letters, UNC and URLs, `..`, other types, anything but a regular file, more than MAX_ICON_BYTES, content
 * that does not match the extension, and anything that resolves outside the directory once links and junctions are
 * followed. `full: false` (the plugin list) reads only the first SNIFF_BYTES and returns them as `data`; the icon route
 * reads the whole file.
 */
export function readPluginIcon(directory: string, icon: unknown, full = true): PluginIcon {
  if (typeof icon !== 'string') return { error: '图标字段必须是字符串。' };
  if (!icon || icon.length > MAX_ICON_PATH || icon.includes('\0') || isAbsolute(icon) || /^[\\/]/.test(icon)
    || /^[a-z][a-z0-9+.-]*:/i.test(icon) || icon.split(/[\\/]/).includes('..')) {
    return { error: '图标必须是插件目录内的相对路径。' };
  }
  const ext = extname(icon).toLowerCase();
  if (!TYPES[ext]) return { error: '图标只支持 png、webp、ico 或 svg 文件。' };
  let file: string;
  try { file = realpathSync(resolve(directory, icon)); } catch { return { error: '找不到图标文件。' }; }
  const rel = relative(directory, file);
  if (!rel || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) return { error: '图标在插件目录之外。' };
  // Before opening: a FIFO, socket or device is refused here, so open() never waits on one.
  try {
    const stat = statSync(file);
    if (!stat.isFile()) return { error: '找不到图标文件。' };
    if (stat.size > MAX_ICON_BYTES) return { error: `图标超过 ${MAX_ICON_BYTES / 1024} KiB。` };
  } catch { return { error: '找不到图标文件。' }; }
  let fd: number;
  try { fd = openSync(file, OPEN_FLAGS); } catch { return { error: '无法读取图标文件。' }; }
  try {
    const stat = fstatSync(fd);   // again on the open handle: the file may have been swapped since the check above
    if (!stat.isFile()) return { error: '找不到图标文件。' };
    if (stat.size > MAX_ICON_BYTES) return { error: `图标超过 ${MAX_ICON_BYTES / 1024} KiB。` };
    const data = Buffer.alloc(full ? stat.size : Math.min(stat.size, SNIFF_BYTES));
    let read = 0;
    while (read < data.length) {
      const n = readSync(fd, data, read, data.length - read, read);
      if (n === 0) break;
      read += n;
    }
    if (!sniff(ext, data.subarray(0, Math.min(read, SNIFF_BYTES)))) return { error: '图标内容与扩展名不符。' };
    return { type: TYPES[ext], data: data.subarray(0, read) };
  } catch {
    return { error: '无法读取图标文件。' };
  } finally {
    closeSync(fd);
  }
}
