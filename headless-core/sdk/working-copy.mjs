import { randomUUID } from "node:crypto";
import { createSession } from "../target/headless/penpot.js";
import { getFile, updateFile } from "./rpc.mjs";

export class WorkingCopy {
  constructor(fileId, token) { this.fileId = fileId; this.token = token; }

  async checkout() {
    const f = await getFile(this.fileId, this.token);
    this.revn = f.revn; this.vern = f.vern; this.features = f.features;
    this.session = createSession(JSON.stringify({ dataTransit: f.dataTransit, fileId: this.fileId, features: f.features }));
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

  addColorToken(opts) { return this.session.addColorToken(JSON.stringify(opts)); }
  tokens() { return JSON.parse(this.session.tokens()); }

  validate() { return JSON.parse(this.session.validate()); }
  pendingChanges() { return JSON.parse(this.session.pendingChanges()); }

  async commit({ retries = 1 } = {}) {
    const errs = this.validate();
    if (errs.length) throw new Error(`refusing to commit invalid file: ${errs.join("; ")}`);
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
