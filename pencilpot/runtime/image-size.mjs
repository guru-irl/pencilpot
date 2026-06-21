// Hand-rolled image-dimension probe (Node built-ins only).
//
//   imageSize(buffer) → { width, height, mtype } | null
//
// Supports PNG, JPEG, GIF and WebP.  Returns null for anything it can't read,
// so callers can fall back to the multipart part's declared content-type.

export function imageSize(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 4) return null;

  // PNG: 0x89 'P' 'N' 'G' … IHDR chunk at byte 12; width@16, height@20 (BE u32).
  if (buf.length >= 24 &&
      buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    if (buf.toString("ascii", 12, 16) === "IHDR") {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), mtype: "image/png" };
    }
    return null;
  }

  // GIF: "GIF87a"/"GIF89a"; logical-screen width@6, height@8 (LE u16).
  if (buf.length >= 10 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
    return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8), mtype: "image/gif" };
  }

  // JPEG: starts FFD8; walk segments to the first SOF marker.
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    const dims = jpegSize(buf);
    return dims ? { ...dims, mtype: "image/jpeg" } : null;
  }

  // WebP: "RIFF"……"WEBP".
  if (buf.length >= 30 &&
      buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") {
    const dims = webpSize(buf);
    return dims ? { ...dims, mtype: "image/webp" } : null;
  }

  return null;
}

function jpegSize(buf) {
  let off = 2; // skip SOI (FFD8)
  const len = buf.length;
  while (off + 9 <= len) {
    if (buf[off] !== 0xff) { off++; continue; }   // resync to next marker
    const marker = buf[off + 1];
    if (marker === 0xff) { off++; continue; }      // fill byte
    // Start-of-Frame markers carry [precision][height:2][width:2].
    const isSOF =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf);
    if (marker === 0xda) break;                    // SOS → entropy data, stop
    const segLen = buf.readUInt16BE(off + 2);
    if (isSOF) {
      return { height: buf.readUInt16BE(off + 5), width: buf.readUInt16BE(off + 7) };
    }
    off += 2 + segLen;                             // next segment
  }
  return null;
}

function webpSize(buf) {
  const format = buf.toString("ascii", 12, 16);
  if (format === "VP8 ") {
    // Lossy: 14-bit width@26, height@28 (LE), masked.
    return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  }
  if (format === "VP8L") {
    // Lossless: after the 0x2f signature byte, 14-bit (width-1) then (height-1).
    const b0 = buf[21], b1 = buf[22], b2 = buf[23], b3 = buf[24];
    return {
      width: 1 + (((b1 & 0x3f) << 8) | b0),
      height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)),
    };
  }
  if (format === "VP8X") {
    // Extended: 24-bit (width-1)@24, (height-1)@27 (LE).
    return {
      width: 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16)),
      height: 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16)),
    };
  }
  return null;
}
