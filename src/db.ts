import { openDB, type DBSchema, type IDBPDatabase } from "idb";

export interface UserGame {
  /** "u-" + first 16 hex chars of the ROM's SHA-256. Stable across renames, dedupes re-imports. */
  id: string;
  title: string;
  fileName: string;
  size: number;
  addedAt: number;
  rom: Blob;
}

export interface PlayRecord {
  id: string;
  lastPlayedAt: number;
  plays: number;
}

interface LibrarySchema extends DBSchema {
  games: { key: string; value: UserGame; indexes: { addedAt: number } };
  plays: { key: string; value: PlayRecord };
}

let dbPromise: Promise<IDBPDatabase<LibrarySchema>> | undefined;

function db() {
  dbPromise ??= openDB<LibrarySchema>("nes-library", 1, {
    upgrade(d) {
      const games = d.createObjectStore("games", { keyPath: "id" });
      games.createIndex("addedAt", "addedAt");
      d.createObjectStore("plays", { keyPath: "id" });
    },
  });
  return dbPromise;
}

export async function listGames(): Promise<UserGame[]> {
  return (await db()).getAll("games");
}

export async function getGame(id: string): Promise<UserGame | undefined> {
  return (await db()).get("games", id);
}

export async function putGame(game: UserGame): Promise<void> {
  await (await db()).put("games", game);
}

export async function deleteGame(id: string): Promise<void> {
  const d = await db();
  const tx = d.transaction(["games", "plays"], "readwrite");
  await Promise.all([tx.objectStore("games").delete(id), tx.objectStore("plays").delete(id), tx.done]);
}

export async function listPlays(): Promise<Map<string, PlayRecord>> {
  const all = await (await db()).getAll("plays");
  return new Map(all.map((p) => [p.id, p]));
}

export async function recordPlay(id: string): Promise<void> {
  const d = await db();
  const prev = await d.get("plays", id);
  await d.put("plays", { id, lastPlayedAt: Date.now(), plays: (prev?.plays ?? 0) + 1 });
}
