# 8-Bit Shelf

A browser NES player: a library of your own ROMs plus bundled homebrew, run with
[EmulatorJS](https://github.com/EmulatorJS/EmulatorJS) 4.2.3 and the FCEUmm core. It's a static
site and an installable PWA that works offline.

```sh
npm install      # also copies EmulatorJS + the NES core into public/emulatorjs/ (postinstall)
npm run dev      # http://localhost:5173
npm run build    # typecheck + production build to dist/
npm run preview  # serve dist/ (use this to test the service worker / offline)
```

## How it fits together

| Piece | Where | Notes |
|---|---|---|
| Library page | `index.html`, `src/library.ts` | Drag & drop or file picker, search, recently played first, remove. |
| Player page | `play.html`, `src/play.ts` | `play.html?id=<id>`. Sets `window.EJS_*` globals, then injects `loader.js`. EmulatorJS can't swap games inside a page, so each game is a fresh page load. |
| ROM storage | `src/db.ts` (IndexedDB `nes-library`) | ROMs are stored as Blobs. The ID is `u-` + the first 16 hex characters of the ROM's SHA-256, so importing the same ROM twice doesn't duplicate it, and renaming the file doesn't lose its saves. |
| Homebrew | `public/homebrew/` + `manifest.json` | IDs are `hb-…`. See `public/homebrew/README.md`. Only add ROMs whose license allows redistribution. |
| Emulator runtime | `public/emulatorjs/data/` (generated, gitignored) | Built by `scripts/copy-emulator.mjs`. |
| PWA | `vite.config.ts` (`vite-plugin-pwa`) | Precaches the app shell, the emulator and the NES core (~3.4 MB). Homebrew ROMs are cached the first time they're played. |

Save states, battery saves, keybindings and core options are handled by EmulatorJS, kept in its
own IndexedDB and localStorage, and keyed by `EJS_gameName` (our game ID).

## Non-obvious decisions

- **`overrides` → `stubs/emulatorjs-cores-stub`.** `@emulatorjs/emulatorjs` lists
  `@emulatorjs/cores` as an optional dependency, and that package pulls in ~48 emulator cores.
  We depend on `@emulatorjs/core-fceumm` directly and point the override at an empty stub.
  We can't use `--omit=optional` instead, because Vite's native binaries are optional
  dependencies too.
- **`emulator.min.js` is concatenated, not minified.** The npm package ships only source, but
  `loader.js` expects the minified bundle. Upstream builds it by concatenating the sources in
  loader order, which is what our copy script does. The alternative, `EJS_DEBUG_XX`, turns on
  verbose logging and an update check, and turns off core caching.
- **Threads are off.** We don't ship the threaded core builds. The NES doesn't need them, and
  they would require COOP/COEP headers. Any static host works.
- **Netplay is hidden.** It needs a signalling server, which we don't run.

## Upgrading EmulatorJS

Change both `@emulatorjs/*` versions in `package.json` together and run `npm install`. Then
check that `SCRIPTS` in `scripts/copy-emulator.mjs` still matches the list at the top of
`node_modules/@emulatorjs/emulatorjs/data/loader.js`.

## Licensing

EmulatorJS and the cores are GPL-3.0. Hosting the site publicly distributes them, so keep the
attribution and source link in the footer. Don't bundle commercial ROMs.
