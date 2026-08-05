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
const GWL_STYLE = -16;
const GWL_EXSTYLE = -20;
const WS_MAXIMIZE = 0x0100_0000;
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
  address: (h: unknown) => bigint;
}

let api: Api | null = null;

try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const koffi = require('koffi') as typeof import('koffi');
  const user32 = koffi.load('user32.dll');
  const dwmapi = koffi.load('dwmapi.dll');

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
 * pet: visible, titled, not minimized, not maximized (Shimeji's rule — a
 * maximized window's top edge is the screen edge, not a ledge), not a tool
 * window (which also conveniently excludes our own overlay), not cloaked.
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
      const style = api.GetWindowLongW(hwnd, GWL_STYLE);
      const ex = api.GetWindowLongW(hwnd, GWL_EXSTYLE);
      if ((style & WS_MAXIMIZE) === 0 && (ex & WS_EX_TOOLWINDOW) === 0 && !isCloaked(hwnd)) {
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
