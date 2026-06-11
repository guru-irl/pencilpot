// Minimal Penpot RPC client for Phase 0 tests. JSON in / JSON out.
const BASE = process.env.PENPOT_HL_BASE ?? "http://localhost:9101";

async function rpc(name, body, { token, method = "POST" } = {}) {
  const headers = { "Content-Type": "application/json", Accept: "application/json" };
  if (token) headers.Authorization = `Token ${token}`;
  const res = await fetch(`${BASE}/api/rpc/command/${name}`, {
    method,
    headers,
    body: JSON.stringify(body ?? {}),
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : undefined; } catch { json = text; }
  if (!res.ok) throw new Error(`${name} -> HTTP ${res.status}: ${text.slice(0, 400)}`);
  return { json, headers: res.headers };
}

// some responses (e.g. transit mode) wrap values as ["^ ","~:token", ...]; also handle plain {token}
function transitToken(json) {
  if (Array.isArray(json)) { const i = json.indexOf("~:token"); return i >= 0 ? json[i + 1] : undefined; }
  return json?.token;
}

export { BASE, rpc, transitToken };
