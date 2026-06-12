#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { WorkingCopy } from "../sdk/index.mjs";
import { runScript } from "../sdk/script.mjs";

const USAGE = `pp — headless Penpot CLI
  pp run <fileId> (-e <code> | -f <file.js>)   checkout, run JS (globals: wc), validate, commit
  pp scene <fileId>                            print the file's object map (read-only)
Env: PENPOT_TOKEN (required), PENPOT_HL_BASE (default http://localhost:9101)`;

function fail(msg) { console.error(msg); process.exit(1); }

function getCode(rest) {
  const ei = rest.indexOf("-e"); if (ei >= 0) return rest[ei + 1];
  const fi = rest.indexOf("-f"); if (fi >= 0) return readFileSync(rest[fi + 1], "utf8");
  // fall back to stdin
  try { return readFileSync(0, "utf8"); } catch { return ""; }
}

const [cmd, fileId, ...rest] = process.argv.slice(2);
if (!cmd || cmd === "help" || cmd === "--help") { console.log(USAGE); process.exit(0); }
if (!process.env.PENPOT_TOKEN) fail("PENPOT_TOKEN is required");
if (!fileId) fail(`missing <fileId>\n${USAGE}`);
const token = process.env.PENPOT_TOKEN;

const main = async () => {
  const wc = await new WorkingCopy(fileId, token).checkout();
  if (cmd === "scene") { console.log(wc.session.objects()); return; }
  if (cmd === "run") {
    const code = getCode(rest);
    if (!code) fail("no script: pass -e <code>, -f <file>, or pipe via stdin");
    const r = await runScript(code, { wc });
    if (!r.ok) fail(`script error: ${r.error}\n${r.log}`);
    const errs = wc.validate();
    if (errs.length) fail(`invalid; not committed: ${errs.join("; ")}`);
    const res = await wc.commit();
    console.log(JSON.stringify({ committed: true, revn: res.revn + 1, result: r.result, log: r.log || undefined }, null, 2));
    return;
  }
  fail(`unknown command: ${cmd}\n${USAGE}`);
};
main().catch((e) => fail(String(e && e.message || e)));
