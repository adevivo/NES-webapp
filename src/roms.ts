import { putGame, type UserGame } from "./db";

/** Extensions fceumm/EmulatorJS can open directly. Archives are extracted by EmulatorJS. */
export const ROM_EXTENSIONS = [".nes", ".unf", ".unif", ".zip", ".7z"];
export const ACCEPT_ATTR = ROM_EXTENSIONS.join(",");

/** Homebrew catalog entry (public/homebrew/manifest.json). */
export interface HomebrewGame {
  id: string;
  title: string;
  author: string;
  file: string;
  license: string;
  url?: string;
  description?: string;
}

export interface ImportResult {
  added: UserGame[];
  duplicates: string[];
  rejected: { name: string; reason: string }[];
}

const MAX_ROM_BYTES = 16 * 1024 * 1024; // largest real NES carts are ~1 MB; zips a bit more

function hasRomExtension(name: string) {
  const lower = name.toLowerCase();
  return ROM_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

function titleFromFileName(name: string) {
  return name
    .replace(/\.[^.]+$/, "")
    .replace(/[_.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function sha256Hex(buf: ArrayBuffer) {
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** iNES / NES 2.0 files start with "NES\x1A". */
function looksLikeINES(bytes: Uint8Array) {
  return bytes[0] === 0x4e && bytes[1] === 0x45 && bytes[2] === 0x53 && bytes[3] === 0x1a;
}

export async function importFiles(files: Iterable<File>, existingIds: Set<string>): Promise<ImportResult> {
  const result: ImportResult = { added: [], duplicates: [], rejected: [] };

  for (const file of files) {
    if (!hasRomExtension(file.name)) {
      result.rejected.push({ name: file.name, reason: `not a ROM (${ROM_EXTENSIONS.join(", ")})` });
      continue;
    }
    if (file.size > MAX_ROM_BYTES) {
      result.rejected.push({ name: file.name, reason: "file is too large to be an NES ROM" });
      continue;
    }
    const buf = await file.arrayBuffer();
    if (file.name.toLowerCase().endsWith(".nes") && !looksLikeINES(new Uint8Array(buf, 0, Math.min(4, buf.byteLength)))) {
      result.rejected.push({ name: file.name, reason: "missing iNES header — not a valid .nes file" });
      continue;
    }

    const id = "u-" + (await sha256Hex(buf)).slice(0, 16);
    if (existingIds.has(id)) {
      result.duplicates.push(file.name);
      continue;
    }

    const game: UserGame = {
      id,
      title: titleFromFileName(file.name) || file.name,
      fileName: file.name,
      size: file.size,
      addedAt: Date.now(),
      rom: new Blob([buf], { type: "application/octet-stream" }),
    };
    await putGame(game);
    existingIds.add(id);
    result.added.push(game);
  }
  return result;
}

export async function loadHomebrewCatalog(): Promise<HomebrewGame[]> {
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}homebrew/manifest.json`, { cache: "no-cache" });
    if (!res.ok) return [];
    const data: unknown = await res.json();
    return Array.isArray(data) ? (data as HomebrewGame[]).filter((g) => g && g.id && g.file && g.title) : [];
  } catch {
    return [];
  }
}

export function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
