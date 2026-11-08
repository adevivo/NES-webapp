// Single-player JSNES page (works standalone and inside the Discord Activity).
import "./style.css";
import { deleteGame, getGame, getSaveState, getSram, listGames, putSaveState, putSram, recordPlay, type UserGame } from "./db";
import { KEY_HELP } from "./nes/input";
import { NesPlayer } from "./nes/player";
import { postJSON } from "./report";
import { formatBytes, importFiles, loadHomebrewCatalog } from "./roms";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const inDiscord = new URLSearchParams(location.search).has("frame_id");

const els = {
  back: $<HTMLAnchorElement>("back"),
  title: $("title"),
  toolbar: $("toolbar"),
  pick: $("pick"),
  stage: $("stage"),
  games: $("games"),
  file: $<HTMLInputElement>("file"),
  canvas: $<HTMLCanvasElement>("screen"),
  help: $("help"),
  toast: $("toast"),
  pause: $<HTMLButtonElement>("pause"),
  mute: $<HTMLButtonElement>("mute"),
  full: $<HTMLButtonElement>("full"),
};

els.back.href = inDiscord ? `activity.html${location.search}` : "./";
els.back.textContent = inDiscord ? "← Checks" : "← Library";
els.help.textContent = `${KEY_HELP} · gamepads work too · F5 save · F7 load`;
if (!document.fullscreenEnabled) els.full.hidden = true;

let toastTimer = 0;
function toast(msg: string, ms = 4000) {
  els.toast.textContent = msg;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (els.toast.hidden = true), ms);
}

// ---------- game list ----------

interface Entry {
  id: string;
  title: string;
  meta: string;
  load: () => Promise<Uint8Array>;
  removable: boolean;
}

async function entries(): Promise<Entry[]> {
  const mine = (await listGames())
    .filter((g) => g.fileName.toLowerCase().endsWith(".nes"))
    .sort((a, b) => b.addedAt - a.addedAt)
    .map<Entry>((g: UserGame) => ({
      id: g.id,
      title: g.title,
      meta: formatBytes(g.size),
      removable: true,
      load: async () => new Uint8Array(await ((await getGame(g.id))?.rom ?? g.rom).arrayBuffer()),
    }));
  const hb = (await loadHomebrewCatalog()).map<Entry>((g) => ({
    id: g.id,
    title: g.title,
    meta: `homebrew · ${g.license}`,
    removable: false,
    load: async () => new Uint8Array(await (await fetch(`${import.meta.env.BASE_URL}homebrew/${g.file}`)).arrayBuffer()),
  }));
  return [...mine, ...hb];
}

async function renderList() {
  const list = await entries();
  els.games.replaceChildren(
    ...list.map((e) => {
      const card = document.createElement("article");
      card.className = "card";
      const play = Object.assign(document.createElement("button"), { type: "button", className: "card-play card-play-btn" });
      play.append(Object.assign(document.createElement("span"), { className: "card-title", textContent: e.title }));
      play.addEventListener("click", () => start(e));
      const meta = Object.assign(document.createElement("div"), { className: "card-meta muted", textContent: e.meta });
      card.append(play, meta);
      if (e.removable) {
        const rm = Object.assign(document.createElement("button"), { type: "button", className: "card-remove", textContent: "Remove" });
        rm.setAttribute("aria-label", `Remove ${e.title}`);
        rm.addEventListener("click", async () => {
          if (!confirm(`Remove “${e.title}” from this device?`)) return;
          await deleteGame(e.id);
          renderList();
        });
        card.append(rm);
      }
      return card;
    }),
  );
}

els.file.addEventListener("change", async () => {
  const files = [...(els.file.files ?? [])];
  els.file.value = "";
  const nes = files.filter((f) => f.name.toLowerCase().endsWith(".nes"));
  const skipped = files.length - nes.length;
  const existing = new Set((await listGames()).map((g) => g.id));
  const res = await importFiles(nes, existing);
  const parts = [];
  if (res.added.length) parts.push(`added ${res.added.length}`);
  if (res.duplicates.length) parts.push(`${res.duplicates.length} already here`);
  if (skipped) parts.push(`${skipped} skipped (unzip to .nes first)`);
  for (const r of res.rejected) parts.push(`${r.name}: ${r.reason}`);
  toast(parts.join(" · ") || "nothing added");
  await renderList();
  if (res.added.length === 1) {
    const e = (await entries()).find((x) => x.id === res.added[0].id);
    if (e) start(e);
  }
});

// ---------- playing ----------

let player: NesPlayer | null = null;
let current: Entry | null = null;
let reportTimer = 0;

async function start(e: Entry) {
  stop();
  const p = new NesPlayer(els.canvas, { saveSram: (data) => putSram(e.id, data).catch(() => {}) });
  await p.init();
  try {
    p.load(await e.load(), await getSram(e.id).catch(() => undefined));
  } catch (err) {
    p.destroy();
    toast(String((err as Error).message), 8000);
    return;
  }
  player = p;
  current = e;
  els.title.textContent = e.title;
  els.pick.hidden = true;
  els.stage.hidden = false;
  els.toolbar.hidden = false;
  els.help.hidden = false;
  els.pause.textContent = "Pause";
  els.mute.textContent = p.muted ? "Unmute" : "Mute";
  p.start();
  els.canvas.focus();
  recordPlay(e.id).catch(() => {});
  reportTimer = window.setTimeout(() => report(), 20000);
}

function stop() {
  clearTimeout(reportTimer);
  player?.destroy();
  player = null;
  current = null;
}

function showList() {
  stop();
  els.title.textContent = "Pick a game";
  els.stage.hidden = true;
  els.toolbar.hidden = true;
  els.help.hidden = true;
  els.pick.hidden = false;
  renderList();
}

async function quickSave() {
  if (!player || !current) return;
  const s = player.saveState();
  await putSaveState(current.id, s.json);
  toast(`Saved (${formatBytes(s.bytes)}, ${s.ms.toFixed(1)} ms)`, 2000);
}

async function quickLoad() {
  if (!player || !current) return;
  const s = await getSaveState(current.id);
  if (!s) return toast("No save yet — press Save (F5) first", 2500);
  const r = player.loadState(s.json);
  toast(`Loaded save from ${new Date(s.savedAt).toLocaleTimeString()} (${r.ms.toFixed(1)} ms)`, 2000);
}

/** Performance report for the spike: frame cost, audio health and save-state cost (rollback feasibility). */
async function report() {
  if (!player || !current) return;
  const st = player.saveState();
  const ld = player.loadState(st.json);
  try {
    await postJSON("/api/report", {
      kind: "play",
      inDiscord,
      userAgent: navigator.userAgent,
      game: { idPrefix: current.id.slice(0, 10), mapper: player.mapper, homebrew: current.id.startsWith("hb-") },
      stats: player.stats(),
      saveState: { bytes: st.bytes, saveMs: Math.round(st.ms * 100) / 100, loadMs: Math.round(ld.ms * 100) / 100 },
    });
  } catch {
    /* best effort */
  }
}

$("pause").addEventListener("click", () => {
  if (!player) return;
  if (player.paused) player.start();
  else player.pause();
  els.pause.textContent = player.paused ? "Resume" : "Pause";
});
$("reset").addEventListener("click", () => player?.reset());
$("save").addEventListener("click", quickSave);
$("load").addEventListener("click", quickLoad);
$("mute").addEventListener("click", () => {
  if (!player) return;
  player.muted = !player.muted;
  els.mute.textContent = player.muted ? "Unmute" : "Mute";
});
els.full.addEventListener("click", () => {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else els.stage.requestFullscreen().catch((e) => toast(`Fullscreen blocked: ${e.message}`));
});
$("close").addEventListener("click", showList);

window.addEventListener("keydown", (e) => {
  if (e.key === "F5") {
    e.preventDefault();
    quickSave();
  } else if (e.key === "F7") {
    e.preventDefault();
    quickLoad();
  }
});
// Pause when hidden; flush battery RAM before the page goes away.
document.addEventListener("visibilitychange", () => {
  if (!player) return;
  if (document.hidden) player.pause();
  else if (els.pause.textContent === "Pause") player.start();
});
window.addEventListener("pagehide", () => player?.flushSram());

renderList();
