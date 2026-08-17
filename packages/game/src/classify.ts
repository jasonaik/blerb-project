import type { Bucket, Classification } from './types.js';

/**
 * Normalize a process name to the shape the user's lists speak:
 * lowercase, no `.exe`, and — defensively — no path. The host is supposed to
 * pass a basename already, but a full path must die HERE, at the boundary,
 * because everything past this function is state that could one day persist
 * (CLAUDE.md §11: never persist file paths).
 */
export function normalizeApp(name: string): string {
  // Defense in depth: classification lists are hand-edited JSON, and a
  // non-string member must degrade to "matches nothing", not throw inside
  // a poll loop.
  if (typeof name !== 'string') return '';
  const base = name.replace(/\\/g, '/').split('/').pop() ?? '';
  return base.toLowerCase().replace(/\.exe$/, '');
}

/**
 * Which list is this app on? Unlisted means neutral — the app has no opinion
 * about software the user hasn't classified.
 */
export function bucketOf(app: string, cls: Classification): Bucket {
  const a = normalizeApp(app);
  if (cls.focus.some((f) => normalizeApp(f) === a)) return 'focus';
  if (cls.elsewhere.some((e) => normalizeApp(e) === a)) return 'elsewhere';
  return 'neutral';
}
