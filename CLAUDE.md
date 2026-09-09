# blerb

A desktop screen pet that is also a productivity game. A sprite lives on top of everything on your Windows desktop, wanders around, stands on the edges of your real windows, and reacts to what you're doing.

Windows 11, Electron. One shared simulation core drives every surface.

The full reasoning behind every decision here lives in the plan at `~/.claude/plans/i-thinking-of-creating-precious-mochi.md`. This file is the operating summary.

---

## 1. How do I see a pet walk in 10 seconds

```bash
pnpm install && pnpm preview
```

That opens a browser page with the pet walking around on a floor and some ledges. `d` toggles a debug overlay showing platform lines and the pet's ground anchor, `r` recenters, clicking calls the pet over.

**The real thing** — pet on the actual desktop, over every window:

```bash
pnpm desktop
```

One overlay window per display; the pet roams all of them. Tray icon → settings, recenter, quit. Right-click the pet for the same menu. Drag it anywhere — including onto another monitor — and it falls from wherever you drop it. It climbs the outer edges of the desktop on its own; window ledges it can only reach by being carried, since it can't jump.

Diagnostic env vars:

| | |
|---|---|
| `BLERB_DEBUG=1` | log every world scan (screens, floors, walls) and each pet state change |
| `BLERB_CLIMBY=1` | climb at every wall instead of ~45% of the time — exercises the multi-monitor path without waiting on dice |
| `BLERB_SOFTWARE=1` | disable GPU compositing |
| `BLERB_ALLOW_CAPTURE=1` | let screen capture see the pet, so it can be verified in a screenshot |
| `BLERB_IMPORT=a.gif;b.gif` (+`BLERB_IMPORT_NAME=x`) | run the GUI import path headlessly at startup — how the packaged sharp pipeline gets machine-verified |

The preview aliases `@blerb/*` to their **sources**, so edits to the sim are live without a build step. This is the inner loop — use it.

```bash
pnpm test          # @blerb/core and @blerb/game determinism + contract tests
pnpm typecheck     # tsc --build, then every package's and app's own typecheck
pnpm lint          # includes the pure-packages rule, see §4
pnpm build         # tsc --build. Packages emit ESM + .d.ts to dist/
pnpm blob          # regenerate packs/blob/atlas.png from its generator
pnpm dist          # Windows installer → apps/desktop/release/blerb-setup-*.exe
pnpm pokemon <dir> # batch-import HGSS follower sprites from a LOCAL clone of
                   # jakobhoeg/vscode-pokemon (--shiny --gens --only --out --force)
```

**Never write `--filter './packages/**'` in a root script.** pnpm scripts run through `cmd.exe`, which does not strip single quotes, so the filter arrives with the quotes attached and matches **nothing** — silently, with exit code 0. Use double quotes. This shipped broken once and `pnpm build` was a no-op for two phases; the app only worked because `tsc --build` happened to emit the same files.

`README.md` is the version of this section written for a human who just wants to run the thing.

**Packaging facts** (learned by building it, 2026-08-21):

- **Pack roots.** Dev: the repo's `packs/`, one read-write root. Packaged: `resources/packs` (bundled, blob ONLY — §13) + `%APPDATA%\blerb-desktop\packs` (user-writable, where GUI imports land), searched user-first so a user pack shadows a bundled id. `packDirFor(id)` in main.ts is the single resolver; `fsRead` is fenced to the roots. If `settings.pack` names a pack that isn't on disk (dev pack seen by the installed app, or deleted), startup falls back to blob and saves — `switchPack` guards runtime picks, this guards launch.
- Dev and installed share userData **and therefore the single-instance lock** — you cannot run both at once; the second becomes an "open settings" signal to the first.
- electron-builder 26 handles the pnpm workspace fine and needs **no** dependency patching. If it dies at load with `Cannot find module 'tslib'` from `@peculiar/utils` (its codesign path), the virtual store is half-linked — run a full `pnpm install` at the root. A filtered `pnpm add -D … --filter blerb-desktop` can leave the new transitive deps unlinked. (A `pnpm.packageExtensions` entry declaring tslib was tried and reverted: `@peculiar/utils` already declares it, so the extension was a no-op and the full install was the actual repair.)
- sharp joined koffi as the second native runtime dep (GUI import). Both are tsup `external`, real `dependencies` of blerb-desktop, and `asarUnpack`ed (`node_modules/{koffi,sharp,@img}/**`) — .node files can't load from inside an asar. sharp is imported **lazily** in importer.ts so a broken sharp costs an import-error message, not startup. `npmRebuild: false` — both ship prebuilt N-API binaries.
- The app icon (`build/icon.ico`) is generated from blob's first atlas cell by `apps/desktop/scripts/make-icon.mjs` — ICO written by hand (6-byte header + 16-byte entries + PNG blobs; Vista+ accepts PNG-compressed entries).

---

## 2. Hard platform constraints — READ BEFORE PROPOSING ANYTHING

**These are verified against primary sources. Do not re-litigate them. If you think one is wrong, say so and stop — don't code around it.**

| Tempting thing | Why it doesn't work | Do this instead |
|---|---|---|
| `setAlwaysOnTop(true)` and expect to clear the taskbar | Electron's `floating`…`status` levels sit *below* the Windows taskbar | `setAlwaysOnTop(true, 'pop-up-menu')` or higher |
| One big window spanning all monitors | Mixed-DPI gives the whole surface one scale factor; the pet is the wrong physical size on one monitor (electron#8533, #10862, #31999) | One window per display, sized to `display.bounds` |
| Key windows by `screen.getAllDisplays()` array index | Display ordering is not stable across APIs (electron#42031) | Key by `display.id` |
| Size the window to `display.workArea` | Excludes the taskbar, and walking on the taskbar is the whole charm | `display.bounds` |
| Compare Electron `screen` coords to Win32 coords directly | Electron returns **DIP**, Win32 returns **physical px**, and `DWMWA_EXTENDED_FRAME_BOUNDS` is explicitly not DPI-adjusted | `screen.dipToScreenPoint` / `screenToDipPoint` |
| `GetWindowRect` for window edges | Includes a ~7px invisible resize border since Vista — the pet visibly floats above every title bar | `DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, …)` |
| DOM `mousemove` for the click-through hit test | `setIgnoreMouseEvents(…, {forward:true})` silently stops delivering `mousemove` when Task Manager/Device Manager has focus (electron#33281, WONTFIX) | Poll `screen.getCursorScreenPoint()` in **main** as the source of truth |
| Set click-through once at startup | Forwarding stops after a renderer reload (electron#15376) | Re-apply on `did-finish-load` |
| Detect Zoom/Teams to hide during screen share | Fragile, and fails for every capture tool you didn't enumerate | `win.setContentProtection(true)` — maps to `WDA_EXCLUDEFROMCAPTURE`, enforced by DWM. Re-apply after `hide()`/`show()` (electron#29085) |
| Draw over the Start menu, Task View, or Alt-Tab | Those live in higher z-bands (`ZBID_IMMERSIVE_MOGO` / `ZBID_IMMERSIVE_APPCHROME`). Escaping needs `uiAccess=true` + Authenticode + install in Program Files | Design the pet to hide, not to pretend |
| Draw over an exclusive-fullscreen game | Bypasses DWM entirely. No window at any z-band can appear over it | Hide |
| `setVisibleOnAllWorkspaces` | Does nothing on Windows (Electron docs, verbatim) | Nothing; Windows virtual desktops need undocumented COM |
| `EnumWindows` for the platform walk | Doesn't give you z-order, and you need z-order so the pet stands on the *visible* window | Walk `GetWindow(GW_HWNDNEXT)` from the foreground window (Shimeji's approach) |
| `node-window-manager` / `ffi-napi` | Native modules ⇒ `electron-rebuild` pain; `ffi-napi` is effectively abandoned | `koffi` — no native compilation |

**Two hosts were evaluated and cut. Don't propose them.**

- **VS Code** — the official API forbids workbench DOM access (*"You cannot write an extension that applies custom CSS to VS Code or adds an HTML element to VS Code UI"*). A pet could live in a webview pane, or free-roam *inside the text editor only* via a `textDecoration` CSS-injection hack clipped by `.monaco-editor .overflow-guard`. Full-window roaming needs a workbench patcher that breaks on every VS Code update.
- **Chrome** — the tab strip and omnibox are native Views with no DOM. `chrome.omnibox` is text suggestions only; `chrome.theme` doesn't exist in Chrome. A content-script overlay on page content works fine and is a plausible v2 for per-domain classification, but it can never reach browser chrome.

---

## 3. The design contract

Derived from the evidence audit, not from taste. **An agent may not violate these.** If a request seems to require breaking one, say so rather than quietly complying.

1. **Nothing is contingent on time-in-app or per-unit engagement.** No live XP counter, no floating "+2", no reward for responding to the pet. (Deci/Koestner/Ryan 1999, 128 experiments: engagement-contingent reward d=−0.40, completion-contingent d=−0.36 on intrinsic motivation.)
2. **Rewards are retrospective and informational.** *"You held focus 52 minutes — longest this week"*, never *"+2 XP"*. (Positive informational feedback: **d=+0.33**. Same data, opposite sign.)
3. **The pet never suffers, decays, or expresses disappointment by default.** Missing a day costs nothing. (Lally et al. 2010: missing a single opportunity did not materially affect habit formation.)
4. **No streaks, no leaderboards.** Every streak statistic in circulation is marketing. Leaderboards harm low performers — exactly who installs a productivity app.
5. **Surprises are unexpected and non-collectible.** No "3/12 collected" display, ever. A completable random-reward set is a loot box.
6. **The pet never initiates on a schedule.** Breakpoint-triggered and randomised only. (Anticipating a *predictable* attention check degrades task performance in the run-up to it, d=0.13–0.29.)
7. **Ignoring the pet is completely free** and produces zero state change.
8. **Everything is optional; defaults are the evidence-backed setting.** No game element supplies autonomy — it comes from architecture: user-defined lists, choosable cosmetics, everything dismissible, nothing gated behind XP.
9. **Never claim to measure attention.** See §8.
10. **No interrupting popups.** No toasts, no tray balloons, no modals. Information is pull, or a passive tray state change.
11. **Privacy: no network code exists.** Never persist URLs, window titles, or file paths — only `{bucket, minutes}`.

Rules 3, 4 and 7 are enforced by tests, not just documented; so are rules 1 and 2 as applied to the retrospective's actual words (`game/src/summary.test.ts`), and rules 5 and 6 as applied to `surprise` (`core/src/sim.test.ts`). Keep it that way.

---

## 4. Monorepo map and import rules

```
packages/
  core/          @blerb/core          pet simulation. PURE.
  pack/          @blerb/pack          pet pack schema + loader
  render-canvas/ @blerb/render-canvas the ONLY renderer
  game/          @blerb/game          sessions, ledger, retrospective. PURE. [built; pet reactions not]
  petgen/        @blerb/petgen        sprite-import CLI + preview harness
apps/
  desktop/       blerb-desktop        Electron                              [Phase 2]
packs/
  blob/          CC0 default pet, committed
  quagsire/      gitignored — see §12
```

**`@blerb/core` and `@blerb/game` are pure.** No `electron`, no `node:*`, no `window`/`document`/`fetch`, no `Math.random`, no `Date.now`. Enforced by the `pure-packages` block in `eslint.config.js`. Apps hold adapters and contain **zero** simulation logic.

If you find yourself writing `if (host === 'electron')` inside `core`, the abstraction is wrong — fix the abstraction.

Determinism is the point: `@blerb/core` given the same (seed, dt sequence, world, events) produces byte-identical `PetState`. Time arrives as `dt`; randomness comes from the seeded mulberry32 in `PetState.rng`. That's what makes "the pet did something weird" reproducible instead of folklore.

---

## 5. Where the sim runs, and what crosses each boundary

| | Sim runs in | World sampled by | Rate |
|---|---|---|---|
| Electron | **main** | main (koffi window walk) | world ~3/s, sim fixed 60Hz substeps, parks when idle |
| petgen preview | the page | the page | RAF, parks when idle |

**`RenderFrame` never crosses a process boundary. `World`, `PetEvent` and `PetState` do.**

The sim lives in **main**, not in a renderer, because there is one pet and N overlay windows — one per display. Running it per-window would mean N independent pets. Main broadcasts `PetState` (~20 numbers) and each renderer calls `deriveFrame(pack, state)` to build its own `RenderFrame`, so the invariant holds and the windows can't disagree about where the pet is.

The renderers have **no render loop**. They paint on receipt of a state message, and main only sends one when the derived frame actually changes — so an idle pet costs the renderer processes nothing.

**Coordinates are global.** The sim works in one DIP space spanning every monitor; each overlay subtracts its own `display.bounds` origin when drawing. A pet straddling two screens is drawn by both windows and clipped naturally by each — which is what makes crossing seamless.

---

## 6. Pet pack format

`packages/pack/src/schema.ts` is the single source of truth. Types are `z.infer`'d from it; `petgen doctor` is `safeParse` plus the semantic checks in `resolve.ts`. Don't hand-write a `Pet` interface anywhere else.

A complete, working pet (`packs/blob/pet.json`, minus its `aliases` block):

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
  }
}
```

**That file is the format's canary.** It gets longer when the *pet* gains art — that's fine. If a **schema** change makes it longer or more complex, the change is wrong. Two animations is still a complete pet; the other two are aliased away in a sparse pack.

`pack.animation(name)` never throws and never returns undefined — it follows `aliases`, then falls back. A sparse pack should look slightly wrong, not crash the render loop.

**Authoring `climb`/`cling` cells:** draw them **sideways**, not upright. On a wall the renderer rotates the sprite ±90° about its anchor, so in cell space the *bottom edge is the wall* and *+x is the direction of travel along it*. A climb pose is therefore a creature hugging the ground and reaching to its right. Two consequences that are easy to get wrong: the eyes must be stacked in cell-**y** (that becomes screen-x, so they read as a face looking out at you) rather than spread in cell-x (which reads as one eye above the other); and limbs must overlap the body ellipse, because the body tapers toward its ends and a hand placed past the taper renders as a detached blob.

---

## 7. petgen

| Command | Status |
|---|---|
| `preview <packDir>` | Phase 0 — built |
| `from-sheet`, `from-frames`, `from-gif`, `doctor` | Phase 3 — built |
| `from-image` (procedural gait rig) | Phase 4 — built |

petgen is also a **library** (`src/index.ts`, exported via package.json `exports`): the desktop app's GUI importer (`apps/desktop/src/main/importer.ts`) and the pokemon batch script (`packages/petgen/scripts/import-vscode-pokemon.mts`) call `fromGif`/`fromImage` directly. `preview` is deliberately not exported there — it drags in vite. `fromGif` takes `animNames` (parallel to `inputs`, for files not named after their animations), `speeds` (per-animation designSpeed) and `aliases`; the CLI spells those `--speed walk=27` and `--alias climb=walk`.

**Packs with only walk+idle still climb**: alias `climb`→`walk` and `hang`→`walk` and the renderer's ±90° rotation makes a side-view walk read as scaling the wall, Shimeji-style. `cling` is left to the idle fallback on purpose — a walk loop on a *stationary* pet treadmills. The batch importer and the GUI importer both apply this automatically; the missing-animation fallback alone would give you a front-facing idle rotated sideways instead.

**from-gif treats every file as its own art source.** Backdrop removal and the pixel-art verdict run PER FILE, not over the stacked frames — because one import can legitimately mix a 26px pixel-art walk with a 900px hand-drawn flourish, and stacked detection would call the pixel art smooth. The one thing decided ACROSS files is the upscale factor of the pixel-art ones (they were drawn at one scale; a per-file GCD can be a two-frame coincidence, and one file downscaled 2× beside its siblings is a pet half the size of itself). The consequences:

- An opaque GIF (the normal downloaded kind — flattened onto white) gets the same 4-corner flood fill as from-image, per frame — but the backdrop colours are sampled ONCE per file (`sharedBackdrop`: the modal corner colour across frames), because a frame with a foot in a corner would otherwise sample the character as its backdrop and flood it away. Found because `test/blerb-jump.gif` imported as a 914×1080 solid rectangle.
- **A hard cut restores the binary-alpha vote.** The flood fill reports `hardCut` (every removed pixel within 0.02 of the backdrop — no anti-aliased fringe) and the detector takes it as `hardEdge`. Without this, NATIVE-resolution pixel art on a flattened backdrop could never vote pixel art (synthetic alpha suppressed, run GCD 1 by definition) and got eroded and bilinear-smoothed — subtly wrong, where before it was obviously wrong. `--pixel-art` / `--smooth` override the verdict for the cases every heuristic misses.
- A "smooth" file within 2× of the pixel art's height is left alone with a warning rather than resampled: it is far more likely a misclassified sibling (>64 colours) than a painting, and Lanczos at a factor near 1.0 turns a hard outline into a halo.
- **One atlas, one scale.** Pixel art is always native. Smooth art beside pixel art is *resampled down* to the pixel art's content height (or `--height <px>`), because the atlas builder pads every cell to the biggest content and a 900px cell around a 26px sprite is not a pet. Smooth art alone stays full-res with `atlas.scale` (the from-image rule). `pixelArt` on the pack is the group majority, ties to pixel — the smooth files have just been brought to its size.
- Resampling is `resampleRaster` in io.ts (sharp, lanczos, alpha-aware); it is the one image op besides decode/encode that touches sharp, and it stays there.

**`add-anim` appends an animation to an existing pack** (`commands/addAnim.ts`; the GUI's "Add art to this pet" and the CLI are the same function). Existing cells are lifted out of the atlas as aligned frames — the union of their content boxes, the grid's default anchor — and laid out again around that anchor ahead of the new frames, so their indices and the existing animations' frame lists are untouched (tested: every old cell's content is byte-identical and sits at the same anchor-relative position; the cell size is fixed from the second add-anim on — the FIRST re-layout may settle a pixel smaller per side, because a fresh import pads a fractional derived anchor with `ceil` while the re-layout has the integer one it was actually placed with, and that is the only time it can change). The pet's height for matching new art is the tallest single frame, never the union across frames — a walk's bob makes the union taller than any pose. Even grid widths only: an odd width puts the default anchor on a half pixel that an even rebuilt cell cannot reproduce, so it is refused rather than re-quantised. The new file goes through `importGifGroups` + `fitSmoothGroups` from fromGif.ts and is brought to the pack's own content height — a pixel pack shrinks smooth art only (from-gif's rules), a smooth pack matches in both directions, because its scale is fixed by `atlas.scale` and a smaller file would render as a speck. Pixel art added to a smooth pack stays native with a warning that reaches the GUI status line (`warn` option). Grid packs without hand-authored `cells` only — which is every pack the importers write. **The write is atomic by versioning the atlas**: the new atlas lands under a new name (`atlas-N.png`), then `pet.json` is replaced by rename, then the old atlas is deleted — every intermediate state is a consistent pair, which two overwrites in a row could never be. Nothing may hard-code `atlas.png` (trayIcon reads `manifest.atlas.src`). In the installed app a bundled pack is copied to the user root first (`writablePackDir`) and shadows the bundled copy from then on; overlays reload the same dir via `OverlayInit.artRev`. Adding a drawn `walk` to a from-image pack works: the procedural walk deformation in gait.ts is gated on `!pack.has('walk')`, so real frames play undeformed while breathing and the land squash stay.

**`interact` answers a touch** (`core/src/sim.ts`, `PetEvent.hover`, `PetState.hovered` + `hoverArmed`). The signal is main's cursor hit-test — the same box that makes the overlay clickable, never a DOM event (§2) — reported by `reportHover` on every poll with a two-poll (~66ms) **dwell** before "on" (a deliberate touch always passes; a flick across the pet at >1000px/s does not) and "off" at once, plus **hysteresis** on the box (exit pad = entry pad + 25% of the box height: a rigged sprite's box breathes and snaps on every ease reset, and a resting cursor at the fringe toggled hover several times a second — with touch semantics that would be a stream of re-touches). A drag reports off immediately; `swapPet` re-reports the current state into the rebuilt sim; `BLERB_DEBUG` logs `[hover] on/off`. The sim's model is a TOUCH, not a hold: the on-edge arms one answer (`hoverArmed`); if the pet is standing (not falling, climbing or hanging — the sprite is rotated there) it plays `interact` for **4–6s exactly** (set after `setBehavior`, not the restlessness-scaled roll) and then goes back to its business whether the cursor stayed or left; a touch that arrives mid-air is answered on landing (`pickBehavior` checks first) if the cursor is still there, and dropped on the off-edge otherwise; a resting cursor is one touch, and only leave-and-return starts another. `serialize()` writes `interact` as `idle` — the driver is never persisted, so the behaviour must not be either. Contract: it is the user's own action answered — never initiated (rule 6), never rewarded (rule 1), and a pet that is never hovered has exactly the trajectory of one with no interact art (rule 7, tested by state equality over a long run). Tests pin the 4–6s window, the linger past un-hover, no self-restart under a resting cursor, re-touch, the mid-air case, and `animT` never decreasing inside a bout.

**`activity` is how much the pet moves, and it is the user's knob, not a rule** (`behavior.activity` in the schema, default 0.7; the desktop's Activity slider writes it through to the live pack like the climb/hang toggles). It is the share of the pet's *ground* time spent walking — a share of TIME, not of decisions: `walkWeightFor` in `sim.ts` derives the per-decision walk weight from it against the stationary `idleWeights` and each behaviour's expected bout length (renewal–reward: w = a/(1−a) · S/E[walk]), so a pack whose stationary time is 25s naps still walks 70% of the clock (tested). `idleWeights.walk` is ignored — one knob. 0 never walks on its own (it still climbs down, answers a touch, and falls); 1 never stops. On a real desktop with climbing on, wall and ceiling time is not the ground picker's to decide, so "walk" measures ~50% at 0.7 while "moving" (walk + climb + hang + fall) measures ~70–80%, which is what the user sees. **The old fixed motion budget is gone**: the sim used to take walking off the menu above a 30s moving EMA of 0.3 ("stationary ≥70%", the plan's rule 4 before the contract was renumbered). Reversed to 70% moving by request, and the cap removed outright rather than re-based, because a cap only fights the dice — the sleepy-pack case never reached its share with one. `motionEma` survives as the preview HUD's diagnostic and nothing decides on it. A pack that zeroes every stationary weight is given a unit `idle` to stand against, so the knob never collapses into always-walk. **The default `surprise` rate is a share of time too** (`SURPRISE_SHARE`, 1.2% ≈ a bout every 8 minutes), derived against everything else's weight-mass, precisely so the cadence does not move with the slider — as a fixed weight it competed only in stationary decisions, and 70% walking silently pushed it from ~8 to ~20 minutes apart. At activity 1 there are no surprises: never stops means never stops. Raising the default also surfaced a real bug: a pet that let go at the very end of a ceiling kept its hanging speed and drifted through the side wall of the window it was pinned in. Letting go is now a straight drop (`letGo`, on every release: the timed one, the ceiling's end, and the ceiling vanishing or sliding away under `reconcileWorld`), and `stepFall` stops at any wall whose span the step crosses — checked over the whole step, not the end point, because the tick that passes a terrarium's floor line ends below the wall's foot while its sideways part was slipping out through the bottom corner; and a fall that starts ON the line (the check's own doing) may not move to the far side. Each case has a direct test; the terrarium test had been passing on dice.

**`surprise` is an optional animation slot and a sim behaviour** (`core/src/sim.ts`, `types.ts`, `KNOWN_ANIMATIONS`). A pack that ships one gets it picked at a default RATE of 1.2% of ground time — one ~6s bout every eight minutes or so at any activity setting (wall and ceiling time dilutes it a little on a real desktop), derived per decision like walking (`SURPRISE_SHARE`); an explicit `idleWeights.surprise` overrides that as a plain weight among the stationary ones — for [4000, 6000]ms × the restlessness scale, standing still, upright only. A pack without one never enters the behaviour: the filter is `pack.has('surprise')` — real art, or an alias chain that reaches real art, the same reachability `doctor` reports — never the idle fallback, because five seconds of the idle frame is not a surprise. Rule 5: nothing counts it, collects it, or announces it — pinned by a test that the `PetState` key set is unchanged after many bouts. Rule 6: randomised, never scheduled — pinned by a distribution test on the gaps between bouts (§12 style: wide spread, no lag-1 autocorrelation). The default rate is pinned across seeds inside a band around 1.2% of time, at activity 0.3 and 0.7 alike.

**Documented input requirements for imported art** (`docs/pet-art.md`, and `doctor` warnings): PNG with alpha · one character, no scene, no baked drop-shadow · facing right · feet at the bottom, uncropped · ≥2px transparent margin · 64–512px tall · pixel art at **native** resolution, not upscaled.

**The one rule the importers are built around: frames off one canvas are REGISTERED, and registration is the animation.** The bob of a walk cycle exists as where each frame was drawn, so all frames of a group are trimmed with ONE union box and share ONE anchor derived from their max-alpha composite. Per-frame tight-trimming — the obvious implementation, and what people do by hand — silently turns every walk cycle into a statue. `layout.test.ts` has a test named "preserves the bob" that exists to keep this true.

Cell geometry is chosen so the schema's DEFAULT grid anchor `[w/2, h-1]` lands exactly on the derived anchor (content is placed around the anchor, symmetric in x, contact row as the last row). That is why an imported pet.json contains no `cells` block — and it must stay that way; an importer that starts writing explicit cells is hiding a layout bug.

Everything pixel-pure lives in `src/import/` (raster, layout, pixelart, spec) and is tested on hand-built ten-pixel images; `io.ts` is the only file that touches sharp or the disk. Pixel-art/upscale detection (`detectForImport`) runs over ALL frames stacked, never one frame — one blocky frame can have all-even run lengths by pure coincidence (a 2px bar at native res is pixel-identical to a 1px bar at 2×; the ambiguity is inherent), and a detected "native" size under 8px means the sprite was just small, not upscaled. Both guards exist because tests caught the failures.

GIF/WebP import: fps from the modal frame delay; byte-identical consecutive frames are stored once and replayed by index (sharp's own webp encoder does this merge at encode time too, which is why the dedup is unit-tested against `collapseDuplicates` rather than end-to-end through an encoder). **Variable frame timing survives as repeated indices** — a 150ms hold at a 50ms base tick plays its frame three times. Found by importing real Gen-5 battle sprites, which hold key poses 2–3 ticks; flattening them to the modal rate visibly rushed every held pose. APNG is *not* importable (libvips reads PNG single-frame); the CLI says so instead of silently importing one frame.

`from-image` uses **procedural motion, not AI** — squash/stretch about the ground anchor, double-bounce bob, a 4° lean into travel. AI frame generation is rejected: its failure mode is a character that visibly flickers into a *different character* eight times a second.

The gait lives in `packages/core/src/gait.ts` as a pure deformation applied inside `deriveFrame` whenever `pack.rig` exists, so every host gets it with zero renderer changes — the renderers already multiply `squash` into their transform. Facts a future session needs:

- **Phase comes from `odometer`, not time.** Two footfalls per stride, feet locked to distance travelled; stopping freezes the pose instead of treadmilling. Squash is volume-preserving (`sx = 1/sy`) about the anchor, and lands **at contact** — the first cut had `1 + squash·cos2θ`, which is tallest at footfall, i.e. a trampoline; the sign is `1 − squash·cos2θ` and a test pins the direction. Every branch eases in over 150ms via `behaviorT`; the walk-exit snap is the one accepted discontinuity (fixing it needs the previous behavior in state).
- **The desktop frame-identity key includes `squash.sy` quantized to 0.01** (`apps/desktop/src/main/pet.ts`). Without it, squash-only changes never broadcast — a rigged pet stayed drawn mid-land-pulse at 75% height through a whole sleep, and breathing never rendered. Raw sy would be the opposite failure: the sine changes every tick and pins the parked loop at 60Hz. Quantized, breathing broadcasts a few times a second and the loop parks in between. `resolvePack` guarantees every rig has a `walk` gait (synthesized from the schema's own defaults), so core has no hand-copied fallback table to drift; amplitude caps in the schema (`squash ≤ 0.5`, `breatheAmp ≤ 0.2`) plus a clamp in `applyGait` keep `sx = 1/sy` finite for every parseable pack.
- **All amplitudes use DISPLAYED height, `cell.h / atlasScale`.** Hi-res art (official artwork, photos) ships full-resolution with `atlas.scale` set so it renders ~64px; from-image sets it for smooth art over 128px rather than resampling, so the pixels are still there when the user turns pet size up. The gait bobbing by file pixels made a 400px painting leap 24px per step.
- **Walk deformation is upright-only** (`climbingOn`/`hangingOn` null); on a wall the sprite is already rotated and only breathing survives. Sleep breathes at 2× amplitude, 0.4× rate.
- **Background removal is a 4-corner flood fill, not a chroma key** (`import/bgremove.ts`): only edge-connected backdrop is removed, so a white character on white keeps its interior whites — eye highlights, belly. The 1px alpha erode runs only on smooth art; it would blur a pixel-art outline. A borderless character eats itself, which from-image turns into a hard error rather than an empty pet — that is why the art docs demand a ≥2px margin.

---

## 8. What the app observes — and what it deliberately does not

**Two signals. That's all.**

- Foreground process basename (`GetForegroundWindow` + `GetWindowThreadProcessId`), already polled at 300ms for the platform physics.
- Coarse idle (`GetLastInputInfo`), one threshold, default 60s. No hook, no keystroke content, no rate analysis.

Phase 5 built the observation half: `@blerb/game` is a pure reducer over `{t, app, idleMs}` samples (`packages/game/src/session.ts`). A session = a focus-bucket foreground stretch; it ends on a **sustained ≥60s** switch to another bucket, or an **idle gap ≥90s** — and idle *between* those thresholds at a focus app ends nothing, which is the deliberate answer to idle-signals-can't-tell-reading-from-absence: when in doubt, keep the session open. Sessions close retroactively at the moment focus was actually lost, taps under a minute vanish, and `GameState` holds **no app names at all** — buckets and numbers only, enforced by a test. The desktop adapter (`observer.ts`) samples 1/s, discards the process path inside `win32.foregroundApp`, and logs transitions under `BLERB_DEBUG`. Classification lists live in settings.json (`classification.focus` / `.elsewhere`, basenames; `elsewhere` ships empty) and are edited in the settings window, which also shows the last non-blerb foreground basename with a "+ focus" button — that name lives in the observer's memory only and never reaches state or disk.

**Persistence (Phase 7, built):** `%APPDATA%\blerb-desktop\game.json` is exactly a `GameState`, written once a minute, at quit, and on each overlay's `session-end` (OS shutdown/logoff — **Windows does not emit `before-quit` for that**, per Electron's own docs; `WM_ENDSESSION` reaches windows, not the app), pruned to `KEEP_DAYS` (90) by day key. `persist.ts` is the border check on the way back in: `hydrate` accepts only the known top-level shape and DROPS unknown keys and individual corrupt day/session records — one bad record must not erase ninety days. A file that fails the top-level check is set aside as `game.json.rejected` and logged, never silently overwritten by the next save. Resuming keeps the stale `prevT` on purpose — the first sample after a restart is a gap, and the gap rule already closes whatever session was open at the last input before the app stopped (tested). **Day keys are stepped on the local calendar** (`localDayKeyAgo`, `setDate`), never by subtracting 24h multiples: a DST day is 23 or 25 hours, and the subtraction repeats or skips a key across the transition.

**The retrospective (rule 2, built):** `summary.ts` — `retrospective(state, keys)` over host-supplied day keys (today, yesterday, the week; the package stays timezone-agnostic) and `describe()` to plain sentences. *"Focus today: 1h 52m across 3 sessions. Longest session: 52m — your longest this week."* Pull only: the settings window reads it when it comes to the front, never on a timer, so nothing ticks while you watch. `summary.test.ts` asserts the words: no XP/points/levels/streaks/"+n" (rules 1, 2, 4), an empty day is a fact not a shortfall (rule 3), no seconds anywhere. "Longest this week" is only claimed once the week has more than one day with focus in it.

**Not built:** the pet reacting to any of this, and breaks. The pet reflecting bucket or session state is deliberately the next step, not this one — the ledger should be watched for a few real days first.

**There is no focus, attention, or flow inference, and this was a deliberate cut.** Reasons, so a future session doesn't helpfully add it back:

- The best published detector (Züger et al., CHI 2018, developers, computer-interaction features) reaches **74.8%** accuracy. One in four judgements is wrong.
- There is **no peer-reviewed validation** of focus detection from idle-signal-only telemetry. It's unmapped, not solved.
- The characteristic failure is severe and backwards: idle signals can't distinguish "away" from "reading or thinking", so a naive detector fires hardest at the person quietly concentrating.
- **Flow is not detectable from telemetry at all.** A logs-based study concludes plainly that it isn't currently feasible.

If it ever returns: opt-in, labelled experimental, validated against real work first.

---

## 9. Claims this app does not make

Seductive, widely repeated, and false or contested. Each has burned someone already.

| Claim | Reality |
|---|---|
| 10s micro-rests → hippocampal replay at 20× → more repetitions → better learning | Traces to an AI-generated podcast summary, not a paper. Underlying work is **finger-tapping a 5-key sequence** at 10s/10s × 36. Das et al. 2025 *PNAS* (independent, 5 experiments, N=631) reproduced the gains and found **no performance difference at matched test** (p=0.76), gone within seconds — and the gains appear for **random, unlearnable sequences** too (d=1.04). The "20×" is temporal compression (1,038ms → ~50ms), not processing speed. |
| "23 minutes to recover from an interruption" | Appears in **no paper**. Traces to a 2006 Gallup interview. The paper usually cited (Mark et al. CHI 2008) found interrupted people worked *faster*, at the cost of stress. |
| Pomodoro 25/5 is validated | Kitchen timer. Two RCTs found **no task-completion difference**; one found Pomodoro had *faster* fatigue rise than self-regulated breaks. |
| 52/17 is validated | DeskTime blog, selected on the dependent variable, no N. Their own reruns gave 52 → 80 → **112**. |
| 90-minute ultradian work blocks | Extrapolated from sleep architecture. Monk et al. looked for a 1.5h cognitive rhythm and didn't find one. Its phase is unobservable to an app anyway. |
| 20-20-20 | Optometrist's memorable heuristic. The direct RCT (N=30) was **null** on symptoms, reading speed, and accuracy. |
| Breaks improve performance on cognitive work | Albulescu 2022 (N=2,335): performance d=.16 **n.s.**, and split by task type **cognitive d=−0.09**. Programming is cognitive. |

**Breaks are for fatigue and vigor** (d≈.35, robust, replicated even by the critics of everything above). That's the claim, and it's enough. Don't dress it up.

---

## 10. The desktop as a shape

Multi-monitor is not "several worlds", it is **one world with holes in it**.

`World.bounds` is the union of every display and is *not* walkable — two screens of different heights leave dead space inside that box. `World.regions` is the real screens; the pet must always be inside one. `scanner.ts` derives everything else from that list with one rule:

- a screen's **whole bottom edge is ground**, at `floorY` (the taskbar's top), split where another screen lies directly below: the covered stretch is a `seam:` platform (`passthrough: true`), the rest is `floor:` (`passthrough: false`). Same `y`, so they read as one continuous line.
- a **wall** exists along a screen's side edge only where no screen sits alongside at that height (so the pet walks across the seam where they touch), and it **stops at `floorY`**, not at the screen's bottom pixel — a wall running past the ground let a descending pet slide in behind the taskbar.

`buildDesktopGeometry` lives in **`@blerb/core`**, not in the scanner, so it can be tested against real monitor layouts without an `electron` import. That is not tidiness: while it lived in the app, the sim tests hand-wrote `World`s and quietly omitted walls the real scanner emits, and two of them certified a descent route that does not exist on actual hardware. If a test needs a desktop, it declares screens and derives the rest.

**The seam used to be a hole** — no platform at all, on the theory that the pet should fall through onto the screen beneath. In use that reads as broken: put the pet on your big monitor and it drops out of sight to the bottom of the laptop.

**But making it solid trapped the pet on the upper screen** — 0/12 autonomous runs came back down, against 6/6 before, while ascent stayed 6/6. A one-way trip. A seam never has a walk-off end: each end is either more ground at the same `y`, or the screen's own side edge, which always carries a wall. So `passthrough` — until then dead data nothing read — now means something: **a pet standing on a seam has a small chance per behaviour decision of slipping through it** (`SEAM_DROP`, 3%, roughly a couple of minutes). That is the only way off an upper monitor, and it is why the flag exists. Window ledges are passthrough too but are excluded: they already have ends over open air, and stealing the pet off your title bar every two minutes is not charm.

Two supporting rules, both of which the trapped-pet bug hid behind:

- **A wall does not block a pet level with its top.** `wallAhead` tests `y < w.y0 + EPS`, not `y0 - EPS`. A lower screen's side wall begins exactly on the upper screen's ground line, and with the inclusive test it fenced the pet off from half of its own bottom edge.
- **Running out of platform is only a cliff if nothing continues at the same height.** A screen's ground is several platforms (floor either side of a seam); `adjoining()` hands the pet over. Without it the join read as a ledge edge and reflected the pet ~85% of the time — an invisible wall in the middle of the taskbar.

**`regionAt` slop is load-bearing in one direction only.** It allows `EPS` (1.5px) so a pet can stand exactly on a boundary — but a pet stepping off the end of a seam is a fraction of a pixel *into* its neighbour, and the slop matched the screen it had just left. `stepFall` then stopped it on that screen's floor line, in mid-air above the screen below, where it walked around on nothing. So `stepFall` passes `eps = 0`. Anywhere the answer decides where the pet **falls**, use zero slop; anywhere it decides whether the pet is **standing**, use `EPS`.

Two screens rarely line up exactly. When the pet climbs to the top of a wall it checks for a **mantle target** — a platform within 96px above the lip — and hauls itself up. That is what gets it from a laptop onto an external monitor sitting above and offset sideways; without it the pet reaches the corner and is stuck.

**Ceilings are a third surface type, and a separate `World.ceilings` list — not a flag on `Platform`.** Half a dozen places ask "what is under the pet" (`platformUnder`, `lowestPlatformAt`, `stepFall`'s landing loop, `adjoining`, `mantleTarget`, `settleOntoGround`) and every one of them would have needed to remember to exclude undersides. Forgetting one gives you a pet that falls upwards.

Where they come from:

- **every screen's top edge**, minus any screen directly above — the mirror of the ground rule.
- **every window's top edge**, from below, **clipped by anything above it in z-order**. Without that culling the pet stands on and hangs from the edges of windows buried behind whatever you are actually looking at — a line that is not on screen. The z-order walk already gives topmost-first, so each window's top edge is cut by the x-spans of every window already seen that covers its y. A window too narrow to carry a pet still counts as an occluder.
  This is the surface that always works: a maximized window has *no room above* its top edge, so the pet standing there would be entirely off-screen, but there is always room to hang underneath. That is why `scanWindows` no longer filters out `WS_MAXIMIZE` (Shimeji does) and why the scanner's ledge test is stricter than its ceiling test — `MIN_LEDGE_Y` (72px of clearance above) versus `MIN_HANG_ROOM` (40px of window below). They are not duplicates.

The pet reaches a ceiling by being dropped under one, or by climbing a wall whose top meets one — climb to the top of the screen and it carries on upside down across it.

**Surfaces that belong to a window carry `ownerX`, and that is how the pet rides one being dragged.** Following `y` alone was enough while windows only moved up and down in tests: the surface *is* the window's edge, so its `y` is the window's `y`. Sideways there is nothing to follow, because `x0`/`x1` are the *visible* span and shift whenever a neighbouring window changes what it covers — carrying the pet by that would slide it across the screen when nothing moved. `ownerX` is the unclipped origin, so the difference between two scans is the window's actual travel. `reconcileWorld` applies it for both platforms and ceilings; walls need nothing, since a climbing pet is pinned to `w.x` already.

**The scan rate is adaptive, and that is what makes riding a window read as riding rather than teleporting.** The pet can only follow a window as often as the desktop is sampled, so at the resting 300ms a drag moved it in ~150px jumps three times a second — correct, and visibly awful. The scanner drops to `MOVING_MS` (8ms) the moment a window it *already knew about* changes position or size, and holds that for `SETTLE_MS` (400ms) after the last movement. Both details matter: windows appearing or vanishing deliberately don't count, because that is a one-off the resting scan handles fine and only a drag produces motion to follow; and the settle delay exists because a real drag has pauses in it, so dropping straight back to 300ms costs a visible lurch every time the mouse resumes.

Measured on the dev machine, dragging a window at a real 60Hz: **3 follow-steps/s of ~150px each → 32/s of ~10px each** (mean; median 10px, max 54px). One scan costs 0.155ms mean / 0.28ms p95, plus 0.019ms to broadcast the result, so scanning flat out is ~0.8% of one core — and zero the rest of the time, because nothing is moving. That is why `smoothTracking` defaults on.

Don't bother chasing the interval lower. Node's timer on Windows quantises to ~15.6ms, so a request of 16ms actually yielded 37 world emissions/s and 8ms yields 44; the floor is the timer, not the work.

**A window is a place, not just an edge.** Its *bottom* edge is a floor too, so a pet dropped into a floating window settles inside it rather than falling through to the taskbar. That floor's ends hang over open air, so the pet wanders out again in its own time — soft containment, consistent with every other ledge.

**Terrarium mode shuts the pet in, and needs no sim support at all.** Right-click the pet → *Keep in this window* asks the scanner to emit walls down that one window's sides. Floor, two walls and a ceiling is a closed box, and a pet that cannot walk past a wall cannot leave one. The scanner owns the pin (`setTerrarium` / `terrarium()`) because it is the only thing that knows when the window has closed; main asks rather than keeping a copy, or the two drift apart the moment a window shuts. Carrying the pet out by hand clears it.

One escape route had to be closed for that to hold: letting go at the **end** of a ceiling used to drop the pet a pixel *past* the end, which is exactly where the wall stops — it fell straight through the corner. `stepHang` now releases at the end, not beyond it.

**`facing` means the direction of travel in world space, and the sprite mirror is derived in `deriveFrame` — never stored.** A half-turn flips the sprite's x axis, so a pet travelling right while hanging needs the *opposite* mirror to one travelling right on the ground. Storing the mirror and calling it `facing` is what produced the upside-down climb on left-hand walls; the same trap, one rotation further round.

**The click-through hit box must come from the render transform, not from the cell.** `frameBounds` in `@blerb/render-canvas` walks the cell's four corners through translate → rotate → scale — the same order `draw` uses, `atlasScale` included. Deriving the box from `cell.anchor` alone assumes the sprite sits above its anchor, which is only true upright: a hanging pet's box landed a whole sprite-height *above* where it was drawn, so the pet could not be picked up, and a climbing one's sat off to the side. The renderer's dirty rect calls the same function, so the two cannot drift apart.

**A falling pet needs horizontal containment.** Stepping off the end of a surface carries the walking speed with it, and at a screen's *outer* edge — the end of the top-of-screen ceiling, say — that sideways drift is enough to sail off the side of the world. The pet then lands on the world floor beyond the screen, below the side wall's reach, and never comes back. `stepFall` clamps x into the nearest region and kills `vx` when a step would leave every screen. Measured: 2/8 seeds escaped without it.

**Dropping the pet by hand can attach it to a wall or a ceiling.** `place` looks for a ceiling or wall within `SURFACE_GRAB` (24px) of the drop point and sticks to it, because the pet can't be aimed at either any other way — it only reaches them mid-wander. A ceiling beats a wall: dropping the pet just under a title bar is aiming at the title bar, even in a corner. Ground wins ties: near a screen's bottom corner *every* drop is within grabbing distance of the side wall, so a wall only beats the floor when the drop is more than `SURFACE_GRAB` above the ground. Silently pasting the pet to the edge when the user aimed at the taskbar is the worse failure.

Walls carry a `side` (the direction from wall to pet). Climbing rotates the sprite by `side * π/2` about its anchor so its feet meet the surface, and sets `facing = side * climbDir` so it goes head-first. **Both terms are needed.** The rotation's handedness flips with the wall, so which mirror means "head up" flips with it too — `facing = -climbDir` looks correct on a right-hand wall and renders the pet upside down on a left-hand one. Invisible while `climb` was aliased to `walk` on a symmetric blob; obvious the moment the art has a head. Tested via `facing * sin(rotation)`, the direction the nose actually points, rather than via `facing` alone.

## 11. Coordinate systems

- **World px** = CSS px on the host surface. Origin top-left, **+y down**.
- **Position is always the pet's ground anchor (its feet)**, never its top-left. Every renderer transform is about this point — that's why squash-and-stretch reads as weight on the floor instead of the sprite sinking into it, and why `anchor` is mandatory in the pack format.
- The sim sees exactly one coordinate space and does not know what a monitor is. DIP ↔ physical-px conversion is the host adapter's job, done once, at the edge.

---

## 12. Testing

- `@blerb/core` / `@blerb/game`: deterministic given (seed, dt, world, events) → snapshot and property tests. `packages/core/src/sim.test.ts` is the model to follow.
- Design-contract rules that *can* be tested, **are** — no movement while hidden, no fast-forward across an absence, XP monotonicity. The activity share (a knob, not a rule) has its own statistical suite: measured share of time within a band of the setting, across seeds, including the long-nap pack that a naive weight gets wrong.
- `CanvasRenderer`: golden-frame PNG comparison via `@napi-rs/canvas` (Phase 3+).
- The stochastic break scheduler gets **statistical** tests, not example tests: 10,000 simulated days asserting mean rate, gap bounds, daily cap, and near-zero autocorrelation between successive gaps. A naive "jitter around a fixed interval" implementation passes the first three and fails the last — which is the whole point of it.

---

## 13. IP

Every pack directory except `packs/blob/` is gitignored (allowlist: `packs/*/` + `!packs/blob/`) and **must never be committed or published**. The Pokémon Company explicitly asks people not to use their characters.

The shipped default is `packs/blob` — original art, CC0. The pack-import pipeline is what makes this clean: a Quagsire is something *you* import on your machine, not something the app distributes. That includes the batch importer (`pnpm pokemon`): it reads a clone the **user** makes — no network code — and writes into the gitignored packs root. The installer bundles `packs/blob` alone via an explicit `extraResources` entry; verify `resources/packs` after any packaging change.

---

## 14. Spike results and known unknowns

Measured 2026-08-05 on the dev machine: Win11, 1440×900 DIP @ 200% scale (2880×1800 physical), 24 cores, Electron 37.10.3, koffi 2.16.3.

**Spike A — transparent + GPU: PASS.** GPU acceleration on, no black first paint, no flicker over maximized windows in repeated full-screen captures. `BLERB_SOFTWARE=1` exists as a fallback but is **not needed** on this hardware. `disable-features=CalculateNativeWinOcclusion` **is** required — without it Windows decides a transparent always-on-top window is occluded whenever a maximized window sits under it, and freezes the renderer's RAF.

**Content protection: PASS, verified by A/B.** Identical captures with `captureProtection` off then on: pet present, then absent. `BLERB_ALLOW_CAPTURE=1` disables it for exactly this kind of automated check. *The other half — that the pet stays visible to the human while invisible to capture — is not machine-verifiable and needs eyes.*

**Window platform walk: PASS, to the pixel.** A test window placed at physical `500,700 1200×700` produced a ledge at DIP `y=350, x=256..845`. Predicted `y=350, x=250..850`. The ~6px horizontal inset is exactly Windows' invisible resize border — i.e. `DWMWA_EXTENDED_FRAME_BOUNDS` correctly reporting the *visible* frame where `GetWindowRect` would have been wrong. Top edge matches exactly (no invisible border on top). DPI conversion is correct.

**Spike B — selective click-through: PASS, verified by a human at a real mouse.** Implemented per plan: main-process `screen.getCursorScreenPoint()` poll at 30Hz as source of truth, plus a drag latch so the window stays interactive while the cursor leaves the stale bbox mid-drag.

The test that mattered: **Task Manager opened, clicked to give it focus, then the pet clicked and dragged.** The pet followed the cursor and resumed wandering on release. This is the case [electron#33281](https://github.com/electron/electron/issues/33281) (WONTFIX) breaks — with `setIgnoreMouseEvents(…, {forward:true})`, DOM `mousemove` stops being delivered entirely once Task Manager has focus. Polling the cursor in **main** sidesteps it, because main never depended on the renderer being told anything.

**So the tray-only fallback is dead — delete it from your mental model.** Do not reintroduce DOM `mousemove` for the hit test; it is the thing that was specifically shown not to work, and the failure only appears with a privileged window focused, which is exactly the case nobody tests.

Still unverified by eye: that the pet stays visible to the human while absent from a live Zoom/Teams share. The A/B capture test passed, but a real share has not been run.

**Multi-monitor + climbing: PASS, on real mixed-DPI hardware.** Dev machine layout: laptop `0,0 1440×900 @200%` and an external `233,-1080 1920×1080 @100%` — above and offset sideways, so their side edges do *not* line up.

The scanner derived exactly the right shape: the external's floor spans only `x=1440..2153` (the part not sitting above the laptop), so the region above the laptop is open air the pet falls through. Observed on the live desktop:

```
walk  on=floor:3080050583:0   @ 1430,852    laptop taskbar
climb on=wall:3080050583:r:0  @ 1440,852    grabbed the laptop's right edge
land  on=floor:2439861036:0   @ 1441,-48    mantled onto the external monitor
```

The mantle (§10) is what made that work — without it the pet climbs 900px to the laptop's top-right corner and is stuck 48px below the external monitor's floor. Screenshot confirmed the second overlay window renders the pet over Chrome on the external display.

**Performance.** Naive full-screen clear+repaint at 60fps cost **53.9% of one core** on one display. After frame-identity skipping, union dirty-rect clears, moving the sim to main, and parking when idle: **9.3% across two displays** (5 processes, ~516MB RSS) — split gpu 3.4%, main 3.4%, renderers 2.0% + 0.4%. The renderers are cheap now because they have no loop at all; they paint on receipt. That figure was measured under the old stationary-≥70% default; at activity 0.7 the pet is repainting at walking rate most of the time, so expect the walking-pet cost to be the typical one now (not re-measured).

The gpu-process floor looks inherent to compositing full-screen transparent always-on-top layers, and now scales with display count. A smaller overlay window that follows the pet would likely remove most of it.

**The world scan is far cheaper than it looks**, which is what licensed the adaptive rate in §10. Measured in-process over 400 iterations with 2 displays: the whole `tick()` is **0.155ms mean / 0.28ms p95**, of which the koffi z-order walk is 0.116ms; `buildDesktopGeometry` is 0.010ms and the change-signature `JSON.stringify` 0.003ms. Broadcasting the resulting `World` (838B) to both overlays costs another 0.019ms. So even at 60/s the scan is ~1% of one core, 0.04% of this 24-core box.

That per-scan number is worth trusting more than an end-to-end CPU sample: the app's own baseline (a walking pet repaints at 60fps) swings by ±3% of a core run to run, which is several times larger than the entire cost being measured. Two separate whole-process A/B attempts returned *negative* deltas from noise alone before the measurement was moved in-process.

**Still unknown:**
- Whether the procedural gait (Phase 4) looks acceptable on real Quagsire art. If it does, the pivot-point rig editor never gets built.
- Behaviour across sleep/wake and monitor hotplug *while the pet is mid-climb*. Handled in code (`reconcileWorld` re-settles, and a vanished wall drops the pet) and unit-tested, but not exercised on real hardware.
- Exclusive-fullscreen games (borderless is handled; true exclusive can't be drawn over by anything and the app hides).
- Whether a climbing pet on a *third* display, or displays arranged in an L, produces sensible walls. The geometry is general but only two-screen layouts have been observed.
