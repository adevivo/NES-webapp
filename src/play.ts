import "./style.css";
import { registerSW } from "virtual:pwa-register";
import { getGame, recordPlay } from "./db";
import { loadHomebrewCatalog } from "./roms";

// EmulatorJS is configured entirely through window.EJS_* globals read by loader.js.
// It is not designed to switch games in-page, so each game gets a fresh play.html load.
declare global {
  interface Window {
    [key: `EJS_${string}`]: unknown;
  }
}

const titleEl = document.getElementById("game-title")!;
const errorEl = document.getElementById("error")!;
const helpBtn = document.getElementById("help-btn")!;
const helpEl = document.getElementById("help")!;

helpBtn.addEventListener("click", () => {
  helpEl.hidden = !helpEl.hidden;
  helpBtn.setAttribute("aria-expanded", String(!helpEl.hidden));
});

registerSW({ immediate: true });

function fail(msg: string) {
  titleEl.textContent = "Can’t start game";
  errorEl.innerHTML = "";
  errorEl.append(msg, " ", Object.assign(document.createElement("a"), { href: "./", textContent: "Back to library" }));
  errorEl.hidden = false;
}

async function resolveGame(id: string): Promise<{ title: string; rom: File | string } | null> {
  if (id.startsWith("u-")) {
    const g = await getGame(id);
    return g ? { title: g.title, rom: new File([g.rom], g.fileName) } : null;
  }
  if (id.startsWith("hb-")) {
    const g = (await loadHomebrewCatalog()).find((x) => x.id === id);
    if (!g) return null;
    return { title: g.title, rom: new URL(`${import.meta.env.BASE_URL}homebrew/${g.file}`, location.href).href };
  }
  return null;
}

async function start() {
  const id = new URLSearchParams(location.search).get("id");
  if (!id) return fail("No game selected.");

  const game = await resolveGame(id);
  if (!game) return fail("That game isn’t in your library (it may have been removed, or was added in a different browser).");

  titleEl.textContent = game.title;
  document.title = `${game.title} — 8-Bit Shelf`;

  Object.assign(window, {
    EJS_player: "#game",
    EJS_core: "nes",
    EJS_pathtodata: `${import.meta.env.BASE_URL}emulatorjs/data/`,
    EJS_gameUrl: game.rom,
    // Save states, SRAM and per-game settings are keyed off this name, so it must be
    // stable: we use our id (content hash for user ROMs, manifest id for homebrew).
    EJS_gameName: id,
    EJS_color: "#d6453d",
    EJS_backgroundColor: "#000000",
    EJS_language: "en-US",
    EJS_disableAutoLang: false, // (sic) false = don't fetch a localization JSON
    EJS_Buttons: {
      netplay: false, // needs a signalling server we don't run
      exitEmulation: false, // we have our own "Library" link
    },
    EJS_onGameStart: () => {
      recordPlay(id).catch(() => {});
    },
  } satisfies Record<`EJS_${string}`, unknown>);

  const script = document.createElement("script");
  script.src = `${import.meta.env.BASE_URL}emulatorjs/data/loader.js`;
  script.onerror = () => fail("Emulator files are missing. Run `npm install` to copy them into public/emulatorjs.");
  document.body.append(script);
}

start().catch((e) => fail(String(e)));
