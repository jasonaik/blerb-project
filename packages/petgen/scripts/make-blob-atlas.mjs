#!/usr/bin/env node
/**
 * Generates packs/blob/atlas.png — the CC0 placeholder pet.
 *
 * Deliberately dependency-free (node:zlib is a builtin), so it runs the moment
 * Node exists and before `pnpm install`. That matters: it removes a chicken-
 * and-egg problem where you can't see a pet until the toolchain is fully up.
 *
 * Draws a 4-cell 32x32 walk cycle:
 *   0  idle, neutral        1  idle, breathing in
 *   2  walk, contact pose   3  walk, passing pose
 *
 * Replace this with real art whenever you like — nothing depends on it beyond
 * packs/blob/pet.json, and that file is the 12-line example the format has to
 * keep supporting.
 *
 *   node packages/petgen/scripts/make-blob-atlas.mjs
 */

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CELL = 32;
const FRAMES = 4;
const W = CELL * FRAMES;
const H = CELL;

// A friendly blue blob. Evokes a certain water-type without being it —
// see CLAUDE.md § IP for why the shipped default pet is original art.
const BODY = [0x6b, 0xa8, 0xd6, 0xff];
const OUTLINE = [0x2f, 0x54, 0x73, 0xff];
const BELLY = [0x9a, 0xc9, 0xe8, 0xff];
const EYE_WHITE = [0xf4, 0xfa, 0xff, 0xff];
const PUPIL = [0x22, 0x33, 0x44, 0xff];

/** Per-frame pose. y offsets are in px; positive is down. */
const POSES = [
  { bodyDy: 0, bodyRy: 9.0, footL: [11, 29], footR: [21, 29], eyeDy: 0 },
  { bodyDy: 0.6, bodyRy: 8.4, footL: [11, 29], footR: [21, 29], eyeDy: 0.4 },
  { bodyDy: -0.4, bodyRy: 9.0, footL: [8.5, 29], footR: [22.5, 29.5], eyeDy: -0.3 },
  { bodyDy: 0.8, bodyRy: 8.6, footL: [13, 29.5], footR: [19, 29], eyeDy: 0.5 },
];

const px = new Uint8Array(W * H * 4); // transparent

const inEllipse = (x, y, cx, cy, rx, ry) => {
  const dx = (x - cx) / rx;
  const dy = (y - cy) / ry;
  return dx * dx + dy * dy <= 1;
};

/** Is (x,y) part of the character silhouette for this pose? */
function solid(pose, x, y) {
  if (inEllipse(x, y, 16, 18 + pose.bodyDy, 10, pose.bodyRy)) return true;
  if (inEllipse(x, y, pose.footL[0], pose.footL[1], 4, 2.6)) return true;
  if (inEllipse(x, y, pose.footR[0], pose.footR[1], 4, 2.6)) return true;
  return false;
}

function set(frame, x, y, rgba) {
  if (x < 0 || y < 0 || x >= CELL || y >= H) return;
  const i = ((y * W) + frame * CELL + x) * 4;
  px[i] = rgba[0];
  px[i + 1] = rgba[1];
  px[i + 2] = rgba[2];
  px[i + 3] = rgba[3];
}

for (let f = 0; f < FRAMES; f++) {
  const pose = POSES[f];

  for (let y = 0; y < CELL; y++) {
    for (let x = 0; x < CELL; x++) {
      if (!solid(pose, x, y)) continue;

      // 1px darker rim wherever the silhouette meets empty space. Cheap, and
      // it's what stops the sprite dissolving into a light background.
      const edge =
        !solid(pose, x - 1, y) ||
        !solid(pose, x + 1, y) ||
        !solid(pose, x, y - 1) ||
        !solid(pose, x, y + 1);

      if (edge) {
        set(f, x, y, OUTLINE);
      } else if (inEllipse(x, y, 16, 21 + pose.bodyDy, 6.5, 5.2)) {
        set(f, x, y, BELLY);
      } else {
        set(f, x, y, BODY);
      }
    }
  }

  // Eyes, drawn over the body so they sit on top of the belly patch.
  for (const ex of [12.5, 19.5]) {
    const ey = 15.5 + pose.eyeDy;
    for (let y = 0; y < CELL; y++) {
      for (let x = 0; x < CELL; x++) {
        if (inEllipse(x, y, ex, ey, 2.4, 2.6)) set(f, x, y, EYE_WHITE);
      }
    }
    for (let y = 0; y < CELL; y++) {
      for (let x = 0; x < CELL; x++) {
        if (inEllipse(x, y, ex + 0.4, ey + 0.5, 1.1, 1.3)) set(f, x, y, PUPIL);
      }
    }
  }
}

// ---- minimal PNG encoder (RGBA8, no interlace) ----

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // colour type: RGBA
ihdr[10] = 0; // deflate
ihdr[11] = 0; // adaptive filtering
ihdr[12] = 0; // no interlace

// Filter type 0 (None) per scanline. The image is tiny and mostly flat, so
// there is nothing to gain from a smarter filter choice here.
const raw = Buffer.alloc((W * 4 + 1) * H);
for (let y = 0; y < H; y++) {
  raw[y * (W * 4 + 1)] = 0;
  Buffer.from(px.buffer, y * W * 4, W * 4).copy(raw, y * (W * 4 + 1) + 1);
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, '../../../packs/blob/atlas.png');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, png);
console.log(`wrote ${out} (${W}x${H}, ${FRAMES} cells, ${png.length} bytes)`);
