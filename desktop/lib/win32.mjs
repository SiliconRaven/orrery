// The desktop shell's only FFI file (docs/desktop.md "窗口操作的白名单"): koffi bindings for the allow-listed Win32
// calls, wrapped one-to-one as `ffi`. Reads may look at any top-level window. The four write wrappers at the end are
// used by lib/writer.mjs only, which checks the window's identity, the flags and the triggering action before each
// call. test/desktop.test.ts parses this file: every declared function must be on the allow-list, and no other
// desktop file may load koffi.
import koffi from 'koffi';

const user32 = koffi.load('user32.dll');
const kernel32 = koffi.load('kernel32.dll');
const dwmapi = koffi.load('dwmapi.dll');

// Window and process handles as plain numbers (pointer-sized integers), so they compare with === and survive IPC.
koffi.alias('HWND', 'intptr_t');
koffi.alias('HANDLE', 'intptr_t');
const RECT = koffi.struct('RECT', { left: 'int32_t', top: 'int32_t', right: 'int32_t', bottom: 'int32_t' });
koffi.struct('POINT', { x: 'int32_t', y: 'int32_t' });
const WINDOWPLACEMENT = koffi.struct('WINDOWPLACEMENT', {
  length: 'uint32_t', flags: 'uint32_t', showCmd: 'uint32_t', ptMinPosition: 'POINT', ptMaxPosition: 'POINT', rcNormalPosition: 'RECT',
});
const EnumWindowsProc = koffi.proto('int __stdcall EnumWindowsProc(HWND hwnd, intptr_t lParam)');

// Read-only.
const EnumWindows = user32.func('int __stdcall EnumWindows(EnumWindowsProc *callback, intptr_t lParam)');
const GetWindowThreadProcessId = user32.func('uint32_t __stdcall GetWindowThreadProcessId(HWND hWnd, _Out_ uint32_t *pid)');
const OpenProcess = kernel32.func('HANDLE __stdcall OpenProcess(uint32_t access, int inherit, uint32_t pid)');
const QueryFullProcessImageNameW = kernel32.func('int __stdcall QueryFullProcessImageNameW(HANDLE process, uint32_t flags, void *name, _Inout_ uint32_t *size)');
const CloseHandle = kernel32.func('int __stdcall CloseHandle(HANDLE handle)');
const GetClassNameW = user32.func('int __stdcall GetClassNameW(HWND hWnd, void *name, int max)');
const GetWindowTextW = user32.func('int __stdcall GetWindowTextW(HWND hWnd, void *text, int max)');
const IsWindow = user32.func('int __stdcall IsWindow(HWND hWnd)');
const IsWindowVisible = user32.func('int __stdcall IsWindowVisible(HWND hWnd)');
const IsIconic = user32.func('int __stdcall IsIconic(HWND hWnd)');
const IsZoomed = user32.func('int __stdcall IsZoomed(HWND hWnd)');
const GetWindowLongPtrW = user32.func('intptr_t __stdcall GetWindowLongPtrW(HWND hWnd, int index)');
const GetAncestor = user32.func('HWND __stdcall GetAncestor(HWND hWnd, uint32_t flags)');
const GetWindow = user32.func('HWND __stdcall GetWindow(HWND hWnd, uint32_t cmd)');
const GetWindowRect = user32.func('int __stdcall GetWindowRect(HWND hWnd, _Out_ RECT *rect)');
const GetWindowPlacement = user32.func('int __stdcall GetWindowPlacement(HWND hWnd, _Inout_ WINDOWPLACEMENT *placement)');
const DwmGetWindowAttribute = dwmapi.func('int32_t __stdcall DwmGetWindowAttribute(HWND hWnd, uint32_t attribute, void *value, uint32_t size)');
const GetDpiForWindow = user32.func('uint32_t __stdcall GetDpiForWindow(HWND hWnd)');
const GetLastError = kernel32.func('uint32_t __stdcall GetLastError()');

// Writes: only through lib/writer.mjs.
const SetWindowPos = user32.func('int __stdcall SetWindowPos(HWND hWnd, HWND insertAfter, int x, int y, int cx, int cy, uint32_t flags)');
const ShowWindow = user32.func('int __stdcall ShowWindow(HWND hWnd, int command)');
const SetWindowPlacement = user32.func('int __stdcall SetWindowPlacement(HWND hWnd, const WINDOWPLACEMENT *placement)');
const SetForegroundWindow = user32.func('int __stdcall SetForegroundWindow(HWND hWnd)');

const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const DWMWA_EXTENDED_FRAME_BOUNDS = 9;
const DWMWA_CLOAKED = 14;
const PLACEMENT_SIZE = koffi.sizeof(WINDOWPLACEMENT);

/** A UTF-16 string a call wrote into `buf`, `n` characters long. */
const utf16 = (buf, n) => buf.toString('utf16le', 0, Math.max(0, n) * 2);

export const ffi = {
  enumWindows() {
    const out = [];
    EnumWindows((hwnd) => { out.push(hwnd); return 1; }, 0);
    return out;
  },
  getWindowThreadProcessId(hwnd) {
    const pid = [0];
    return GetWindowThreadProcessId(hwnd, pid) ? pid[0] : 0;
  },
  /** The full image path of a process, or null (gone, or not allowed even with limited query rights). */
  queryImagePath(pid) {
    const process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
    if (!process) return null;
    try {
      const buf = Buffer.alloc(2 * 1024);
      const size = [1024];
      return QueryFullProcessImageNameW(process, 0, buf, size) ? utf16(buf, size[0]) : null;
    } finally {
      CloseHandle(process);
    }
  },
  getClassName(hwnd) {
    const buf = Buffer.alloc(2 * 256);
    const n = GetClassNameW(hwnd, buf, 256);
    return n > 0 ? utf16(buf, n) : null;
  },
  /** For another process's window this reads the stored caption; it sends no message, so a hung app cannot block it. */
  getWindowText(hwnd) {
    const buf = Buffer.alloc(2 * 512);
    return utf16(buf, GetWindowTextW(hwnd, buf, 512));
  },
  isWindow: (hwnd) => IsWindow(hwnd) !== 0,
  isWindowVisible: (hwnd) => IsWindowVisible(hwnd) !== 0,
  isIconic: (hwnd) => IsIconic(hwnd) !== 0,
  isZoomed: (hwnd) => IsZoomed(hwnd) !== 0,
  getWindowLongPtr: (hwnd, index) => Number(GetWindowLongPtrW(hwnd, index)),
  getAncestor: (hwnd, flags) => GetAncestor(hwnd, flags),
  getWindow: (hwnd, cmd) => GetWindow(hwnd, cmd),
  getWindowRect(hwnd) {
    const r = {};
    return GetWindowRect(hwnd, r) ? r : null;
  },
  /** The visible frame (DWM extended frame bounds), without the invisible resize borders. */
  getExtendedFrameBounds(hwnd) {
    const buf = Buffer.alloc(16);
    if (DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, buf, 16) !== 0) return null;
    return { left: buf.readInt32LE(0), top: buf.readInt32LE(4), right: buf.readInt32LE(8), bottom: buf.readInt32LE(12) };
  },
  /** true when DWM hides the window (another virtual desktop, a suspended app), null when it could not be read. */
  isCloaked(hwnd) {
    const buf = Buffer.alloc(4);
    return DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, buf, 4) === 0 ? buf.readUInt32LE(0) !== 0 : null;
  },
  getWindowPlacement(hwnd) {
    const wp = { length: PLACEMENT_SIZE };
    if (!GetWindowPlacement(hwnd, wp)) return null;
    const { flags, showCmd, ptMinPosition, ptMaxPosition, rcNormalPosition } = wp;
    return { flags, showCmd, ptMinPosition: { ...ptMinPosition }, ptMaxPosition: { ...ptMaxPosition }, rcNormalPosition: { ...rcNormalPosition } };
  },
  getDpiForWindow: (hwnd) => GetDpiForWindow(hwnd),
  getLastError: () => GetLastError(),

  setWindowPos: (hwnd, insertAfter, x, y, cx, cy, flags) => SetWindowPos(hwnd, insertAfter, x, y, cx, cy, flags) !== 0,
  showWindow: (hwnd, command) => ShowWindow(hwnd, command) !== 0,
  setWindowPlacement: (hwnd, placement) => SetWindowPlacement(hwnd, { length: PLACEMENT_SIZE, ...placement }) !== 0,
  setForegroundWindow: (hwnd) => SetForegroundWindow(hwnd) !== 0,
};
