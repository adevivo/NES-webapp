# Bundled homebrew

Only put ROMs here whose license **explicitly allows redistribution** (e.g. MIT, GPL, CC-BY, CC0,
or a written "free to distribute" statement from the author). Keep a copy of the license text/link.

1. Copy the ROM into this folder, e.g. `public/homebrew/my-game.nes`.
2. Add an entry to `manifest.json`:

```json
[
  {
    "id": "hb-my-game",
    "title": "My Game",
    "author": "Author Name",
    "file": "my-game.nes",
    "license": "CC-BY-4.0",
    "url": "https://where-you-got-it.example",
    "description": "One-line blurb."
  }
]
```

- `id` must be unique and stable: in-browser save states are keyed by it. Prefix with `hb-`.
- Author + license are shown on the game card (most licenses require attribution).
