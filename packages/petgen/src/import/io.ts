/**
 * The only file in the import pipeline that touches sharp or the filesystem.
 * Everything else works on plain RGBA buffers so it can be tested without
 * decoding a single real image.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import sharp from 'sharp';
import type { Raster } from './raster.js';

export async function loadRaster(file: string): Promise<Raster> {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { w: info.width, h: info.height, data: new Uint8Array(data) };
}

export interface AnimatedImage {
  frames: Raster[];
  /** Per-frame display time, ms. Same length as frames. */
  delaysMs: number[];
}

/**
 * Decode an animated GIF or WebP into full coalesced frames. (Not APNG —
 * libvips reads PNG through a loader with no animation support, so an APNG
 * comes back as a single frame.)
 * libvips resolves GIF frame disposal itself, so every page comes back as a
 * complete canvas — no compositing needed here.
 */
export async function loadAnimated(file: string): Promise<AnimatedImage> {
  const img = sharp(file, { animated: true, pages: -1 });
  const meta = await img.metadata();
  const pages = meta.pages ?? 1;
  const pageH = meta.pageHeight ?? meta.height ?? 0;

  const { data, info } = await img.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const w = info.width;
  const stride = w * pageH * 4;

  const frames: Raster[] = [];
  for (let p = 0; p < pages; p++) {
    frames.push({ w, h: pageH, data: new Uint8Array(data.subarray(p * stride, (p + 1) * stride)) });
  }

  // sharp reports delay in ms (already ×10 from the GIF's centiseconds).
  // Browsers clamp 0/1cs to 100ms; do the same rather than inventing 1000fps.
  const raw = meta.delay ?? [];
  const delaysMs = frames.map((_, i) => {
    const d = raw[i] ?? raw[0] ?? 100;
    return d < 20 ? 100 : d;
  });

  return { frames, delaysMs };
}

export async function savePng(r: Raster, file: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const buf = await sharp(Buffer.from(r.data.buffer, r.data.byteOffset, r.data.byteLength), {
    raw: { width: r.w, height: r.h, channels: 4 },
  })
    .png()
    .toBuffer();
  await writeFile(file, buf);
}
