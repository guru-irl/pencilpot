# Penpot Headless SDK — Phase 1c-3 (`pp` CLI) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Checkbox steps.

**Goal:** A shell `pp` CLI wrapping the headless WorkingCopy, so any terminal/CI/non-MCP tool can edit Penpot files. One-shot model (CLI = separate process per call): `pp run <fileId> -e "<js>"` does checkout → script → validate → commit in a single invocation; `pp scene <fileId>` prints the object map (read-only).

**Architecture:** Plain Node ESM `bin/pp.mjs` reusing `sdk/index.mjs` (`WorkingCopy`) + `sdk/script.mjs` (`runScript`). Config via env `PENPOT_TOKEN` + `PENPOT_HL_BASE` (same as the MCP server). No new engine code.

**Tech Stack:** Node ESM, `node:test` (spawns the CLI as a subprocess), penpot-hl.

---

## HARD ISOLATION RULE
penpot-hl (:9101) only; never `penpot`/:9001. Branch `feat/penpot-headless-sdk`. Commits: identity `Gurupungav Narayanan <28506515+guru-irl@users.noreply.github.com>`, **NO `Co-Authored-By` / no "Claude" in messages**.

---

## File Structure
- `headless-core/bin/pp.mjs` — the CLI (subcommands `run`, `scene`, `help`).
- `headless-core/package.json` — add `"bin": {"pp": "bin/pp.mjs"}` + `"test:cli"` script.
- `headless-core/test/cli.test.mjs` — spawn the CLI subprocess; assert `run` commits + persists, `scene` prints objects.
- skill + README updates.

---

## Task 1: The `pp` CLI + integration test (TDD)

**Files:** Create `headless-core/bin/pp.mjs`, `headless-core/test/cli.test.mjs`; modify `headless-core/package.json`.

- [ ] **Step 1: Failing test** — `headless-core/test/cli.test.mjs`:
```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { getFile } from "../sdk/rpc.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const pp = path.resolve(here, "../bin/pp.mjs");
const env = JSON.parse(readFileSync(path.resolve(here, "../../infra/penpot-hl/test-env.json")));
const run = (args) => execFileSync(process.execPath, [pp, ...args],
  { env: { ...process.env, PENPOT_TOKEN: env.token, PENPOT_HL_BASE: "http://localhost:9101" }, encoding: "utf8" });

test("pp run: checkout -> script -> commit persists", async () => {
  const before = await getFile(env.fileId, env.token);
  const beforeCount = Object.keys(before.raw.data.pagesIndex[before.pageId].objects).length;

  const out = run(["run", env.fileId, "-e",
    "const b=wc.addBoard({x:1500,y:60,width:200,height:120,name:'CLI Board'}); wc.addRect({x:1520,y:80,width:60,height:40,parentId:b}); wc.closeBoard(); return wc.pendingChanges().length;"]);
  assert.match(out, /committed/i);

  const after = await getFile(env.fileId, env.token);
  const afterCount = Object.keys(after.raw.data.pagesIndex[after.pageId].objects).length;
  assert.equal(afterCount, beforeCount + 2, "CLI run persisted 2 objects");
});

test("pp scene: prints object map without committing", async () => {
  const before = await getFile(env.fileId, env.token);
  const out = run(["scene", env.fileId]);
  const objs = JSON.parse(out);
  assert.ok(typeof objs === "object" && Object.keys(objs).length >= 1);
  const after = await getFile(env.fileId, env.token);
  assert.equal(after.revn, before.revn, "scene is read-only (revn unchanged)");
});
```

- [ ] **Step 2: Run → fail** — `cd headless-core && node --test test/cli.test.mjs` (FAIL: pp.mjs missing).

- [ ] **Step 3: Implement** `headless-core/bin/pp.mjs`:
```javascript
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
```

- [ ] **Step 4: package.json** — add `"bin": { "pp": "bin/pp.mjs" }` and `"test:cli": "node --test test/cli.test.mjs"`. Make executable: `chmod +x headless-core/bin/pp.mjs`.

- [ ] **Step 5: Run → pass** — `cd headless-core && node --test test/cli.test.mjs` (penpot-hl up; mutates throwaway file — fine). PASS when `run` commits + persists 2 objects and `scene` is read-only. Fix arg-parsing/exit issues; report.

- [ ] **Step 6: Commit** — `git add headless-core/bin/pp.mjs headless-core/test/cli.test.mjs headless-core/package.json && git commit -m ":sparkles: headless: pp CLI (run/scene) over the WorkingCopy"` (NO Claude/Co-Authored-By).

---

## Task 2: Docs + verify

- [ ] **Step 1: Add to verify** — update `verify` to include `test:cli`: append ` && npm run test:cli`. Run `cd headless-core && npm run verify && npm run sanity` → all green. Report tails.
- [ ] **Step 2: Skill** (`~/.claude/skills/penpot-headless/SKILL.md`) — add a short "CLI" note: `pp run <fileId> -e "<js with wc>"` (one-shot checkout→script→commit) and `pp scene <fileId>`; env `PENPOT_TOKEN`/`PENPOT_HL_BASE`. Note the MCP is for interactive/agent use; the CLI is for shell/CI.
- [ ] **Step 3: README** — document the `pp` CLI (install via `npm link` or run `node bin/pp.mjs`; subcommands; env). Commit README + package.json: `git add headless-core/README.md headless-core/package.json && git commit -m ":memo: headless: document pp CLI + wire into verify"` (no Claude).

---

## Phase 1c-3 Done = exit criteria
- `pp run <fileId> -e "<js>"` checks out, runs the script against `wc`, validates, and commits — persisting to penpot-hl. `pp scene <fileId>` prints objects read-only.
- `npm run verify` (now incl. `test:cli`) + `npm run sanity` green; skill + README document the CLI.
- Commits clean (guru-irl, no Claude).

**Phase 1c COMPLETE** after this (text + flex + CLI). Remaining roadmap: grid auto-layout, ellipses/paths, components; pointing a vetted instance at the headless MCP for real-design editing.
