// Discord Activity feasibility spike. Answers, inside the real Discord clients:
//  - does Discord's CSP allow what each emulator needs (eval, wasm, blob scripts/workers)?
//  - do JSNES and EmulatorJS actually run, and do player 1 + player 2 inputs reach the game?
//  - do file pickers / IndexedDB / gamepads work in the Activity iframe?
//  - what is the WebSocket round-trip time through Discord's proxy to our server?
// Everything observed is POSTed to /api/report so it shows up in the server log.
import "./style.css";
import { DiscordSDK } from "@discord/embedded-app-sdk";
import { Controller, NES } from "jsnes";
import { getJSON, postJSON } from "./report";

type Result = { ok: boolean | null; detail: string };
const results: Record<string, Result> = {};
const cspViolations: { directive: string; blocked: string; policy?: string }[] = [];
const rows = document.getElementById("results")!;
(document.getElementById("play-link") as HTMLAnchorElement).href = `nes.html${location.search}`;
const inDiscord = new URLSearchParams(location.search).has("frame_id");

function set(name: string, ok: boolean | null, detail = "") {
  results[name] = { ok, detail };
  let row = rows.querySelector<HTMLTableRowElement>(`tr[data-k="${CSS.escape(name)}"]`);
  if (!row) {
    row = document.createElement("tr");
    row.dataset.k = name;
    row.append(document.createElement("td"), document.createElement("th"), document.createElement("td"));
    rows.append(row);
  }
  row.cells[0].textContent = ok === null ? "…" : ok ? "✅" : "❌";
  row.cells[1].textContent = name;
  row.cells[2].textContent = detail;
}

const withTimeout = <T>(p: Promise<T>, ms: number, what: string) =>
  Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`${what} timed out after ${ms}ms`)), ms))]);

document.addEventListener("securitypolicyviolation", (e) => {
  const first = cspViolations.length === 0;
  cspViolations.push({ directive: e.effectiveDirective, blocked: e.blockedURI, policy: first ? e.originalPolicy : undefined });
});

// ---------- reporting ----------

async function sendReport() {
  const report = {
    inDiscord,
    href: location.href.replace(/([?&](?:instance_id|frame_id|channel_id|guild_id)=)[^&]+/g, "$1…"),
    userAgent: navigator.userAgent,
    results,
    cspViolations: cspViolations.slice(0, 30),
  };
  const sent = document.getElementById("sent")!;
  try {
    const { path } = await postJSON("/api/report", report);
    sent.textContent = `sent via ${path} at ${new Date().toLocaleTimeString()}`;
  } catch (e) {
    sent.textContent = String(e);
  }
}
document.getElementById("send")!.addEventListener("click", sendReport);

// ---------- environment + capability probes ----------

async function probes() {
  set("in Discord iframe", inDiscord, inDiscord ? "frame_id present" : "opened directly (not inside Discord)");
  set("crossOriginIsolated / SharedArrayBuffer", true, `${self.crossOriginIsolated} / ${typeof SharedArrayBuffer !== "undefined"}`);

  try {
    set("CSP: eval (new Function)", new Function("return 42")() === 42, "needed by EmulatorJS core (cwrap)");
  } catch (e) {
    set("CSP: eval (new Function)", false, String(e));
  }
  try {
    // smallest valid wasm module: magic + version
    const mod = await WebAssembly.compile(new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]));
    await WebAssembly.instantiate(mod);
    set("CSP: WebAssembly compile", true);
  } catch (e) {
    set("CSP: WebAssembly compile", false, String(e));
  }
  set("CSP: blob: <script>", null);
  await new Promise<void>((resolve) => {
    const s = document.createElement("script");
    const url = URL.createObjectURL(new Blob(["window.__blobScriptRan = true;"], { type: "text/javascript" }));
    s.src = url;
    s.onload = () => {
      set("CSP: blob: <script>", (window as unknown as { __blobScriptRan?: boolean }).__blobScriptRan === true, "EmulatorJS loads its core this way");
      resolve();
    };
    s.onerror = () => {
      set("CSP: blob: <script>", false, "blocked");
      resolve();
    };
    document.head.append(s);
  });
  try {
    const w = new Worker(URL.createObjectURL(new Blob(["postMessage(1)"], { type: "text/javascript" })));
    const ok = await withTimeout(new Promise<boolean>((r) => (w.onmessage = () => r(true))), 3000, "worker");
    w.terminate();
    set("CSP: blob: Worker", ok, "EmulatorJS zip/7z extraction");
  } catch (e) {
    set("CSP: blob: Worker", false, String(e));
  }

  try {
    const db = await new Promise<IDBDatabase>((res, rej) => {
      const r = indexedDB.open("diag", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("kv");
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const prev = await new Promise<unknown>((res) => {
      const g = db.transaction("kv").objectStore("kv").get("visits");
      g.onsuccess = () => res(g.result);
      g.onerror = () => res(undefined);
    });
    const visits = (typeof prev === "number" ? prev : 0) + 1;
    await new Promise<void>((res, rej) => {
      const tx = db.transaction("kv", "readwrite");
      tx.objectStore("kv").put(visits, "visits");
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
    const persisted = (await navigator.storage?.persisted?.()) ?? "n/a";
    const est = await navigator.storage?.estimate?.();
    set("IndexedDB read/write", true, `visit #${visits} (reopen the Activity: >1 means storage persists) · persisted=${persisted} · quota=${est?.quota ? Math.round(est.quota / 1e6) + "MB" : "n/a"}`);
  } catch (e) {
    set("IndexedDB read/write", false, String(e));
  }
  try {
    localStorage.setItem("diag", "1");
    set("localStorage", localStorage.getItem("diag") === "1");
  } catch (e) {
    set("localStorage", false, String(e));
  }
  set("Gamepad API", typeof navigator.getGamepads === "function", "press a pad button to confirm");
  window.addEventListener("gamepadconnected", (e) => set("Gamepad connected", true, e.gamepad.id), { once: true });
  set("AudioContext", typeof AudioContext !== "undefined");
  set("File picker", null, "tap “Pick any file” below");
  document.getElementById("file")!.addEventListener("change", (e) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    set("File picker", Boolean(f), f ? `${f.name} (${f.size} B)` : "no file");
    sendReport();
  });
}

// ---------- Discord SDK ----------

async function discord() {
  if (!inDiscord) return set("Discord SDK", null, "skipped (not in Discord)");
  try {
    const { data: cfg } = await getJSON("/api/config");
    const sdk = new DiscordSDK(cfg.clientId);
    await withTimeout(sdk.ready(), 10000, "sdk.ready()");
    set("Discord SDK ready", true, `platform=${sdk.platform}`);
    try {
      const { code } = await sdk.commands.authorize({ client_id: cfg.clientId, response_type: "code", state: "", prompt: "none", scope: ["identify"] });
      const { res } = await postJSON("/api/token", { code });
      const { access_token } = await res.json();
      const auth = await sdk.commands.authenticate({ access_token });
      const who = auth.user.global_name ?? auth.user.username;
      document.getElementById("who")!.textContent = who;
      set("Discord auth (OAuth)", true, `signed in as ${who}`);
    } catch (e) {
      set("Discord auth (OAuth)", false, String((e as Error)?.message ?? JSON.stringify(e)));
    }
  } catch (e) {
    set("Discord SDK ready", false, String(e));
  }
}

// ---------- WebSocket RTT ----------

let jsnesPaused = false; // the latency test pauses the JSNES loop so it doesn't skew timings
let latencyRun = 0;

async function wsRtt(paths = ["/ws", "/.proxy/ws"], count = 40) {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const ejsLoaded = document.querySelector(".ejs-frame") !== null;
  const run = ++latencyRun;
  jsnesPaused = true;
  try {
    for (const path of paths) {
      const name = run === 1 ? `WebSocket RTT ${path}` : `WebSocket RTT ${path} (rerun ${run})`;
      set(name, null, "measuring…");
      try {
        const ws = new WebSocket(`${proto}//${location.host}${path}`);
        await withTimeout(new Promise((res, rej) => ((ws.onopen = res), (ws.onerror = () => rej(new Error("connect failed"))))), 8000, "connect");
        // Sequence-numbered pings so a late pong can't be mistaken for the current one.
        const pending = new Map<string, number>();
        const samples: number[] = [];
        ws.onmessage = (e) => {
          const t0 = pending.get(String(e.data));
          if (t0 !== undefined) {
            samples.push(performance.now() - t0);
            pending.delete(String(e.data));
          }
        };
        for (let i = 0; i < count; i++) {
          pending.set(`${run}:${i}`, performance.now());
          ws.send(`${run}:${i}`);
          await new Promise((r) => setTimeout(r, 100));
        }
        await new Promise((r) => setTimeout(r, 2000)); // let stragglers arrive
        ws.close();
        const lost = pending.size;
        if (!samples.length) throw new Error(`no replies (${lost} lost)`);
        samples.sort((a, b) => a - b);
        const q = (p: number) => samples[Math.min(samples.length - 1, Math.floor(p * samples.length))].toFixed(0);
        const median = samples[samples.length >> 1];
        set(
          name,
          lost === 0,
          `median ${q(0.5)}ms · p90 ${q(0.9)}ms · max ${q(1)}ms · lost ${lost}/${count} · EmulatorJS ${ejsLoaded ? "LOADED (skews result)" : "not loaded"} → lockstep delay ≈ ${Math.ceil(median / 2 / 16.7) + 1} frames`,
        );
      } catch (e) {
        set(name, false, String(e));
      }
    }
  } finally {
    jsnesPaused = false;
  }
}
document.getElementById("rtt")!.addEventListener("click", async (e) => {
  const btn = e.currentTarget as HTMLButtonElement;
  btn.disabled = true;
  await wsRtt(["/ws"], 60);
  btn.disabled = false;
  sendReport();
});

// ---------- JSNES ----------

function classify(px: number) {
  const r = px & 0xff, g = (px >> 8) & 0xff, b = (px >> 16) & 0xff; // JSNES buffer is 0x00BBGGRR
  return b > r && b > g ? "blue" : r > g && r > b ? "red" : g > r && g > b ? "green" : `rgb(${r},${g},${b})`;
}

async function jsnes() {
  set("JSNES boots + P1/P2 input", null);
  try {
    const rom = new Uint8Array(await (await fetch("/homebrew/test-pattern.nes")).arrayBuffer());
    const canvas = document.getElementById("jsnes") as HTMLCanvasElement;
    const ctx = canvas.getContext("2d")!;
    const img = ctx.createImageData(256, 240);
    const view = new Uint32Array(img.data.buffer);
    let last: Uint32Array<ArrayBufferLike> = new Uint32Array(256 * 240);
    const nes = new NES({ onFrame: (buf) => (last = buf), emulateSound: false });
    nes.loadROM(rom);
    const run = (n: number) => { for (let i = 0; i < n; i++) nes.frame(); };
    const sample = () => classify(last[120 * 256 + 128]);

    // deterministic headless checks (exactly what lockstep needs)
    run(30);
    const idle = sample();
    nes.buttonDown(1, Controller.BUTTON_A); run(3); const p1 = sample(); nes.buttonUp(1, Controller.BUTTON_A);
    nes.buttonDown(2, Controller.BUTTON_A); run(3); const p2 = sample(); nes.buttonUp(2, Controller.BUTTON_A);
    run(3);
    const ok = idle === "blue" && p1 === "red" && p2 === "green";
    set("JSNES boots + P1/P2 input", ok, `idle=${idle} p1=${p1} p2=${p2}`);

    // interactive: any key = P1, "p" = P2
    const held = new Set<string>();
    window.addEventListener("keydown", (e) => {
      if (held.has(e.key)) return;
      held.add(e.key);
      nes.buttonDown(e.key.toLowerCase() === "p" ? 2 : 1, Controller.BUTTON_A);
    });
    window.addEventListener("keyup", (e) => {
      held.delete(e.key);
      nes.buttonUp(e.key.toLowerCase() === "p" ? 2 : 1, Controller.BUTTON_A);
    });
    canvas.addEventListener("pointerdown", () => nes.buttonDown(1, Controller.BUTTON_A));
    canvas.addEventListener("pointerup", () => nes.buttonUp(1, Controller.BUTTON_A));
    const loop = () => {
      if (jsnesPaused) return void requestAnimationFrame(loop);
      nes.frame();
      for (let i = 0; i < view.length; i++) view[i] = 0xff000000 | last[i];
      ctx.putImageData(img, 0, 0);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  } catch (e) {
    set("JSNES boots + P1/P2 input", false, String(e));
  }
}

// ---------- EmulatorJS (in an iframe; it needs page-level globals) ----------

window.addEventListener("message", (e) => {
  if (e.origin !== location.origin || typeof e.data !== "object" || !e.data?.diag) return;
  const { kind, detail } = e.data as { kind: string; detail: string };
  if (kind === "started") set("EmulatorJS boots", true, detail);
  if (kind === "error") set("EmulatorJS boots", false, detail);
  if (kind === "csp") cspViolations.push({ directive: "ejs-iframe:" + detail, blocked: "" });
  sendReport();
});
document.getElementById("ejs-run")!.addEventListener("click", () => {
  set("EmulatorJS boots", null, "click “Start Game” in the frame");
  const f = document.createElement("iframe");
  f.src = "play.html?id=hb-test-pattern&diag=1";
  f.className = "ejs-frame";
  f.allow = "autoplay; fullscreen; gamepad";
  document.getElementById("ejs-slot")!.replaceChildren(f);
});

// ---------- run ----------

(async () => {
  await probes();
  await Promise.all([discord(), jsnes()]);
  await wsRtt();
  await sendReport();
})();
