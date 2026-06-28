// AI-dev audit — B2 Harness A: design tokens via the headless SDK/MCP.
//
// Exercises the ONLY token authoring surface the headless engine exposes —
// `addColorToken` — end to end against a LOCAL pencilpot runtime, and documents
// the token-model GAP (color is the only wired type; no typography / spacing /
// sizing / dimension / etc., and no token->shape binding).
//
//   checkout -> addColorToken({set,name,value}) -> tokens() lists it ->
//   commit() (recorded change; A-FIX2 baseline-diff gate) -> /pencilpot/save ->
//   on-disk manifest.edn (tokens-lib lives there) has the set+token ->
//   cold reopen -> a fresh checkout still lists it.
//
// Color tokens are FILE-level (tokens-lib), persisted in <design>/manifest.edn.
// Run: node pencilpot/e2e/ai/sdk-tokens.mjs   (SKIP exit 0 if canonical design absent)
import fs from "node:fs";
import path from "node:path";
import {
  FID, designPresent, copyDesign, spawnRuntime, getFileViaRuntime,
  loadWorkingCopy, status, save, kill, makeChecks,
} from "./_boot.mjs";

if (!designPresent()) {
  console.log("SKIP: canonical design absent — cannot run sdk-tokens audit");
  process.exit(0);
}

const { check, passed } = makeChecks();
const SET = "AI Tokens";
const TOKEN = "brand.primary";
const VALUE = "#3366ff";

let srv = null;
try {
  const dir = copyDesign("b2-tokens");
  const r = await spawnRuntime(dir);
  srv = r.proc;
  const base = r.base;

  const WorkingCopy = await loadWorkingCopy(base);
  const wc = await new WorkingCopy(FID, "local").checkout();
  check(true, `checkout ok (revn=${wc.revn})`);

  // (1) baseline token state (the canonical design already ships a tokens-lib)
  const baseline = wc.tokens();
  check(baseline && Array.isArray(baseline.sets) && Array.isArray(baseline.tokens),
    `tokens() returns {sets,tokens} (baseline sets=${baseline.sets.length}, tokens=${baseline.tokens.length})`);
  const baseErrs = wc.validate();

  // (2) THE ONLY TOKEN SURFACE: addColorToken — {set, name, value}
  const tokenId = wc.addColorToken({ set: SET, name: TOKEN, value: VALUE });
  check(typeof tokenId === "string" && tokenId.length > 0, `addColorToken returned a token id (${tokenId})`);

  // (3) tokens() now lists the new set + token (name/value/type:color)
  const after = wc.tokens();
  check(after.sets.includes(SET), `tokens() lists the new set "${SET}" (sets=${JSON.stringify(after.sets)})`);
  const t = after.tokens.find((x) => x.name === TOKEN);
  check(!!t, `tokens() lists the new token "${TOKEN}"`);
  check(t && t.value === VALUE, `token value round-trips (${t && t.value})`);
  check(t && t.type === "color", `token type is "color" (${t && t.type})`);

  // (4) addColorToken records a change -> the gated commit() persists it (A-FIX2)
  check(wc.pendingChanges().length > 0, `addColorToken recorded a change (pending=${wc.pendingChanges().length})`);
  const newErrs = wc.validate().filter((e) => !baseErrs.includes(e));
  check(newErrs.length === 0, `no NEW validation errors introduced (${JSON.stringify(newErrs)})`);
  const revnBefore = wc.revn;
  const res = await wc.commit();
  check(!!res && wc.revn === revnBefore + 1, `commit() persisted the token (revn ${revnBefore} -> ${wc.revn})`);

  // (5) staged in runtime; explicit save -> on-disk manifest.edn carries the token
  const st1 = await status(base);
  check(st1.dirty === true, `runtime dirty after commit (staged)`);
  await save(base);
  const st2 = await status(base);
  check(st2.dirty === false, `runtime clean after /pencilpot/save`);
  const manifest = fs.readFileSync(path.join(dir, "manifest.edn"), "utf8");
  // tokens-lib stores the dotted name NESTED: "AI Tokens" {"brand" {"primary" {...}}},
  // so the dotted leaf "brand.primary" never appears literally — assert the set + leaf + value.
  check(manifest.includes(SET) && manifest.includes('"primary"'),
    `on-disk manifest.edn (tokens-lib) contains the set + token (nested groups)`);
  check(manifest.includes(VALUE), `on-disk manifest.edn contains the token value`);

  // (6) cold reopen: re-getFile over the saved design still carries the token.
  //     GOTCHA: the SDK freezes PENPOT_HL_BASE at module load, so a second
  //     WorkingCopy can't retarget a new port — use the raw get-file transit
  //     (same path the SDK reads), like commit-roundtrip.mjs does.
  kill(srv); srv = null;
  const r2 = await spawnRuntime(dir);
  srv = r2.proc;
  const reopened = await getFileViaRuntime(r2.base, FID);
  check(reopened.transit.includes(SET) && reopened.transit.includes(VALUE),
    `token persists across a cold runtime restart (in get-file transit)`);
  const st3 = await status(r2.base);
  check(st3.dirty === false, `reopened design is clean (no spurious dirty from a token add)`);

  // (7) TOKEN-MODEL GAP audit: color is the ONLY wired token type/surface.
  //     The full Penpot token model has many types (typography, spacing, sizing,
  //     dimension, border-radius, opacity, rotation, ...) and theme/set management
  //     + token->shape binding — none of which the headless SDK/MCP exposes.
  const sdkTokenMethods = ["addColorToken", "tokens"].filter((m) => typeof wc[m] === "function");
  const absentMethods = ["addTypographyToken", "addSpacingToken", "addDimensionToken",
    "addSizingToken", "addBorderRadiusToken", "addToken", "applyToken", "bindToken", "setTokenTheme"]
    .filter((m) => typeof wc[m] === "function");
  check(sdkTokenMethods.length === 2, `SDK token surface = exactly {addColorToken, tokens} (${JSON.stringify(sdkTokenMethods)})`);
  check(absentMethods.length === 0,
    `GAP confirmed: no non-color token / binding methods exist (absent: ${JSON.stringify(absentMethods)})`);

  console.log(`  token id: ${tokenId}`);
} catch (e) {
  console.log("FAIL: harness error");
  console.error(e?.stack || String(e));
  process.exitCode = 1;
} finally {
  if (srv) kill(srv);
}

console.log(passed() ? "\nALL CHECKS PASS" : "\nCHECKS FAILED");
process.exit(passed() ? 0 : 1);
