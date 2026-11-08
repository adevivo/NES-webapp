// fetch helpers for code running inside a Discord Activity. Requests normally work on plain
// paths; the "/.proxy" prefix is tried as a fallback since Discord documents both forms.
export async function postJSON(path: string, body: unknown) {
  for (const p of [path, `/.proxy${path}`]) {
    try {
      const res = await fetch(p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (res.ok) return { path: p, res };
    } catch {
      /* try next */
    }
  }
  throw new Error(`POST ${path} failed (both plain and /.proxy)`);
}

export async function getJSON(path: string) {
  for (const p of [path, `/.proxy${path}`]) {
    try {
      const r = await fetch(p);
      if (r.ok) return { path: p, data: await r.json() };
    } catch {
      /* try next */
    }
  }
  throw new Error(`GET ${path} failed`);
}
