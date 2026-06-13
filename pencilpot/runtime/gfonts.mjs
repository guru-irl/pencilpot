/**
 * Google Fonts proxy for Pencilpot runtime.
 *
 * Serves two routes so the Penpot frontend can load Google Fonts
 * without hitting the real googleapis.com from the page (CSP, etc.):
 *
 *   GET /internal/gfonts/css?family=<Family>:<ids>&display=block
 *     Translates the legacy variant-id format to CSS2, fetches the CSS from
 *     fonts.googleapis.com, rewrites font src URLs to /internal/gfonts/font,
 *     and returns text/css.
 *
 *   GET /internal/gfonts/font/*
 *     Proxies the request to fonts.gstatic.com/s/* and streams the font bytes.
 *
 * Legacy → CSS2 translation:
 *   Input:  "Roboto:400,700italic"   (Penpot's internal/gfonts/css?family=... format)
 *   Output: "Roboto:ital,wght@0,400;0,700;1,700"  (CSS2 format)
 *
 *   Rules:
 *     - "regular"   → upright 400   → ital=0, wght=400
 *     - "N"         → upright N     → ital=0, wght=N
 *     - "italic"    → italic 400    → ital=1, wght=400
 *     - "Nitalic"   → italic N      → ital=1, wght=N
 *
 *   CSS2 axis order: alphabetical → ital before wght.
 *   Tuples are sorted ascending (first by ital, then by wght).
 *
 * Caching: responses are cached in memory keyed by URL.
 * Offline: if Google is unreachable, /internal/gfonts/css returns empty CSS
 *   (no crash); /internal/gfonts/font returns 502.
 */

// ── Desktop UA so Google returns woff2 (not woff for old browsers) ────────────
const DESKTOP_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// ── In-memory cache: url → { status, headers, body } ─────────────────────────
const cssCache  = new Map(); // URL string → { text }
const fontCache = new Map(); // URL string → Buffer

// ── Legacy variant-id → CSS2 tuple conversion ─────────────────────────────────

/**
 * Parse one legacy variant id string into { ital, wght }.
 *
 * Examples:
 *   "400"        → { ital: 0, wght: 400 }
 *   "regular"    → { ital: 0, wght: 400 }
 *   "italic"     → { ital: 1, wght: 400 }
 *   "700italic"  → { ital: 1, wght: 700 }
 *   "700"        → { ital: 0, wght: 700 }
 */
function parseLegacyVariant(id) {
  const s = String(id).trim().toLowerCase();
  if (s === "regular") return { ital: 0, wght: 400 };
  if (s === "italic")  return { ital: 1, wght: 400 };

  const italicMatch = s.match(/^(\d+)italic$/);
  if (italicMatch) return { ital: 1, wght: Number(italicMatch[1]) };

  const numMatch = s.match(/^\d+$/);
  if (numMatch) return { ital: 0, wght: Number(s) };

  // Fallback: treat as 400 upright
  return { ital: 0, wght: 400 };
}

/**
 * Translate a family name + array of legacy variant-ids to a CSS2 family spec.
 *
 * legacyToCSS2("Roboto", ["400", "700italic"])
 *   → "Roboto:ital,wght@0,400;0,700;1,700"
 *
 * If no italic variants exist, the output is still ital,wght (CSS2 requires
 * all axes to be listed). This is what Google fonts.googleapis.com accepts.
 *
 * @param {string}   family   Font family name (may contain spaces)
 * @param {string[]} variantIds   Array of legacy variant id strings
 * @returns {string} CSS2 family spec  e.g. "Roboto:ital,wght@0,400;0,700;1,700"
 */
export function legacyToCSS2(family, variantIds) {
  // Parse each id, dedup by (ital,wght), sort ascending.
  const seen = new Set();
  const tuples = [];
  for (const id of variantIds) {
    const { ital, wght } = parseLegacyVariant(id);
    const key = `${ital},${wght}`;
    if (!seen.has(key)) {
      seen.add(key);
      tuples.push({ ital, wght });
    }
  }
  tuples.sort((a, b) => a.ital !== b.ital ? a.ital - b.ital : a.wght - b.wght);

  const tupleStr = tuples.map(({ ital, wght }) => `${ital},${wght}`).join(";");
  return `${family}:ital,wght@${tupleStr}`;
}

/**
 * Parse the `family` query param (legacy format) into a CSS2 family spec.
 *
 * Input:  "Roboto:400,700italic"
 * Output: "Roboto:ital,wght@0,400;0,700;1,700"
 *
 * Also handles bare families (no colon) → treated as 400 upright.
 */
function familyParamToCSS2(familyParam) {
  const colonIdx = familyParam.indexOf(":");
  if (colonIdx === -1) {
    // No variant ids — just the family name; default to regular (400 upright)
    return legacyToCSS2(familyParam, ["regular"]);
  }
  const family   = familyParam.slice(0, colonIdx);
  const variantPart = familyParam.slice(colonIdx + 1);
  const variantIds = variantPart.split(",").map((s) => s.trim()).filter(Boolean);
  if (variantIds.length === 0) variantIds.push("regular");
  return legacyToCSS2(family, variantIds);
}

// ── CSS rewriting ─────────────────────────────────────────────────────────────

/**
 * Rewrite font src URLs in CSS: replace all occurrences of
 * `https://fonts.gstatic.com/s/` with `<origin>/internal/gfonts/font/`.
 *
 * Mirrors what Penpot's process-gfont-css does on the frontend.
 */
function rewriteGstaticUrls(css, origin) {
  return css.replace(
    /https:\/\/fonts\.gstatic\.com\/s\//g,
    `${origin}/internal/gfonts/font/`
  );
}

// ── Public HTTP handlers ──────────────────────────────────────────────────────

/**
 * Handle GET /internal/gfonts/css?family=<Family>:<ids>&display=block
 *
 * Translates the legacy family query to CSS2, fetches from googleapis,
 * rewrites URLs, caches and returns text/css.
 */
export async function handleGfontsCSS(req, res) {
  const url = new URL("http://localhost" + req.url);
  const familyParam = url.searchParams.get("family") || "";
  const display = url.searchParams.get("display") || "swap";

  // Build CSS2 URL
  const css2Family = familyParamToCSS2(familyParam);
  const css2Url = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(css2Family)}&display=${display}`;

  // Cache check
  const origin = `http://${req.headers.host || `localhost`}`;
  const cacheKey = css2Url;

  if (cssCache.has(cacheKey)) {
    const cached = cssCache.get(cacheKey);
    const rewritten = rewriteGstaticUrls(cached, origin);
    res.writeHead(200, { "content-type": "text/css; charset=utf-8", "x-gfonts-cache": "hit" });
    res.end(rewritten);
    return;
  }

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const upstream = await fetch(css2Url, {
      signal: ctrl.signal,
      headers: { "User-Agent": DESKTOP_UA },
    });
    clearTimeout(timer);

    if (!upstream.ok) {
      console.warn(`[pencilpot/gfonts] CSS upstream ${upstream.status} for ${css2Url}`);
      res.writeHead(200, { "content-type": "text/css; charset=utf-8" });
      res.end("/* pencilpot: gfonts upstream error */");
      return;
    }

    const cssText = await upstream.text();
    cssCache.set(cacheKey, cssText);

    const rewritten = rewriteGstaticUrls(cssText, origin);
    res.writeHead(200, { "content-type": "text/css; charset=utf-8" });
    res.end(rewritten);
  } catch (err) {
    // Offline or network error — return empty CSS, don't crash.
    console.warn(`[pencilpot/gfonts] CSS fetch failed (offline?): ${err.message}`);
    res.writeHead(200, { "content-type": "text/css; charset=utf-8" });
    res.end("/* pencilpot: gfonts offline */");
  }
}

/**
 * Handle GET /internal/gfonts/font/*
 *
 * Proxies the request to https://fonts.gstatic.com/s/* and streams the bytes.
 * The path segment after /internal/gfonts/font/ is the gstatic path.
 */
export async function handleGfontsFont(req, res) {
  const prefix = "/internal/gfonts/font/";
  const gstaticPath = req.url.startsWith(prefix)
    ? req.url.slice(prefix.length)
    : req.url.replace(/.*\/internal\/gfonts\/font\//, "");

  const upstreamUrl = `https://fonts.gstatic.com/s/${gstaticPath}`;

  // Cache check
  if (fontCache.has(upstreamUrl)) {
    const { contentType, buf } = fontCache.get(upstreamUrl);
    res.writeHead(200, { "content-type": contentType, "cache-control": "public, max-age=31536000, immutable" });
    res.end(buf);
    return;
  }

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    const upstream = await fetch(upstreamUrl, {
      signal: ctrl.signal,
      headers: { "User-Agent": DESKTOP_UA },
    });
    clearTimeout(timer);

    if (!upstream.ok) {
      console.warn(`[pencilpot/gfonts] font upstream ${upstream.status} for ${upstreamUrl}`);
      res.writeHead(upstream.status);
      res.end();
      return;
    }

    const contentType = upstream.headers.get("content-type") || "font/woff2";
    const arrayBuf = await upstream.arrayBuffer();
    const buf = Buffer.from(arrayBuf);
    fontCache.set(upstreamUrl, { contentType, buf });

    res.writeHead(200, {
      "content-type": contentType,
      "cache-control": "public, max-age=31536000, immutable",
    });
    res.end(buf);
  } catch (err) {
    console.warn(`[pencilpot/gfonts] font fetch failed: ${err.message}`);
    res.writeHead(502);
    res.end("gfonts font proxy error");
  }
}
