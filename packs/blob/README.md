# blob

The default pet. Original art, CC0-1.0 — public domain, do what you like with it.

`atlas.png` is generated, not hand-drawn:

```bash
node packages/petgen/scripts/make-blob-atlas.mjs
```

Two reasons this pack exists:

1. **It ships.** Third-party character art never gets committed to this repo (see `CLAUDE.md` § IP), so the app needs a default pet it actually owns. Importing a Quagsire is a thing *you* do on your machine, not something the app distributes.

2. **It's the format's canary.** `pet.json` here is twelve lines. If a change to the pack schema makes this file longer or more complicated, the change is wrong — the format is supposed to stay hand-writable.
