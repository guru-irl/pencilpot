import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMultipart } from "../runtime/multipart.mjs";

const BOUNDARY = "----pencilpotBoundaryXYZ";
const CT = `multipart/form-data; boundary=${BOUNDARY}`;

// Build a multipart body the way a browser FormData POST would, so the parser
// is exercised against a realistic byte layout (CRLF line endings, a trailing
// CRLF before each boundary, and the `--boundary--` terminator).
function buildBody(parts, boundary = BOUNDARY) {
  const chunks = [];
  for (const p of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    if (p.filename !== undefined) {
      chunks.push(Buffer.from(
        `Content-Disposition: form-data; name="${p.name}"; filename="${p.filename}"\r\n`));
      chunks.push(Buffer.from(`Content-Type: ${p.contentType}\r\n\r\n`));
      chunks.push(Buffer.isBuffer(p.bytes) ? p.bytes : Buffer.from(p.bytes));
      chunks.push(Buffer.from("\r\n"));
    } else {
      chunks.push(Buffer.from(`Content-Disposition: form-data; name="${p.name}"\r\n\r\n`));
      chunks.push(Buffer.from(String(p.value)));
      chunks.push(Buffer.from("\r\n"));
    }
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(chunks);
}

test("parses text fields + a binary file part with exact bytes", () => {
  // A file body that itself contains CRLF + a `--` sequence, to prove the parser
  // slices on the real boundary and not on incidental bytes.
  const fileBytes = Buffer.from([0x89, 0x50, 0x0d, 0x0a, 0x2d, 0x2d, 0xff, 0x00, 0x10]);
  const body = buildBody([
    { name: "file-id", value: "abc-123" },
    { name: "name", value: "My Cover" },
    { name: "is-local", value: "true" },
    { name: "content", filename: "cover.png", contentType: "image/png", bytes: fileBytes },
  ]);

  const { fields, file } = parseMultipart(body, CT);

  assert.equal(fields["file-id"], "abc-123");
  assert.equal(fields["name"], "My Cover");
  assert.equal(fields["is-local"], "true");
  assert.ok(file, "file part captured");
  assert.equal(file.filename, "cover.png");
  assert.equal(file.mtype, "image/png");
  assert.ok(file.bytes.equals(fileBytes),
    "file bytes are exact (trailing CRLF stripped, no boundary bleed)");
});

test("handles a quoted filename containing spaces", () => {
  const body = buildBody([
    { name: "content", filename: "my cover art.jpg", contentType: "image/jpeg", bytes: Buffer.from([1, 2, 3]) },
  ]);
  const { file } = parseMultipart(body, CT);
  assert.equal(file.filename, "my cover art.jpg");
  assert.ok(file.bytes.equals(Buffer.from([1, 2, 3])));
});

test("reads the boundary from a quoted content-type header", () => {
  const body = buildBody([
    { name: "content", filename: "a.png", contentType: "image/png", bytes: Buffer.from([7]) },
  ]);
  const { file } = parseMultipart(body, `multipart/form-data; boundary="${BOUNDARY}"`);
  assert.ok(file, "quoted boundary resolves");
  assert.ok(file.bytes.equals(Buffer.from([7])));
});

test("strips exactly the trailing CRLF, preserving an internal trailing newline byte", () => {
  // body ends with a real 0x0a that is part of the content; only the delimiter
  // CRLF should be removed.
  const fileBytes = Buffer.from([0x61, 0x0a, 0x62]); // "a\nb"
  const body = buildBody([
    { name: "content", filename: "f.bin", contentType: "application/octet-stream", bytes: fileBytes },
  ]);
  const { file } = parseMultipart(body, CT);
  assert.ok(file.bytes.equals(fileBytes), "internal bytes intact, only delimiter CRLF removed");
});

test("missing boundary in content-type throws", () => {
  assert.throws(() => parseMultipart(Buffer.from("x"), "multipart/form-data"),
    /boundary/i);
});
