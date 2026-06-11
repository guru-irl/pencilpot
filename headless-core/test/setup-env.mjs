import { writeFileSync } from "node:fs";
import { rpc, transitToken, BASE } from "./helpers.mjs";

const email = "hl@penpot.local", password = "penpot1234", fullname = "Headless Tester";

// 1. register (email verification disabled on this instance)
try {
  const prep = await rpc("prepare-register-profile", { email, password, fullname });
  const regToken = transitToken(prep.json);
  if (!regToken) throw new Error("prepare-register-profile returned no token");
  try {
    await rpc("register-profile", { token: regToken, fullname });
  } catch (e) {
    // tolerate re-runs where the account already exists; rethrow anything else
    if (!/already|exists|registered/i.test(String(e.message))) throw e;
  }
} catch (e) {
  // tolerate re-runs where the account already exists; rethrow anything else
  if (!/already|exists|registered/i.test(String(e.message))) throw e;
}

// 2. login to obtain an authenticated session cookie
const loginRes = await fetch(`${BASE}/api/rpc/command/login-with-password`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Accept: "application/json" },
  body: JSON.stringify({ email, password }),
});
if (!loginRes.ok) throw new Error(`login failed: ${loginRes.status}`);
const setCookie = loginRes.headers.get("set-cookie");
if (!setCookie) throw new Error("login succeeded but no set-cookie header");
const authCookie = setCookie.split(";")[0]; // auth-token=...
const profile = await loginRes.json();

// helper that calls RPC with the session cookie
async function rpcCookie(name, body) {
  const res = await fetch(`${BASE}/api/rpc/command/${name}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", Cookie: authCookie },
    body: JSON.stringify(body ?? {}),
  });
  const t = await res.text();
  if (!res.ok) throw new Error(`${name} -> ${res.status}: ${t.slice(0,300)}`);
  return t ? JSON.parse(t) : undefined;
}

// 3. mint an access token (requires enable-access-tokens, set on penpot-hl)
const tok = await rpcCookie("create-access-token", { name: "headless-phase0" });
const token = tok.token;
if (!token) throw new Error("no access token returned — is enable-access-tokens set?");

// 4. create a project + file to edit
const projectId = profile.defaultProjectId;
const file = await rpcCookie("create-file", { name: "Headless Test File", projectId });

writeFileSync(new URL("../../infra/penpot-hl/test-env.json", import.meta.url),
  JSON.stringify({ token, fileId: file.id, projectId }, null, 2));
console.log("OK fileId=", file.id, "tokenLen=", token.length);
