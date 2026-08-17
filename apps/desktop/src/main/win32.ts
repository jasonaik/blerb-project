/**
 * The Win32 window walk, via koffi (N-API, so no electron-rebuild).
 *
 * Everything here follows the constraints table in CLAUDE.md §2:
 *  - Z-order walk with GetWindow(GW_HWNDNEXT), not EnumWindows — we need
 *    z-order so the pet stands on the *visible* window.
 *  - DWMWA_EXTENDED_FRAME_BOUNDS, not GetWindowRect — GetWindowRect includes
 *    a ~7px invisible resize border and the pet would float above title bars.
 *  - Returns PHYSICAL pixels. The caller (scanner.ts) converts to DIP with
 *    Electron's screen.screenToDipPoint. Never mix the two spaces.
 *
 * Degrades gracefully: if koffi fails to load, `available` is false and the
 * pet lives on a floor-only world. A pet with no window platforms is a much
 * better failure mode than an app that won't start.
 */

export interface NativeWindowRect {
  id: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

const GW_HWNDNEXT = 2;
const GWL_EXSTYLE = -20;
const WS_EX_TOOLWINDOW = 0x0000_0080;
const DWMWA_CLOAKED = 14;
const DWMWA_EXTENDED_FRAME_BOUNDS = 9;

interface Api {
  GetTopWindow: (h: unknown) => unknown;
  GetWindow: (h: unknown, cmd: number) => unknown;
  GetForegroundWindow: () => unknown;
  IsWindowVisible: (h: unknown) => boolean;
  IsIconic: (h: unknown) => boolean;
  GetWindowTextLengthW: (h: unknown) => number;
  GetWindowLongW: (h: unknown, i: number) => number;
  DwmGetWindowAttribute: (h: unknown, attr: number, out: Uint8Array, size: number) => number;
  GetWindowThreadProcessId: (h: unknown, pid: Uint32Array) => number;
  OpenProcess: (access: number, inherit: boolean, pid: number) => unknown;
  QueryFullProcessImageNameW: (h: unknown, flags: number, buf: Uint16Array, size: Uint32Array) => boolean;
  CloseHandle: (h: unknown) => boolean;
  GetLastInputInfo: (info: Uint8Array) => boolean;
  GetTickCount: () => number;
  FindWindowExW: (parent: unknown, after: unknown, cls: string | null, title: string | null) => unknown;
  address: (h: unknown) => bigint;
}

let api: Api | null = null;

try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const koffi = require('koffi') as typeof import('koffi');
  const user32 = koffi.load('user32.dll');
  const dwmapi = koffi.load('dwmapi.dll');
  const kernel32 = koffi.load('kernel32.dll');

  api = {
    GetTopWindow: user32.func('GetTopWindow', 'void *', ['void *']),
    GetWindow: user32.func('GetWindow', 'void *', ['void *', 'uint32_t']),
    GetForegroundWindow: user32.func('GetForegroundWindow', 'void *', []),
    IsWindowVisible: user32.func('IsWindowVisible', 'bool', ['void *']),
    IsIconic: user32.func('IsIconic', 'bool', ['void *']),
    GetWindowTextLengthW: user32.func('GetWindowTextLengthW', 'int32_t', ['void *']),
    GetWindowLongW: user32.func('GetWindowLongW', 'int32_t', ['void *', 'int32_t']),
    DwmGetWindowAttribute: dwmapi.func('DwmGetWindowAttribute', 'int32_t', [
      'void *',
      'uint32_t',
      '_Out_ uint8_t *',
      'uint32_t',
    ]),
    GetWindowThreadProcessId: user32.func('GetWindowThreadProcessId', 'uint32_t', [
      'void *',
      '_Out_ uint32_t *',
    ]),
    OpenProcess: kernel32.func('OpenProcess', 'void *', ['uint32_t', 'bool', 'uint32_t']),
    QueryFullProcessImageNameW: kernel32.func('QueryFullProcessImageNameW', 'bool', [
      'void *',
      'uint32_t',
      '_Out_ uint16_t *',
      '_Inout_ uint32_t *',
    ]),
    CloseHandle: kernel32.func('CloseHandle', 'bool', ['void *']),
    GetLastInputInfo: user32.func('GetLastInputInfo', 'bool', ['_Inout_ uint8_t *']),
    GetTickCount: kernel32.func('GetTickCount', 'uint32_t', []),
    FindWindowExW: user32.func('FindWindowExW', 'void *', ['void *', 'void *', 'str16', 'str16']),
    address: (h) => koffi.address(h as Parameters<typeof koffi.address>[0]),
  } as Api;
} catch (err) {
  console.warn('[win32] koffi unavailable — window platforms disabled:', err);
  api = null;
}

export const available = api !== null;

function extendedBounds(hwnd: unknown): NativeWindowRect | null {
  if (!api) return null;
  const buf = new Uint8Array(16);
  const hr = api.DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, buf, 16);
  if (hr !== 0) return null;
  const dv = new DataView(buf.buffer);
  return {
    id: String(api.address(hwnd)),
    left: dv.getInt32(0, true),
    top: dv.getInt32(4, true),
    right: dv.getInt32(8, true),
    bottom: dv.getInt32(12, true),
  };
}

function isCloaked(hwnd: unknown): boolean {
  if (!api) return false;
  const buf = new Uint8Array(4);
  const hr = api.DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, buf, 4);
  // Suspended/UWP windows report cloaked; they're invisible but enumerate as
  // visible, and would create ghost platforms hanging in the air.
  return hr === 0 && new DataView(buf.buffer).getUint32(0, true) !== 0;
}

/**
 * Top-level windows in z-order (topmost first) that could plausibly carry a
 * pet: visible, titled, not minimized, not a tool window (which also
 * conveniently excludes our own overlay), not cloaked.
 *
 * Maximized windows are INCLUDED. Shimeji drops them because a maximized
 * window's top edge is the screen edge, with no room above it to stand — true,
 * and the scanner still refuses to put a ledge there. But there is always room
 * to hang *underneath* an edge, so a maximized window's title bar is a perfectly
 * good ceiling. Excluding them here would make the pet unable to use the window
 * you spend all day in.
 */
export function scanWindows(take = 10, walkLimit = 120): NativeWindowRect[] {
  if (!api) return [];
  const out: NativeWindowRect[] = [];

  let hwnd = api.GetTopWindow(null);
  let walked = 0;

  while (hwnd && walked < walkLimit && out.length < take) {
    walked++;
    if (
      api.IsWindowVisible(hwnd) &&
      !api.IsIconic(hwnd) &&
      api.GetWindowTextLengthW(hwnd) > 0
    ) {
      const ex = api.GetWindowLongW(hwnd, GWL_EXSTYLE);
      if ((ex & WS_EX_TOOLWINDOW) === 0 && !isCloaked(hwnd)) {
        const r = extendedBounds(hwnd);
        if (r && r.right - r.left >= 160 && r.bottom - r.top >= 80) out.push(r);
      }
    }
    hwnd = api.GetWindow(hwnd, GW_HWNDNEXT);
  }
  return out;
}

/** Extended frame bounds of the foreground window, physical px. */
export function foregroundRect(): NativeWindowRect | null {
  if (!api) return null;
  const hwnd = api.GetForegroundWindow();
  if (!hwnd) return null;
  return extendedBounds(hwnd);
}

const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

/**
 * BASENAME of the foreground window's process — "code", never
 * "C:\...\Code.exe". The full path is discarded inside this function, on
 * purpose: it is the one place a path exists, and nothing past this line may
 * see it (CLAUDE.md §11). This plus `idleMs` is the app's ENTIRE view of what
 * the user is doing (§8).
 */
function basenameOfPid(pid: number): string | null {
  if (!api || pid === 0) return null;
  const h = api.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
  if (!h || api.address(h) === 0n) return null;
  try {
    const buf = new Uint16Array(1024);
    const size = new Uint32Array([buf.length]);
    if (!api.QueryFullProcessImageNameW(h, 0, buf, size)) return null;
    const full = String.fromCharCode(...buf.subarray(0, size[0]!));
    const base = full.replace(/\\/g, '/').split('/').pop() ?? '';
    return base.toLowerCase().replace(/\.exe$/, '') || null;
  } finally {
    api.CloseHandle(h);
  }
}

function pidOfWindow(hwnd: unknown): number {
  if (!api) return 0;
  const out = new Uint32Array(1);
  api.GetWindowThreadProcessId(hwnd, out);
  return out[0]!;
}

export function foregroundApp(): string | null {
  if (!api) return null;
  const hwnd = api.GetForegroundWindow();
  if (!hwnd) return null;

  const pid = pidOfWindow(hwnd);
  let app = basenameOfPid(pid);

  // UWP/Store apps: the top-level foreground window belongs to
  // ApplicationFrameHost.exe; the actual app lives in a CoreWindow child
  // with a different pid. Without this hop every Store app observes as
  // "applicationframehost" and none of them can be classified individually
  // (verified with Calculator on the dev machine).
  if (app === 'applicationframehost') {
    const child = api.FindWindowExW(hwnd, null, 'Windows.UI.Core.CoreWindow', null);
    if (child && api.address(child) !== 0n) {
      const childPid = pidOfWindow(child);
      if (childPid !== pid) app = basenameOfPid(childPid) ?? app;
    }
  }
  return app;
}

/**
 * Milliseconds since the last keyboard/mouse input, via GetLastInputInfo.
 * Coarse by design: one number, no hook, no keystroke content. Tick counts
 * are 32-bit; the subtraction is wrap-safe.
 */
export function idleMs(): number {
  if (!api) return 0;
  const info = new Uint8Array(8);
  new DataView(info.buffer).setUint32(0, 8, true); // cbSize
  if (!api.GetLastInputInfo(info)) return 0;
  const last = new DataView(info.buffer).getUint32(4, true);
  return (api.GetTickCount() - last) >>> 0;
}
