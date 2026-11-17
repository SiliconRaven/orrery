// An app's icon from its program file's own resources (docs/desktop.md "图标"), for the tab bar. Pure: the file comes in
// as `read(offset, length)` (shell.mjs reads it, never runs or loads it), so the root `npm test` checks every bound.
// Electron's app.getFileIcon returns the system's generic program icon for most supported apps, Windows itself does
// not, so the shell reads the icon here first.
//
// Windows program files (PE): the DOS header points at the PE header, whose data directory 2 is the resource tree
// (type → name → language → data). The app icon is the first RT_GROUP_ICON (14), a list of frames that refer to
// RT_ICON (3) resources by id. One frame is returned: a PNG as it is stored, or a bitmap frame wrapped in a one-frame
// .ico, both of which an <img> shows.

const RT_ICON = 3;
const RT_GROUP_ICON = 14;
/** Largest resource section read (the tree and the frames are inside it). */
export const MAX_RESOURCES = 16 * 1024 * 1024;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * @param {(offset: number, length: number) => Buffer | null} read the file's bytes at an offset (fewer at its end)
 * @returns {{ type: 'image/png' | 'image/x-icon', bytes: Buffer } | null} null when there is no usable icon; never throws
 */
export function iconFromExe(read) {
  try {
    return parse(read);
  } catch {
    return null;   // a malformed file: every read below is bounds-checked, this only catches what slips through
  }
}

function parse(read) {
  const at = (offset, length) => {
    if (!Number.isInteger(offset) || offset < 0 || length <= 0 || length > MAX_RESOURCES) return null;
    const b = read(offset, length);
    return b && b.length === length ? b : null;
  };
  const dos = at(0, 64);
  if (!dos || dos.toString('latin1', 0, 2) !== 'MZ') return null;
  const pe = dos.readUInt32LE(0x3c);
  const head = at(pe, 24);
  if (!head || head.toString('latin1', 0, 4) !== 'PE\0\0') return null;
  const sections = head.readUInt16LE(6);
  const optSize = head.readUInt16LE(20);
  const opt = at(pe + 24, optSize);
  if (!opt || optSize < 2) return null;
  const magic = opt.readUInt16LE(0);
  const dirs = magic === 0x20b ? 112 : magic === 0x10b ? 96 : -1;   // PE32+ or PE32
  if (dirs < 0 || optSize < dirs + 3 * 8 || opt.readUInt32LE(dirs - 4) < 3) return null;
  const rsrcRva = opt.readUInt32LE(dirs + 16);
  const rsrcSize = opt.readUInt32LE(dirs + 20);
  if (!rsrcRva || !rsrcSize) return null;
  const table = at(pe + 24 + optSize, sections * 40);
  if (!table) return null;
  // The section holding the resource tree, and where the tree starts in the file.
  let start = -1;
  for (let i = 0; i < sections; i++) {
    const va = table.readUInt32LE(i * 40 + 12);
    const raw = table.readUInt32LE(i * 40 + 16);
    const ptr = table.readUInt32LE(i * 40 + 20);
    if (rsrcRva >= va && rsrcRva < va + raw) { start = ptr + (rsrcRva - va); break; }
  }
  const res = at(start, rsrcSize);
  if (!res) return null;

  const u16 = (o) => (o >= 0 && o + 2 <= res.length ? res.readUInt16LE(o) : null);
  const u32 = (o) => (o >= 0 && o + 4 <= res.length ? res.readUInt32LE(o) : null);
  /** A directory's entries: { id (null for a named one), offset, dir }. */
  const entries = (o) => {
    const named = u16(o + 12);
    const ids = u16(o + 14);
    if (named === null || ids === null) return [];
    const out = [];
    for (let i = 0; i < named + ids; i++) {
      const name = u32(o + 16 + i * 8);
      const to = u32(o + 16 + i * 8 + 4);
      if (name === null || to === null) break;
      out.push({ id: name & 0x80000000 ? null : name, offset: to & 0x7fffffff, dir: (to & 0x80000000) !== 0 });
    }
    return out;
  };
  /** The bytes of a resource: the first language of the entry `e` (a name or id directory). */
  const data = (e) => {
    const lang = e?.dir ? entries(e.offset)[0] : null;
    if (!lang || lang.dir) return null;
    const rva = u32(lang.offset);
    const size = u32(lang.offset + 4);
    if (rva === null || !size) return null;
    const o = rva - rsrcRva;
    return o >= 0 && o + size <= res.length ? res.subarray(o, o + size) : null;
  };
  const types = entries(0);
  const groups = types.find((t) => t.id === RT_GROUP_ICON && t.dir);
  const icons = types.find((t) => t.id === RT_ICON && t.dir);
  if (!groups || !icons) return null;
  const group = data(entries(groups.offset)[0]);
  const frames = entries(icons.offset);
  if (!group || group.length < 6 || group.readUInt16LE(2) !== 1) return null;
  const count = group.readUInt16LE(4);
  const list = [];
  for (let i = 0; i < count && 6 + (i + 1) * 14 <= group.length; i++) {
    const e = 6 + i * 14;
    const id = group.readUInt16LE(e + 12);
    const bytes = data(frames.find((f) => f.id === id));
    if (bytes) list.push({ size: group[e] || 256, bits: group.readUInt16LE(e + 6), entry: group.subarray(e, e + 12), bytes });
  }
  const frame = pick(list);
  if (!frame) return null;
  if (frame.bytes.subarray(0, 8).equals(PNG)) return { type: 'image/png', bytes: Buffer.from(frame.bytes) };
  // A bitmap frame: a one-frame .ico (6-byte header, one 16-byte entry, the frame).
  const ico = Buffer.alloc(22 + frame.bytes.length);
  ico.writeUInt16LE(1, 2);
  ico.writeUInt16LE(1, 4);
  frame.entry.copy(ico, 6, 0, 8);   // width, height, colours, reserved, planes, bit count
  ico.writeUInt32LE(frame.bytes.length, 14);
  ico.writeUInt32LE(22, 18);
  frame.bytes.copy(ico, 22);
  return { type: 'image/x-icon', bytes: ico };
}

/**
 * The frame to show at about 20 px (40 px on a 200 % screen): the smallest one of at least 48 px, else the largest;
 * of equal sizes the one with the most colours.
 * Keeps what is sent to the tab bar small (a 256 px bitmap frame alone is 256 KB).
 */
export function pick(frames) {
  const big = frames.filter((f) => f.size >= 48).sort((a, b) => a.size - b.size || (b.bits ?? 0) - (a.bits ?? 0));
  return big[0] ?? [...frames].sort((a, b) => b.size - a.size || (b.bits ?? 0) - (a.bits ?? 0))[0] ?? null;
}
