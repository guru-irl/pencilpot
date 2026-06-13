/**
 * Import a .penpot binary file into a running penpot-hl instance.
 *
 * Posts the file to /api/rpc/command/import-binfile as multipart,
 * streams the SSE response, and extracts the new file-id from the
 * final `event: end` payload.
 *
 * SSE format:
 *   event: progress
 *   data: {"~:section":"~:manifest"} ...
 *
 *   event: end
 *   data: ["~u<uuid>"]          ← array of new file IDs in transit format
 *
 * The `~u` prefix is penpot's transit encoding for UUID; we strip it.
 *
 * @param {string} filePath   absolute path to the .penpot file
 * @param {{ instance: string, token: string, projectId: string, name: string }} opts
 * @returns {Promise<string>}  new file-id (plain UUID string)
 */
export async function importBinfile(filePath, { instance, token, projectId, name }) {
  const { createReadStream } = await import("node:fs");
  const { FormData, File } = await import("node:buffer").then(() => globalThis);

  // Build the multipart form
  const form = new FormData();
  form.append("project-id", projectId);
  form.append("name", name);
  form.append("version", "3");

  // Attach the .penpot binary
  const { readFileSync } = await import("node:fs");
  const fileBytes = readFileSync(filePath);
  const blob = new Blob([fileBytes], { type: "application/octet-stream" });
  const fileName = filePath.split("/").pop();
  form.append("file", blob, fileName);

  const url = `${instance}/api/rpc/command/import-binfile`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Token ${token}`,
      "Accept": "text/event-stream",
    },
    body: form,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`import-binfile HTTP ${res.status}: ${text.slice(0, 500)}`);
  }

  // Parse the SSE stream line by line, looking for "event: end"
  const text = await res.text();
  const lines = text.split("\n");

  let inEndEvent = false;
  for (const line of lines) {
    const trimmed = line.trimEnd();
    if (trimmed === "event: end") {
      inEndEvent = true;
      continue;
    }
    if (inEndEvent && trimmed.startsWith("data: ")) {
      const payload = trimmed.slice(6);
      // payload is a transit JSON array like ["~u<uuid>", ...]
      // Parse and strip the "~u" transit UUID prefix
      const arr = JSON.parse(payload);
      if (Array.isArray(arr) && arr.length > 0) {
        const raw = arr[0];
        // Transit UUID encoding: "~u<uuid-string>"
        return typeof raw === "string" && raw.startsWith("~u")
          ? raw.slice(2)
          : raw;
      }
      break;
    }
    // Reset if we see a blank line after a non-end event
    if (trimmed === "" && inEndEvent) {
      inEndEvent = false;
    }
  }

  throw new Error(`import-binfile: no 'event: end' payload found in SSE response.\nResponse tail:\n${lines.slice(-10).join("\n")}`);
}
