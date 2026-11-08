import "./style.css";
import { registerSW } from "virtual:pwa-register";
import { deleteGame, listGames, listPlays, type PlayRecord, type UserGame } from "./db";
import { ACCEPT_ATTR, formatBytes, importFiles, loadHomebrewCatalog, type HomebrewGame } from "./roms";

// Inside a Discord Activity (Discord adds frame_id to the launch URL) go to the JSNES player,
// which is the part built for Discord. Its "Checks" link leads to the diagnostics page.
const inDiscord = new URLSearchParams(location.search).has("frame_id");
if (inDiscord) location.replace(`nes.html${location.search}`);

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const els = {
  mine: $<HTMLDivElement>("mine"),
  mineEmpty: $<HTMLDivElement>("mine-empty"),
  homebrew: $<HTMLDivElement>("homebrew"),
  homebrewEmpty: $<HTMLParagraphElement>("homebrew-empty"),
  fileInput: $<HTMLInputElement>("file-input"),
  search: $<HTMLInputElement>("search"),
  storage: $<HTMLSpanElement>("storage"),
  toast: $<HTMLDivElement>("toast"),
  overlay: $<HTMLDivElement>("drop-overlay"),
  offline: $<HTMLSpanElement>("offline-status"),
};

let userGames: UserGame[] = [];
let homebrew: HomebrewGame[] = [];
let plays = new Map<string, PlayRecord>();

els.fileInput.accept = ACCEPT_ATTR;

// ---------- rendering ----------

function playHref(id: string) {
  return `play.html?id=${encodeURIComponent(id)}`;
}

function relTime(ts: number) {
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} d ago`;
  return new Date(ts).toLocaleDateString();
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...kids: (Node | string)[]) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...kids);
  return node;
}

function card(opts: { id: string; title: string; meta: string[]; onRemove?: () => void }) {
  const play = el("a", { className: "card-play", href: playHref(opts.id) }, el("span", { className: "card-title" }, opts.title));
  const meta = el("div", { className: "card-meta muted" }, opts.meta.filter(Boolean).join(" · "));
  const c = el("article", { className: "card" }, play, meta);
  if (opts.onRemove) {
    const rm = el("button", { className: "card-remove", type: "button", title: `Remove ${opts.title}` }, "Remove");
    rm.setAttribute("aria-label", `Remove ${opts.title}`);
    rm.addEventListener("click", opts.onRemove);
    c.append(rm);
  }
  return c;
}

function matches(q: string, ...fields: (string | undefined)[]) {
  return !q || fields.some((f) => f?.toLowerCase().includes(q));
}

function render() {
  const q = els.search.value.trim().toLowerCase();
  const lastPlayed = (id: string) => plays.get(id)?.lastPlayedAt ?? 0;

  const mine = userGames
    .filter((g) => matches(q, g.title, g.fileName))
    .sort((a, b) => lastPlayed(b.id) - lastPlayed(a.id) || b.addedAt - a.addedAt);

  els.mine.replaceChildren(
    ...mine.map((g) => {
      const p = plays.get(g.id);
      return card({
        id: g.id,
        title: g.title,
        meta: [formatBytes(g.size), p ? `played ${relTime(p.lastPlayedAt)}` : "never played"],
        onRemove: () => removeGame(g),
      });
    }),
  );
  els.mineEmpty.hidden = userGames.length > 0;

  const hb = homebrew.filter((g) => matches(q, g.title, g.author, g.description));
  els.homebrew.replaceChildren(
    ...hb.map((g) => {
      const c = card({ id: g.id, title: g.title, meta: [g.author, g.license] });
      if (g.description) c.append(el("p", { className: "card-desc" }, g.description));
      if (g.url) c.append(el("a", { className: "card-link muted", href: g.url, target: "_blank", rel: "noopener" }, "source"));
      return c;
    }),
  );
  els.homebrewEmpty.hidden = homebrew.length > 0;
}

async function refresh() {
  [userGames, plays] = await Promise.all([listGames(), listPlays()]);
  render();
  updateStorage();
}

async function updateStorage() {
  if (!navigator.storage?.estimate) return;
  const { usage = 0, quota = 0 } = await navigator.storage.estimate();
  const persisted = (await navigator.storage.persisted?.()) ?? false;
  els.storage.textContent = `${formatBytes(usage)} used of ${formatBytes(quota)}${persisted ? " · persistent" : ""}`;
}

let toastTimer: number | undefined;
function toast(msg: string) {
  els.toast.textContent = msg;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (els.toast.hidden = true), 6000);
}

// ---------- actions ----------

async function addFiles(files: Iterable<File>) {
  const list = [...files];
  if (!list.length) return;
  // Ask the browser not to evict our IndexedDB under storage pressure.
  navigator.storage?.persist?.().catch(() => {});

  const res = await importFiles(list, new Set(userGames.map((g) => g.id)));
  const parts: string[] = [];
  if (res.added.length) parts.push(`Added ${res.added.length} game${res.added.length > 1 ? "s" : ""}`);
  if (res.duplicates.length) parts.push(`${res.duplicates.length} already in library`);
  for (const r of res.rejected) parts.push(`${r.name}: ${r.reason}`);
  toast(parts.join(" · ") || "Nothing added");
  await refresh();
}

async function removeGame(g: UserGame) {
  if (!confirm(`Remove “${g.title}” from your library?\n\nIn-browser save states for it are kept and will come back if you re-add the same ROM.`)) return;
  await deleteGame(g.id);
  await refresh();
}

els.fileInput.addEventListener("change", () => {
  if (els.fileInput.files) addFiles(els.fileInput.files);
  els.fileInput.value = "";
});
els.search.addEventListener("input", render);

// Page-wide drag & drop
let dragDepth = 0;
const hasFiles = (e: DragEvent) => e.dataTransfer?.types.includes("Files") ?? false;
window.addEventListener("dragenter", (e) => {
  if (!hasFiles(e)) return;
  dragDepth++;
  els.overlay.hidden = false;
});
window.addEventListener("dragleave", () => {
  if (--dragDepth <= 0) {
    dragDepth = 0;
    els.overlay.hidden = true;
  }
});
window.addEventListener("dragover", (e) => {
  if (hasFiles(e)) e.preventDefault();
});
window.addEventListener("drop", (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  els.overlay.hidden = true;
  if (e.dataTransfer?.files) addFiles(e.dataTransfer.files);
});

// ---------- PWA ----------

let offlineReady = false;
function renderNetStatus() {
  els.offline.textContent = !navigator.onLine ? "Offline · " : offlineReady ? "Available offline · " : "";
}
if (!inDiscord) {
  registerSW({
    immediate: true,
    onOfflineReady() {
      offlineReady = true;
      renderNetStatus();
    },
  });
}
navigator.serviceWorker?.ready.then(() => {
  offlineReady = true;
  renderNetStatus();
});
window.addEventListener("online", renderNetStatus);
window.addEventListener("offline", renderNetStatus);
renderNetStatus();

// ---------- boot ----------

loadHomebrewCatalog().then((list) => {
  homebrew = list;
  render();
});
refresh();
