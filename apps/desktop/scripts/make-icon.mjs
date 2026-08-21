/**
 * build/icon.ico from the blob atlas's first cell — the same face the tray
 * wears. Nearest-neighbour upscales keep the pixel art pixels.
 *
 * ICO is written by hand: it is just a 6-byte header, one 16-byte directory
 * entry per image, then the images — and Vista+ accepts PNG-compressed
 * entries, which sharp already produces. A dependency for that would be 40
 * lines of format trivia outsourced.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const here = dirname(fileURLToPath(import.meta.url));
const packDir = resolve(here, '..', '..', '..', 'packs', 'blob');
const out = resolve(here, '..', 'build', 'icon.ico');

const SIZES = [16, 24, 32, 48, 64, 128, 256];

// Cell 0's geometry from the pack itself, so redrawing blob at another size
// can't silently start cropping the icon out of the wrong pixels.
const pet = JSON.parse(await readFile(resolve(packDir, 'pet.json'), 'utf8'));
const grid = pet.grid ?? {};
const margin = grid.margin ?? 0;
const cellW = grid.w ?? 32;
const cellH = grid.h ?? 32;

const face = await readFile(resolve(packDir, 'atlas.png'));
const pngs = await Promise.all(
  SIZES.map((size) =>
    sharp(face)
      .extract({ left: margin, top: margin, width: cellW, height: cellH })
      .resize(size, size, { kernel: 'nearest' })
      .png()
      .toBuffer(),
  ),
);

const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // type: icon
header.writeUInt16LE(SIZES.length, 4);

const entries = [];
let offset = 6 + 16 * SIZES.length;
for (let i = 0; i < SIZES.length; i++) {
  const e = Buffer.alloc(16);
  e.writeUInt8(SIZES[i] === 256 ? 0 : SIZES[i], 0); // width, 0 means 256
  e.writeUInt8(SIZES[i] === 256 ? 0 : SIZES[i], 1); // height
  e.writeUInt8(0, 2); // palette size
  e.writeUInt8(0, 3); // reserved
  e.writeUInt16LE(1, 4); // color planes
  e.writeUInt16LE(32, 6); // bits per pixel
  e.writeUInt32LE(pngs[i].length, 8);
  e.writeUInt32LE(offset, 12);
  offset += pngs[i].length;
  entries.push(e);
}

await mkdir(dirname(out), { recursive: true });
await writeFile(out, Buffer.concat([header, ...entries, ...pngs]));
console.log(`wrote ${out} (${SIZES.join(', ')}px)`);
