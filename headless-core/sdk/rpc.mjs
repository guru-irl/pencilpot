// Penpot RPC client for the headless toolkit.
// Reads: get-file as transit (so the engine hydrates real records). Writes: update-file as transit.
const BASE = process.env.PENPOT_HL_BASE ?? "http://localhost:9101";

async function call(name, { token, body, contentType = "application/json", accept = "application/json" }) {
  const res = await fetch(`${BASE}/api/rpc/command/${name}`, {
    method: "POST",
    headers: { "Content-Type": contentType, Accept: accept, ...(token ? { Authorization: `Token ${token}` } : {}) },
    body,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${name} -> HTTP ${res.status}: ${text.slice(0, 500)}`);
  return { text, contentType: res.headers.get("content-type") || "" };
}

// get-file: meta (revn/vern/features/pageId) via JSON + the file as TRANSIT (for faithful record hydration).
export async function getFile(fileId, token) {
  const meta = JSON.parse((await call("get-file", { token, body: JSON.stringify({ id: fileId }) })).text);
  const transit = (await call("get-file", {
    token, body: JSON.stringify({ id: fileId }), accept: "application/transit+json",
  })).text;
  return { revn: meta.revn, vern: meta.vern, features: meta.features, pageId: meta.data.pages[0], dataTransit: transit, raw: meta };
}

// update-file with a transit body produced by the session's commitBody().
export async function updateFile(transitBody, token) {
  const { text } = await call("update-file", {
    token, body: transitBody, contentType: "application/transit+json", accept: "application/json",
  });
  return JSON.parse(text);
}

export { BASE };
