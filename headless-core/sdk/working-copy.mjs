import { randomUUID } from "node:crypto";
import { createSession } from "../target/headless/penpot.js";
import { getFile, updateFile } from "./rpc.mjs";

export class WorkingCopy {
  constructor(fileId, token) { this.fileId = fileId; this.token = token; this._ops = []; }

  async checkout() {
    const f = await getFile(this.fileId, this.token);
    this.revn = f.revn; this.vern = f.vern; this.features = f.features;
    this.session = createSession(JSON.stringify({ dataTransit: f.dataTransit, fileId: this.fileId, features: f.features }));
    this._ops = [];
    return this;
  }

  _do(method, payload) { this._ops.push([method, payload]); return this.session[method](payload === undefined ? undefined : JSON.stringify(payload)); }
  addBoard(p) { return this._do("addBoard", p); }
  addRect(p)  { return this._do("addRect", p); }
  closeBoard(){ return this._do("closeBoard", undefined); }

  validate() { return JSON.parse(this.session.validate()); }
  pendingChanges() { return JSON.parse(this.session.pendingChanges()); }

  async commit({ retries = 1 } = {}) {
    const errs = this.validate();
    if (errs.length) throw new Error(`refusing to commit invalid file: ${errs.join("; ")}`);
    const body = this.session.commitBody(JSON.stringify({ sessionId: randomUUID(), revn: this.revn, vern: this.vern }));
    try {
      const res = await updateFile(body, this.token);
      this.revn = res.revn + 1;
      return res;
    } catch (e) {
      if (retries > 0 && /revn-conflict|vern-conflict/.test(String(e.message))) {
        const ops = this._ops.slice();
        await this.checkout();
        for (const [m, p] of ops) this.session[m](p === undefined ? undefined : JSON.stringify(p));
        this._ops = ops;
        return this.commit({ retries: retries - 1 });
      }
      throw e;
    }
  }
}
