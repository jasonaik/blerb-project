#!/usr/bin/env node
/**
 * Generates packs/blob/atlas.png — the CC0 placeholder pet.
 *
 * Deliberately dependency-free (node:zlib is a builtin), so it runs the moment
 * Node exists and before `pnpm install`. That matters: it removes a chicken-
 * and-egg problem where you can't see a pet until the toolchain is fully up.
 *
 * 8 cells, 32x32, laid out 4 across / 2 down:
 *   0  idle, neutral         1  idle, breathing in
 *   2  walk, contact pose    3  walk, passing pose
 *   4  climb, reach          5  climb, pull
 *   6  cling, settled        7  cling, breathing
 *
 * WHY THE CLIMB CELLS LOOK SIDEWAYS: on a wall the renderer rotates the sprite
 * by +-90 degrees about its anchor so the feet meet the surface (see
 * deriveFrame in @blerb/core). In cell space that means the bottom edge is the
 * wall and +x is the direction of travel *along* it. So a climb pose is drawn
 * as a blob hugging the ground and reaching to its right, and comes out as a
 * blob hugging the wall and reaching upward. Facing flips it for the way down.
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
const COLS = 4;

// A friendly blue blob. Evokes a certain water-type without being it —
// see CLAUDE.md § IP for why the shipped default pet is original art.
const BODY = [0x6b, 0xa8, 0xd6, 0xff];
const OUTLINE = [0x2f, 0x54, 0x73, 0xff];
const BELLY = [0x9a, 0xc9, 0xe8, 0xff];
const EYE_WHITE = [0xf4, 0xfa, 0xff, 0xff];
const PUPIL = [0x22, 0x33, 0x44, 0xff];

const EYE = [2.4, 2.6];
const PUPIL_R = [1.1, 1.3];
const PUPIL_OFF = [0.4, 0.5];
/** Smaller, and looking the way it's going. A flattened pose has less face to work with. */
const WALL_EYE = { eye: [1.9, 1.9], pupil: [1.0, 1.0], pupilOff: [0.5, 0] };
/** Hanging on takes effort and the pet is resting — half-lidded, looking back. */
const DROWSY = { eye: [1.9, 1.5], pupil: [0.95, 0.85], pupilOff: [-0.4, 0.1] };

/**
 * Per-frame pose. Ellipses are [cx, cy, rx, ry] in cell-local px, +y down.
 * `nubs` are the feet on the ground and the gripping hands on a wall — same
 * shapes doing both jobs, which is the whole trick that keeps this 8 cells.
 */
const POSES = [
  // 0 — idle, neutral
  {
    body: [16, 18, 10, 9.0],
    belly: [16, 21, 6.5, 5.2],
    nubs: [[11, 29, 4, 2.6], [21, 29, 4, 2.6]],
    eyes: [[12.5, 15.5], [19.5, 15.5]],
  },
  // 1 — idle, breathing in: settles a little and widens
  {
    body: [16, 18.6, 10, 8.4],
    belly: [16, 21.6, 6.5, 5.2],
    nubs: [[11, 29, 4, 2.6], [21, 29, 4, 2.6]],
    eyes: [[12.5, 15.9], [19.5, 15.9]],
  },
  // 2 — walk, contact: feet apart, body lifted
  {
    body: [16, 17.6, 10, 9.0],
    belly: [16, 20.6, 6.5, 5.2],
    nubs: [[8.5, 29, 4, 2.6], [22.5, 29.5, 4, 2.6]],
    eyes: [[12.5, 15.2], [19.5, 15.2]],
  },
  // 3 — walk, passing: feet together, body low
  {
    body: [16, 18.8, 10, 8.6],
    belly: [16, 21.8, 6.5, 5.2],
    nubs: [[13, 29.5, 4, 2.6], [19, 29, 4, 2.6]],
    eyes: [[12.5, 16.0], [19.5, 16.0]],
  },
  // 4 — climb, reach: flattened against the surface, leading hand thrown far
  //     ahead, trailing hand tucked under the body.
  //     The eyes are stacked in y, not spread in x like the ground poses. That
  //     is deliberate: the 90 degree rotation turns cell-y into screen-x, so
  //     stacked-in-cell reads as a face looking out at you from the wall.
  //     Spread-in-cell would read as one eye above the other.
  {
    body: [14.6, 22.4, 10.4, 6.9],
    belly: [14.6, 25.2, 6.4, 3.4],
    nubs: [[23.5, 28.6, 6.5, 2.4], [7.5, 29.2, 4.5, 2.3]],
    eyes: [[19.5, 19.7], [19.5, 25.1]],
    ...WALL_EYE,
  },
  // 5 — climb, pull: the body has hauled itself forward past the leading arm,
  //     trailing arm left behind. Same two limbs, opposite roles.
  {
    body: [17.0, 22.8, 10.2, 6.8],
    belly: [17.0, 25.6, 6.3, 3.3],
    nubs: [[21.0, 29.2, 4.5, 2.3], [6.5, 28.6, 6.0, 2.4]],
    eyes: [[21.5, 20.1], [21.5, 25.5]],
    ...WALL_EYE,
  },
  // 6 — cling, settled: both arms planted, pressed as flat as it gets
  {
    body: [16, 23.0, 9.9, 6.4],
    belly: [16, 25.6, 6.1, 3.1],
    nubs: [[9.5, 28.9, 5.2, 2.5], [22.5, 28.9, 5.2, 2.5]],
    eyes: [[20.0, 20.4], [20.0, 25.6]],
    ...DROWSY,
  },
  // 7 — cling, breathing: the only motion available to something holding on
  {
    body: [16, 22.6, 9.7, 6.7],
    belly: [16, 25.3, 6.0, 3.3],
    nubs: [[9.5, 28.9, 5.2, 2.5], [22.5, 28.9, 5.2, 2.5]],
    eyes: [[20.0, 20.0], [20.0, 25.2]],
    ...DROWSY,
  },
];

const FRAMES = POSES.length;
const ROWS = Math.ceil(FRAMES / COLS);
const W = CELL * COLS;
const H = CELL * ROWS;

const px = new Uint8Array(W * H * 4); // transparent

const inEllipse = (x, y, [cx, cy, rx, ry]) => {
  const dx = (x - cx) / rx;
  const dy = (y - cy) / ry;
  return dx * dx + dy * dy <= 1;
};

/** Is (x,y) part of the character silhouette for this pose? */
function solid(pose, x, y) {
  if (inEllipse(x, y, pose.body)) return true;
  for (const n of pose.nubs) if (inEllipse(x, y, n)) return true;
  return false;
}

/** A 1px darker rim wherever the silhouette meets empty space. */
function isEdge(pose, x, y) {
  return (
    !solid(pose, x - 1, y) ||
    !solid(pose, x + 1, y) ||
    !solid(pose, x, y - 1) ||
    !solid(pose, x, y + 1)
  );
}

function set(frame, x, y, rgba) {
  if (x < 0 || y < 0 || x >= CELL || y >= CELL) return;
  const ox = (frame % COLS) * CELL + x;
  const oy = Math.floor(frame / COLS) * CELL + y;
  const i = (oy * W + ox) * 4;
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
      // Without the rim the sprite dissolves into a light background — and the
      // pet spends its life on top of arbitrary windows.
      if (isEdge(pose, x, y)) set(f, x, y, OUTLINE);
      else if (inEllipse(x, y, pose.belly)) set(f, x, y, BELLY);
      else set(f, x, y, BODY);
    }
  }

  // Eyes, drawn over the body. Clipped to the *interior* so an eye placed near
  // the leading edge — which the climb poses do deliberately — eats into the
  // body rather than punching a hole through the outline.
  const eyeR = pose.eye ?? EYE;
  const pupilR = pose.pupil ?? PUPIL_R;
  const pupilOff = pose.pupilOff ?? PUPIL_OFF;

  for (const [ex, ey] of pose.eyes) {
    for (let y = 0; y < CELL; y++) {
      for (let x = 0; x < CELL; x++) {
        if (!solid(pose, x, y) || isEdge(pose, x, y)) continue;
        if (inEllipse(x, y, [ex, ey, eyeR[0], eyeR[1]])) set(f, x, y, EYE_WHITE);
      }
    }
    for (let y = 0; y < CELL; y++) {
      for (let x = 0; x < CELL; x++) {
        if (!solid(pose, x, y) || isEdge(pose, x, y)) continue;
        const p = [ex + pupilOff[0], ey + pupilOff[1], pupilR[0], pupilR[1]];
        if (inEllipse(x, y, p)) set(f, x, y, PUPIL);
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
