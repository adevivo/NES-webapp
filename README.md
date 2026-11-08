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

## Docker + Discord Activity (spike branch)

The app also runs as a Discord Activity, served by a small Node server (`server/server.mjs`)
in Docker and published through a **Cloudflare named tunnel** (`nes.neovetta.com`). No host
ports are opened.

```sh
cp .env.example .env    # then fill in DISCORD_CLIENT_SECRET and CLOUDFLARE_TUNNEL_TOKEN
docker compose --profile named up -d --build
docker compose logs app | grep diagnostics   # results reported by the in-Discord check page
```

- **Run the tunnel on exactly one machine at a time.** Two connectors using the same token
  silently split traffic between both machines.
- The Discord URL mapping (`/` → `nes.neovetta.com`) and the Cloudflare route
  (`nes.neovetta.com` → `http://app:3000`) don't mention a host, so moving machines needs no
  config changes.
- Inside Discord, `/` redirects to `nes.html`, the JSNES player (`src/nes/`): pick a `.nes`
  file (kept in IndexedDB on that device, never uploaded), keyboard/gamepad, sound, battery
  saves, quick save/load. Its "Checks" link opens `activity.html` (the feasibility checks).
  After 20 s of play it reports frame cost, audio underruns and save-state cost to the log.
- `scripts/make-test-rom.py` generates `public/homebrew/test-pattern.nes`, our own CC0 test cart:
  blue = idle, red = player 1 holding a button, green = player 2.

Server endpoints: `/healthz`, `GET /api/config` (client ID), `POST /api/token` (OAuth code →
access token; the secret never reaches the browser), `POST /api/report` (spike diagnostics),
and a WebSocket at `/ws` (spike: echo, for round-trip measurement).

## Upgrading EmulatorJS

Change both `@emulatorjs/*` versions in `package.json` together and run `npm install`. Then
check that `SCRIPTS` in `scripts/copy-emulator.mjs` still matches the list at the top of
`node_modules/@emulatorjs/emulatorjs/data/loader.js`.

## Licensing

EmulatorJS and the cores are GPL-3.0. Hosting the site publicly distributes them, so keep the
attribution and source link in the footer. Don't bundle commercial ROMs.
