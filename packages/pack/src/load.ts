import { resolvePack, PackError, type ResolvedPack } from './resolve.js';

/**
 * Minimal shape of `fetch` that this package needs.
 *
 * Injected rather than reached for, so the same loader serves the Electron
 * renderer, the petgen preview page, and a Node unit test reading from disk.
 * (See the eslint `pure-packages` rule — reaching for a global `fetch` is
 * exactly the coupling we're avoiding.)
 */
export type Fetcher = (url: string) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export async function loadPack(fetcher: Fetcher, manifestUrl: string): Promise<ResolvedPack> {
  let res;
  try {
    res = await fetcher(manifestUrl);
  } catch (cause) {
    throw new PackError(`could not fetch ${manifestUrl}: ${String(cause)}`);
  }
  if (!res.ok) {
    throw new PackError(`could not fetch ${manifestUrl}: HTTP ${res.status}`);
  }

  const raw = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (cause) {
    throw new PackError(`${manifestUrl} is not valid JSON: ${String(cause)}`);
  }

  return resolvePack(json, manifestUrl);
}
