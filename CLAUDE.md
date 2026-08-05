# blerb

A desktop screen pet that is also a productivity game. A sprite lives on top of everything on your Windows desktop, wanders around, stands on the edges of your real windows, and reacts to what you're doing.

Windows 11, Electron. One shared simulation core drives every surface.

The full reasoning behind every decision here lives in the plan at `~/.claude/plans/i-thinking-of-creating-precious-mochi.md`. This file is the operating summary.

---

## 1. How do I see a pet walk in 10 seconds

```bash
pnpm install && node packages/petgen/scripts/make-blob-atlas.mjs && pnpm preview
```

That opens a browser page with the pet walking around on a floor and some ledges. `d` toggles a debug overlay showing platform lines and the pet's ground anchor, `r` recenters, clicking calls the pet over.

**The real thing** — pet on the actual desktop, over every window:

```bash
pnpm desktop
```

Tray icon → settings, recenter, quit. Right-click the pet for the same menu. Drag the pet to drop it on a window ledge (it can't climb; being carried is how it gets up there).

Diagnostic env vars: `BLERB_DEBUG=1` logs each world scan (platform ids + coordinates), `BLERB_SOFTWARE=1` disables GPU compositing, `BLERB_ALLOW_CAPTURE=1` makes the pet visible to screen capture so it can be verified in a screenshot.

The preview aliases `@blerb/*` to their **sources**, so edits to the sim are live without a build step. This is the inner loop — use it.

```bash
pnpm test          # @blerb/core and @blerb/game determinism + contract tests
pnpm typecheck     # tsc --build across the workspace
pnpm lint          # includes the pure-packages rule, see §4
```

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

Rules 3, 4 and 7 are enforced by tests, not just documented. Keep it that way.

---

## 4. Monorepo map and import rules

```
packages/
  core/          @blerb/core          pet simulation. PURE.
  pack/          @blerb/pack          pet pack schema + loader
  render-canvas/ @blerb/render-canvas the ONLY renderer
  game/          @blerb/game          sessions, XP, classification. PURE.   [Phase 5+]
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
| Electron | renderer | main (koffi window walk) | world ~3/s, sim fixed 60Hz substeps, paint 60fps |
| petgen preview | the page | the page | same |

**`RenderFrame` never crosses a process boundary. `World` and `PetEvent` do.** That's why `World` is a flat, diffable ~1KB snapshot rather than a live object graph — it has to survive structured clone over IPC several times a second.

---

## 6. Pet pack format

`packages/pack/src/schema.ts` is the single source of truth. Types are `z.infer`'d from it; `petgen doctor` is `safeParse` plus the semantic checks in `resolve.ts`. Don't hand-write a `Pet` interface anywhere else.

A complete, working pet (`packs/blob/pet.json`):

```json
{
  "format": "blerb-pet/1",
  "id": "blob", "name": "Blob", "author": "blerb", "license": "CC0-1.0",
  "pixelArt": true,
  "atlas": { "src": "atlas.png" },
  "grid": { "w": 32, "h": 32, "cols": 4 },
  "animations": {
    "idle": { "fps": 2, "frames": [0, 1] },
    "walk": { "fps": 8, "frames": [2, 0, 3, 0], "designSpeed": 40 }
  }
}
```

**That file is the format's canary.** If a schema change makes it longer or more complex, the change is wrong.

`pack.animation(name)` never throws and never returns undefined — it follows `aliases`, then falls back. A sparse pack should look slightly wrong, not crash the render loop.

---

## 7. petgen

| Command | Status |
|---|---|
| `preview <packDir>` | Phase 0 — built |
| `from-sheet`, `from-frames`, `from-gif`, `doctor` | Phase 3 |
| `from-image` (procedural gait rig) | Phase 4 |

**Documented input requirements for imported art** (`docs/pet-art.md`, and `doctor` warnings): PNG with alpha · one character, no scene, no baked drop-shadow · facing right · feet at the bottom, uncropped · ≥2px transparent margin · 64–512px tall · pixel art at **native** resolution, not upscaled.

`from-image` uses **procedural motion, not AI** — squash/stretch about the ground anchor, double-bounce bob, a 4° lean into travel. AI frame generation is rejected: its failure mode is a character that visibly flickers into a *different character* eight times a second.

---

## 8. What the app observes — and what it deliberately does not

**Two signals. That's all.**

- Foreground process basename (`GetForegroundWindow` + `GetWindowThreadProcessId`), already polled at 300ms for the platform physics.
- Coarse idle (`GetLastInputInfo`), one threshold, default 60s. No hook, no keystroke content, no rate analysis.

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

## 10. Coordinate systems

- **World px** = CSS px on the host surface. Origin top-left, **+y down**.
- **Position is always the pet's ground anchor (its feet)**, never its top-left. Every renderer transform is about this point — that's why squash-and-stretch reads as weight on the floor instead of the sprite sinking into it, and why `anchor` is mandatory in the pack format.
- The sim sees exactly one coordinate space and does not know what a monitor is. DIP ↔ physical-px conversion is the host adapter's job, done once, at the edge.

---

## 11. Testing

- `@blerb/core` / `@blerb/game`: deterministic given (seed, dt, world, events) → snapshot and property tests. `packages/core/src/sim.test.ts` is the model to follow.
- Design-contract rules that *can* be tested, **are** — motion budget, no movement while hidden, no fast-forward across an absence, XP monotonicity.
- `CanvasRenderer`: golden-frame PNG comparison via `@napi-rs/canvas` (Phase 3+).
- The stochastic break scheduler gets **statistical** tests, not example tests: 10,000 simulated days asserting mean rate, gap bounds, daily cap, and near-zero autocorrelation between successive gaps. A naive "jitter around a fixed interval" implementation passes the first three and fails the last — which is the whole point of it.

---

## 12. IP

`packs/quagsire/` is gitignored and **must never be committed or published**. The Pokémon Company explicitly asks people not to use their characters.

The shipped default is `packs/blob` — original art, CC0. The pack-import pipeline is what makes this clean: a Quagsire is something *you* import on your machine, not something the app distributes.

---

## 13. Spike results and known unknowns

Measured 2026-08-05 on the dev machine: Win11, 1440×900 DIP @ 200% scale (2880×1800 physical), 24 cores, Electron 37.10.3, koffi 2.16.3.

**Spike A — transparent + GPU: PASS.** GPU acceleration on, no black first paint, no flicker over maximized windows in repeated full-screen captures. `BLERB_SOFTWARE=1` exists as a fallback but is **not needed** on this hardware. `disable-features=CalculateNativeWinOcclusion` **is** required — without it Windows decides a transparent always-on-top window is occluded whenever a maximized window sits under it, and freezes the renderer's RAF.

**Content protection: PASS, verified by A/B.** Identical captures with `captureProtection` off then on: pet present, then absent. `BLERB_ALLOW_CAPTURE=1` disables it for exactly this kind of automated check. *The other half — that the pet stays visible to the human while invisible to capture — is not machine-verifiable and needs eyes.*

**Window platform walk: PASS, to the pixel.** A test window placed at physical `500,700 1200×700` produced a ledge at DIP `y=350, x=256..845`. Predicted `y=350, x=250..850`. The ~6px horizontal inset is exactly Windows' invisible resize border — i.e. `DWMWA_EXTENDED_FRAME_BOUNDS` correctly reporting the *visible* frame where `GetWindowRect` would have been wrong. Top edge matches exactly (no invisible border on top). DPI conversion is correct.

**Spike B — selective click-through: PARTIAL, needs a human.** Implemented per plan: main-process `screen.getCursorScreenPoint()` poll at 30Hz as source of truth, plus a drag latch so the window stays interactive while the cursor leaves the stale bbox mid-drag. **Cannot be verified without driving a real mouse** — see the user checklist. The fallback if it proves unreliable is a fully click-through pet with tray-only interaction.

**Performance — acceptable, improvable.** Naive full-screen clear+repaint at 60fps cost **53.9% of one core**. Two fixes brought it to **11.7%** (≈0.5% of total CPU on 24 cores), ~420MB RSS across 4 processes:
  - skip frames whose `RenderFrame` is visually identical (the pet idles at 2fps and is stationary >70% of the time by design)
  - clear only the union of the pet's previous and current rects, not 5.2 megapixels
  - park the render loop entirely after ~1/3s idle, ticking the sim on a 100ms timer until something changes

  Remaining split: renderer 5.2%, gpu-process 4.5%, main 2.0%. The gpu-process floor looks inherent to compositing a full-screen transparent always-on-top layer. Worth another pass before v1 — a smaller overlay window that follows the pet would likely remove most of it.

**Still unknown:**
- Multi-monitor. The overlay is currently **primary display only** — `createOverlayWindow` takes a `Display` and the plan calls for one window per `display.id`, but only one is spawned. Untested on a second monitor, and mixed-DPI is untested.
- Whether the procedural gait (Phase 4) looks acceptable on real Quagsire art. If it does, the pivot-point rig editor never gets built.
- Behaviour across sleep/wake and display hotplug.
- Exclusive-fullscreen games (borderless is handled; true exclusive can't be drawn over by anything and the app hides).
