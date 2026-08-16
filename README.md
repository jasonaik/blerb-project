# blerb

A desktop screen pet for Windows 11. A sprite lives on top of everything — the desktop, your editor, Chrome, the taskbar — wanders around, stands on the top edges of your real windows, hangs upside down from their title bars, climbs the sides of the screen, and walks between monitors.

It is also, eventually, a productivity game. That layer isn't built yet; see [Status](#status).

<!-- A screenshot goes well here once you have one you like. -->

---

## Requirements

| | |
|---|---|
| OS | Windows 11. Developed and tested only there. Windows 10 2004+ has the APIs but is unverified. |
| Node | 20.11 or newer |
| pnpm | 9 (`npm install -g pnpm`) |

Everything is JavaScript — there is no native compilation step and no `electron-rebuild`. Win32 calls go through [koffi](https://koffi.dev/), which ships prebuilt.

## Run it

```bash
pnpm install
```

```bash
pnpm desktop
```

That builds the workspace and launches the overlay. What you should see:

- A small blue blob walking along the bottom of your screen, **on top of the taskbar** and every window.
- A tray icon (it's the pet's face).
- The pet still visible after Alt-Tab, and no taskbar button of its own.

It takes a few seconds the first time while TypeScript builds. Quit from the tray, or the **Quit blerb** button in settings — closing windows doesn't quit a tray app.

## The settings GUI

Open it from the **tray icon → Settings…**, by **double-clicking the tray icon**, or by **right-clicking the pet**.

| Setting | Default | What it does |
|---|---|---|
| Pet visible | on | Hides the pet without quitting. It stops moving entirely while hidden. |
| Invisible in screen capture | **on** | Sets `WDA_EXCLUDEFROMCAPTURE`. Windows itself keeps the pet out of screen shares and recordings while leaving it visible to you. |
| Start with Windows | off | Standard login item. |
| Pet size | 2× | 1–4×. Integer scales only, because the art is pixel art. |
| Can climb walls | on | Whether the pet clings to and climbs the outer edges of the desktop. |
| Can hang upside down | on | Whether it hangs under the top edge of a window, or the top of the screen, and walks along upside down. |
| Follow moving windows smoothly | on | Watches the desktop ~60×/s while you drag or resize a window, instead of ~3×/s, so the pet rides it rather than jumping after it. Costs about 1% of one CPU core, and only while something is actually moving. Turn it off if you want the app as close to free as possible. |
| Debug overlay | off | Draws the platforms, walls and ceilings the pet believes in. Unglamorous and the fastest way to see why it's standing somewhere odd. |

Settings and the pet's last position are stored in `%APPDATA%\blerb-desktop\` as `settings.json` and `pet-snapshot.json`. Delete them to reset.

The tray menu carries the same toggles plus **Recenter pet**, for when it has wandered somewhere you can't reach.

## Playing with the pet

- **Drag it.** Left-click and drag anywhere, including onto another monitor. It falls from wherever you drop it. Drop it against a screen edge and it clings, just under a title bar and it hangs there upside down, or inside a floating window and it settles on the bottom of that window. This is the only way to get it onto a window — it can't jump.
- **Right-click it** for the menu, including **Keep in this window** — shut it into whatever window it is standing in, so it paces the bottom, climbs the sides and hangs from the title bar until you let it out. Drag it out, or close the window, and it is free again. Either way, in or out of a terrarium, it rides along when you move the window — smoothly, in ~10px steps rather than 150px lurches, as long as **Follow moving windows smoothly** is on.
- **Leave it alone.** It wanders, sits, sleeps, climbs the edges of the screen and hangs upside down from window title bars. Ignoring it costs nothing and changes nothing.

Everywhere else on screen, clicks pass straight through to whatever is underneath.

## Multiple monitors

The pet treats your whole desktop as **one world with holes in it**, not as several worlds. A few rules produce everything:

- a screen's **whole bottom edge is ground**, so the pet stands on the monitor you put it on rather than dropping out of sight
- where another screen lies directly below, that stretch is a **seam**: still solid, but the pet occasionally slips through it to the screen beneath — the only way off an upper monitor
- a **wall** exists along a screen's side edge only where no screen sits alongside it

So the pet walks across the boundary between two adjacent monitors, drifts down to a lower screen in its own time, and climbs the outer edge of the desktop. Where two screens are offset — a laptop below and an external above and to one side — it climbs to the corner and **mantles**: hauls itself up onto a floor within 96px above the lip.

Mixed DPI is handled: one window per display at that display's own scale factor, never one big window spanning everything.

## Seeing a pet walk without launching Electron

```bash
pnpm preview
```

Opens a browser page with the pet walking on a floor with a few ledges. This is the inner development loop — the preview aliases `@blerb/*` to their **sources**, so edits to the simulation are live with no build step.

| | |
|---|---|
| `d` | toggle the debug overlay |
| `r` | recenter |
| `q` | close |
| click | call the pet over |

## Development

```bash
pnpm test        # deterministic simulation + design-contract tests
```

```bash
pnpm typecheck   # every package and app, including the preview harness
```

```bash
pnpm lint        # includes the rule keeping @blerb/core and @blerb/game pure
```

```bash
pnpm build       # tsc --build across the workspace
```

```bash
pnpm blob        # regenerate packs/blob/atlas.png from its generator script
```

Diagnostic environment variables:

| | |
|---|---|
| `BLERB_DEBUG=1` | log every world scan (screens, floors, walls, ceilings) and each pet state change |
| `BLERB_CLIMBY=1` | climb at every wall instead of ~45% of the time — exercises the multi-monitor path without waiting on dice |
| `BLERB_SOFTWARE=1` | disable GPU compositing |
| `BLERB_ALLOW_CAPTURE=1` | let screen capture see the pet, so it can be verified in a screenshot |

## Pets

The shipped pet is `packs/blob` — original CC0 art, generated by a script in `packages/petgen/scripts/`. A pet is a directory with a `pet.json` and an `atlas.png`, and the complete working example is 18 lines:

```json
{
  "format": "blerb-pet/1",
  "id": "blob", "name": "Blob", "author": "blerb", "license": "CC0-1.0",
  "pixelArt": true,
  "atlas": { "src": "atlas.png" },
  "grid": { "w": 32, "h": 32, "cols": 4 },
  "animations": {
    "idle":  { "fps": 2,   "frames": [0, 1] },
    "walk":  { "fps": 8,   "frames": [2, 0, 3, 0], "designSpeed": 40 },
    "climb": { "fps": 5,   "frames": [4, 5],       "designSpeed": 28 },
    "cling": { "fps": 1.5, "frames": [6, 7] }
  },
  "aliases": { "hang": "walk" }
}
```

Missing animations degrade rather than crash — a pack with only `idle` still runs.

### Importing your own art

```bash
pnpm petgen from-gif walk.gif idle.gif -o packs/my-pet
```

Three importers, by what you have:

| You have | Command |
|---|---|
| A sprite sheet on a grid | `petgen from-sheet sheet.png --grid 32x32 --anim walk=0-3@8 --anim idle=4,5@2 -o packs/x` |
| A folder of frame PNGs (`walk_0.png`, `walk_1.png`…) | `petgen from-frames ./frames -o packs/x` |
| Animated GIFs/WebPs, one per animation | `petgen from-gif walk.gif idle.gif -o packs/x` |
| **One picture** — a drawing, official art, anything | `petgen from-image pet.jpg -o packs/x` |

`from-image` needs no frames at all: the background is removed automatically (flood fill from the corners, so interior whites survive) and a procedural rig makes the single image walk — squash-and-stretch about its feet, a bob locked to distance travelled, a lean into the direction of travel. Deliberately not AI frame generation: deformation can look stiff, but it can never flicker into a different character.

Every import ends by running `petgen doctor` on the result and telling you how to preview it. The importers derive the ground anchor from the art (where the feet are), keep the frames registered so walk bobs survive, detect pixel art and undo clean upscales, and read GIF timing from the file itself. What your art needs to look like — transparent background, facing right, feet uncropped — is documented in [`docs/pet-art.md`](docs/pet-art.md).

The pet the app uses is chosen by `pack` in `%APPDATA%\blerb-desktop\settings.json` — set it to your imported pack's directory name. `petgen from-image` (one static image, procedural gait) is designed but not built yet.

## Privacy

- **There is no network code in this project.** Not disabled — absent.
- Nothing leaves your machine, because nothing has anywhere to go.
- The only files written are the two in `%APPDATA%\blerb-desktop\` described above.
- The game layer, when it exists, will record `{bucket, minutes}` and never a URL, window title, or file path.

## Status

Built and working: the simulation core, the pack format, the canvas renderer, the preview harness, and the Electron overlay — walking, falling, dragging, climbing, hanging upside down, and full multi-monitor roaming.

Also built: the sprite importers (`petgen from-sheet`, `from-frames`, `from-gif`, `from-image` with its procedural gait) and `petgen doctor`.

Not built yet: the whole game layer (sessions, retrospective XP, app classification, breaks). The design for those is settled and deliberately evidence-led — including a decision *not* to infer focus or attention, because the best published detector is ~75% accurate and its characteristic failure is firing hardest at someone quietly concentrating.

Known rough edges:

- Three-display and L-shaped layouts are untested. The geometry is general; only two-screen layouts have been observed.
- The pet is verifiably absent from screen captures, but that has been checked with automated captures rather than a live Zoom or Teams share.
- The pet hides rather than drawing over the Start menu, Task View, Alt-Tab, or an exclusive-fullscreen game. Those live in z-bands a normal app cannot reach.

## More

[`CLAUDE.md`](CLAUDE.md) is the operating summary: the verified platform constraints, the design contract, the monorepo import rules, and the measured spike results. Read it before changing anything — several of its constraints are there because the obvious approach was tried and doesn't work.

## Licence

MIT for the code. `packs/blob` is CC0.
