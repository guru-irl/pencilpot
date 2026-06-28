import { randomUUID } from "node:crypto";
import { createSession } from "../target/headless/penpot.js";
import { getFile, updateFile } from "./rpc.mjs";

// Stable key for a validation-error entry so the baseline diff compares by VALUE,
// not identity — robust whether the validator yields strings (the engine's generic
// "invalid file data" hint) or richer objects.
const errKey = (e) => (typeof e === "string" ? e : JSON.stringify(e));

export class WorkingCopy {
  constructor(fileId, token) { this.fileId = fileId; this.token = token; }

  async checkout() {
    const f = await getFile(this.fileId, this.token);
    this.revn = f.revn; this.vern = f.vern; this.features = f.features;
    this.session = createSession(JSON.stringify({ dataTransit: f.dataTransit, fileId: this.fileId, features: f.features }));
    // Snapshot the pre-edit validation state. An IMPORTED design may carry
    // pre-existing strict-schema nonconformities (a non-nil :tokens-lib needing a
    // TokensLib instance, variable-font :font-variation-settings, …) that render
    // fine but trip the whole-file validator. The AI's edits did not introduce
    // those, so commit() must not block on them — only on errors the edit ADDS.
    this.baselineErrs = this.validate();
    return this;
  }

  addBoard(p)   { return this.session.addBoard(JSON.stringify(p)); }
  addRect(p)    { return this.session.addRect(JSON.stringify(p)); }
  addEllipse(p) { return this.session.addEllipse(JSON.stringify(p)); }
  addText(p)    { return this.session.addText(JSON.stringify(p)); }
  closeBoard(){ return this.session.closeBoard(); }
  setFlexLayout(boardId, opts) { return this.session.setFlexLayout(boardId, JSON.stringify(opts)); }
  setGridLayout(boardId, opts) { return this.session.setGridLayout(boardId, JSON.stringify(opts)); }
  setGrowType(id, mode) { return this.session.setGrowType(id, mode); }
  setConstraints(id, opts) { return this.session.setConstraints(id, JSON.stringify(opts)); }

  createComponent(boardId, opts = {}) { return this.session.createComponent(boardId, JSON.stringify(opts)); }
  instantiateComponent(componentId, opts) { return this.session.instantiateComponent(componentId, JSON.stringify(opts)); }

  // Map families onto a variable font WITH per-family axis settings (wdth/opsz/…).
  // mapping: { "Family Name": { fontId, family, axes: { wdth: 62.5, opsz: 120 } } }.
  // NOTE: this is a whole-file :data transform (not a recorded change), so it does
  // NOT round-trip through commit(); use it with serializeStore()-based persistence
  // (the `pencilpot map-variable` CLI is the supported path for local designs).
  mapFontsToVariable(mapping) { return this.session.mapFontsToVariable(JSON.stringify(mapping)); }
  retargetFonts(mapping)      { return this.session.retargetFonts(JSON.stringify(mapping)); }
  serializeStore()            { return JSON.parse(this.session.serializeStore()); }

  addColorToken(opts) { return this.session.addColorToken(JSON.stringify(opts)); }
  tokens() { return JSON.parse(this.session.tokens()); }

  getFileResponse() { return JSON.parse(this.session.getFileResponse()); }
  validate() { return JSON.parse(this.session.validate()); }
  pendingChanges() { return JSON.parse(this.session.pendingChanges()); }

  /** Validation errors INTRODUCED since checkout: the current validate() output
   *  minus the pre-edit baseline. Empty means the edits broke nothing new
   *  (pre-existing imported-file issues are excluded). This is what gates commit(). */
  newValidationErrors() {
    const baseline = new Set((this.baselineErrs ?? []).map(errKey));
    return this.validate().filter((e) => !baseline.has(errKey(e)));
  }

  async commit({ retries = 1 } = {}) {
    const introduced = this.newValidationErrors();
    if (introduced.length) {
      throw new Error(`refusing to commit changes that INTRODUCE invalidity: ${introduced.map(errKey).join("; ")}`);
    }
    const body = this.session.commitBody(JSON.stringify({ sessionId: randomUUID(), revn: this.revn, vern: this.vern }));
    try {
      const res = await updateFile(body, this.token);
      this.revn = res.revn + 1;          // server returns pre-increment revn
      this.session.clearChanges();        // don't re-send these changes on a later commit
      return res;
    } catch (e) {
      if (retries > 0 && /revn-conflict|vern-conflict/.test(String(e.message))) {
        // append-only changes apply cleanly on any newer revn: just refresh revn/vern and resubmit the SAME recorded changes
        const fresh = await getFile(this.fileId, this.token);
        this.revn = fresh.revn; this.vern = fresh.vern;
        return this.commit({ retries: retries - 1 });
      }
      throw e;
    }
  }
}
