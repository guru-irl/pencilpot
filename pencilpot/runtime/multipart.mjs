// Hand-rolled multipart/form-data parser (Node built-ins only).
//
// Scoped to the single-file uploads penpot makes: one file part (the image
// blob, field name `content`) plus a few simple text fields (file-id, name,
// is-local).  Not a general-purpose RFC-7578 implementation.
//
//   parseMultipart(buffer, contentTypeHeader)
//     → { fields: {<name>: <string>, …}, file: { filename, mtype, bytes } | null }

const CRLFCRLF = Buffer.from("\r\n\r\n");

function getBoundary(contentTypeHeader) {
  if (!contentTypeHeader) return null;
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentTypeHeader);
  if (!m) return null;
  return (m[1] ?? m[2] ?? "").trim();
}

function parseHeaders(headerText) {
  const headers = {};
  for (const line of headerText.split("\r\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
  }
  return headers;
}

// Extract name= / filename= from a Content-Disposition header value (quoted or bare).
function parseDisposition(value) {
  const nameM = /name="([^"]*)"|name=([^;]+)/i.exec(value);
  const fileM = /filename="([^"]*)"|filename=([^;]+)/i.exec(value);
  return {
    name: nameM ? (nameM[1] ?? nameM[2] ?? "").trim() : null,
    filename: fileM ? (fileM[1] ?? fileM[2] ?? "").trim() : null,
  };
}

export function parseMultipart(buffer, contentTypeHeader) {
  const boundary = getBoundary(contentTypeHeader);
  if (!boundary) throw new Error("multipart: no boundary in content-type header");

  const delimiter = Buffer.from(`--${boundary}`);
  const fields = {};
  let file = null;

  // Index every delimiter occurrence; parts live between consecutive delimiters.
  const positions = [];
  let from = 0;
  for (;;) {
    const idx = buffer.indexOf(delimiter, from);
    if (idx === -1) break;
    positions.push(idx);
    from = idx + delimiter.length;
  }

  for (let i = 0; i < positions.length - 1; i++) {
    let start = positions[i] + delimiter.length;
    // `--boundary--` terminator → no more parts.
    if (buffer[start] === 0x2d && buffer[start + 1] === 0x2d) break;
    // Skip the CRLF that follows the delimiter line.
    if (buffer[start] === 0x0d && buffer[start + 1] === 0x0a) start += 2;

    // Part ends just before the next delimiter; drop the CRLF preceding it.
    let end = positions[i + 1];
    if (buffer[end - 2] === 0x0d && buffer[end - 1] === 0x0a) end -= 2;
    if (end < start) continue;

    // Header block / body split on the first blank line.
    const headerEnd = buffer.indexOf(CRLFCRLF, start);
    if (headerEnd === -1 || headerEnd >= end) continue;
    const headers = parseHeaders(buffer.slice(start, headerEnd).toString("utf8"));
    const body = buffer.slice(headerEnd + CRLFCRLF.length, end);

    const { name, filename } = parseDisposition(headers["content-disposition"] || "");
    if (filename != null) {
      file = {
        filename,
        mtype: headers["content-type"] || "application/octet-stream",
        bytes: body,
      };
    } else if (name != null) {
      fields[name] = body.toString("utf8");
    }
  }

  return { fields, file };
}
