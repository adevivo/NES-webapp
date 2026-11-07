// Copies the EmulatorJS runtime + the NES (fceumm) core into public/emulatorjs/data
// so the site is fully self-hosted (no runtime dependency on cdn.emulatorjs.org).
//
// The npm package ships unminified sources only; loader.js expects emulator.min.js /
// emulator.min.css. Upstream's build just concatenates the sources in loader order
// (then minifies), so we concatenate them here. Vite/our server handle compression.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

const ejsDir = join(dirname(require.resolve("@emulatorjs/emulatorjs/package.json")), "data");
const coreDir = dirname(require.resolve("@emulatorjs/core-fceumm/package.json"));
const out = join(root, "public", "emulatorjs", "data");

// Same order as data/loader.js
const SCRIPTS = [
  "emulator.js",
  "nipplejs.js",
  "shaders.js",
  "storage.js",
  "gamepad.js",
  "GameManager.js",
  "socket.io.min.js",
  "compression.js",
];

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "cores", "reports"), { recursive: true });

cpSync(join(ejsDir, "loader.js"), join(out, "loader.js"));
cpSync(join(ejsDir, "version.json"), join(out, "version.json"));
cpSync(join(ejsDir, "compression"), join(out, "compression"), { recursive: true });
cpSync(join(ejsDir, "emulator.css"), join(out, "emulator.min.css"));

const bundle = SCRIPTS.map((f) => {
  const src = readFileSync(join(ejsDir, "src", f), "utf8").replace(/^\/\/# sourceMappingURL=.*$/gm, "");
  return `/* ---- ${f} ---- */\n${src}\n;`;
}).join("\n");
writeFileSync(join(out, "emulator.min.js"), bundle);

// Non-threaded builds only: threads need COOP/COEP headers and NES doesn't benefit.
for (const f of ["fceumm-wasm.data", "fceumm-legacy-wasm.data"]) {
  cpSync(join(coreDir, f), join(out, "cores", f));
}
const report = join(coreDir, "reports", "fceumm.json");
if (existsSync(report)) cpSync(report, join(out, "cores", "reports", "fceumm.json"));

console.log(`[copy-emulator] EmulatorJS + fceumm copied to ${out}`);
