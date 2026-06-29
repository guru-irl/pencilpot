import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createSession } from "../target/headless/penpot.js";
import { getFile, updateFile, BASE } from "./rpc.mjs";

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
  // Replace a component instance with an instance of a different component.
  swapComponent(instanceId, newComponentId) { return this.session.swapComponent(instanceId, newComponentId); }
  // Detach an instance from its component (becomes a plain shape tree).
  detachInstance(instanceId) { return this.session.detachInstance(instanceId); }
  // Promote a component instance into a variant set (variant-container); returns the container id.
  makeVariant(instanceId, opts = {}) { return this.session.makeVariant(instanceId, JSON.stringify(opts)); }
  // Add a sibling variant to an existing variant set; returns the new variant instance id.
  addVariant(variantShapeId) { return this.session.addVariant(variantShapeId); }
  // Group existing shapes (sharing a parent) into a new group; returns the group id.
  groupShapes(ids, opts = {}) { return this.session.groupShapes(JSON.stringify(ids), JSON.stringify(opts)); }
  // Dissolve a group, lifting its children back to the group's parent.
  ungroupShape(groupId) { return this.session.ungroupShape(groupId); }

  // Add a prototype interaction to a shape. opts:
  //   { shapeId, destination?, eventType?="click", actionType?="navigate", preserveScroll? }
  // The common case is a click->navigate: addInteraction({ shapeId, destination: <frameId> }).
  // Returns the created interaction map.
  addInteraction(opts) { return JSON.parse(this.session.addInteraction(JSON.stringify(opts))); }

  // --- editing EXISTING shapes (structural control, not append-only) ---------
  // Merge attributes onto existing shapes (fills/strokes/opacity/rotation/name/
  // blend-mode/constraints-h/v/rx/ry/r1..r4/hidden/blocked/proportion-lock/…).
  updateShape(id, attrs)   { return this.session.updateShapes(JSON.stringify([id]), JSON.stringify(attrs)); }
  updateShapes(ids, attrs) { return this.session.updateShapes(JSON.stringify(ids), JSON.stringify(attrs)); }
  // Delete shapes (and descendants). Component-copy children are hidden, not deleted.
  deleteShape(id)   { return this.session.deleteShapes(JSON.stringify([id])); }
  deleteShapes(ids) { return this.session.deleteShapes(JSON.stringify(ids)); }
  // Reparent a shape under a new board/group/frame at an optional index.
  reparentShape(id, parentId, { index } = {}) { return this.session.reparentShape(id, JSON.stringify({ parentId, index })); }
  // Change z-order within the current parent.
  reorderShape(id, index) { return this.session.reorderShape(id, JSON.stringify({ index })); }
  // Move a shape (and its subtree) to an absolute {x,y} or by a relative {dx,dy}.
  moveShape(id, opts) { return this.session.moveShape(id, JSON.stringify(opts)); }
  // Resize a shape to {width?,height?}; children reflow via the modifier engine.
  resizeShape(id, opts) { return this.session.resizeShape(id, JSON.stringify(opts)); }
  rotateShape(id, opts) { return this.session.rotateShape(id, JSON.stringify(opts)); }
  renderShape(id) { return this.session.renderShape(id); }

  // Compact, navigable index of the WHOLE file (pages -> boards/text/instances,
  // plus components + their variants) so you can locate "where's what" without
  // reading the on-disk EDN. MCP `outline`.
  outline() { return JSON.parse(this.session.outline()); }

  // What the user is currently looking at / has selected in the OPEN editor
  // (reported by the SPA to the runtime). Returns {pageId,pageName,selected:[ids],
  // shapes:[{id,name,type}],ts}. selected is empty when nothing is selected.
  async viewport() {
    const res = await fetch(`${BASE}/pencilpot/viewport`, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`viewport -> HTTP ${res.status}`);
    return res.json();
  }
  // Rasterize a shape's SVG to PNG natively (no browser) via the system rsvg-convert
  // (librsvg) or ImageMagick — both standard. scale multiplies pixel size (default 1).
  // Returns the written PNG path. Throws if the shape has no renderable SVG.
  renderShapePng(id, { scale = 1, out } = {}) {
    const svg = this.session.renderShape(id);
    if (!svg || !svg.startsWith("<svg")) throw new Error(`renderShapePng: no SVG for shape ${id}`);
    const png = out || path.join(os.tmpdir(), `pencilpot-${id}-${Date.now()}.png`);
    const svgPath = png.replace(/\.png$/, "") + ".svg";
    fs.writeFileSync(svgPath, svg);
    try {
      if (spawnSync("rsvg-convert", ["-z", String(scale), "-f", "png", svgPath, "-o", png]).status !== 0)
        spawnSync("magick", [svgPath, "-resize", `${scale * 100}%`, png]);
      if (!fs.existsSync(png)) throw new Error("rasterizer produced no output (need rsvg-convert or magick)");
      return png;
    } finally { try { fs.unlinkSync(svgPath); } catch {} }
  }

  // High-fidelity rasterize INCLUDING text. `renderShape` emits text as
  // foreignObject HTML (no browser-computed position-data under headless SSR),
  // which librsvg ignores — so for pixel-accurate text we rasterize through the
  // Chromium that Playwright ships. Pass `fontsDir` (a pencilpot fonts/ store) to
  // embed the design's custom families as @font-face. Async; returns the PNG path.
  async renderShapePngHiFi(id, { scale = 2, out, fontsDir } = {}) {
    const svg = this.session.renderShape(id);
    if (!svg || !svg.startsWith("<svg")) throw new Error(`renderShapePngHiFi: no SVG for shape ${id}`);
    const { rasterizeSvg } = await import("./hifi-raster.mjs");
    return rasterizeSvg({ svg, out, scale, fontsDir, id });
  }

  // Map families onto a variable font WITH per-family axis settings (wdth/opsz/…).
  // mapping: { "Family Name": { fontId, family, axes: { wdth: 62.5, opsz: 120 } } }.
  // NOTE: this is a whole-file :data transform (not a recorded change), so it does
  // NOT round-trip through commit(); use it with serializeStore()-based persistence
  // (the `pencilpot map-variable` CLI is the supported path for local designs).
  mapFontsToVariable(mapping) { return this.session.mapFontsToVariable(JSON.stringify(mapping)); }
  retargetFonts(mapping)      { return this.session.retargetFonts(JSON.stringify(mapping)); }
  serializeStore()            { return JSON.parse(this.session.serializeStore()); }

  addColorToken(opts) { return this.session.addColorToken(JSON.stringify(opts)); }
  // Design token of ANY type: { set?, name, type?="color", value }.
  addToken(opts) { return this.session.addToken(JSON.stringify(opts)); }
  // Bind an existing token (by name) to shape attributes: applyToken(id, { token, attributes:[…] }).
  applyToken(id, opts) { return this.session.applyToken(id, JSON.stringify(opts)); }
  unapplyToken(id, attributes) { return this.session.unapplyToken(id, JSON.stringify({ attributes })); }
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
