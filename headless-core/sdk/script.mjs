// Run AI-authored JS against the headless working copy in one shot.
// Globals provided: whatever is passed in `bindings` (e.g. wc, helpers) + a capturing console.
export async function runScript(code, bindings = {}) {
  let log = "";
  const console = {
    log: (...a) => { log += a.map(fmt).join(" ") + "\n"; },
    warn: (...a) => { log += "[warn] " + a.map(fmt).join(" ") + "\n"; },
    error: (...a) => { log += "[error] " + a.map(fmt).join(" ") + "\n"; },
  };
  const ctx = { console, ...bindings };
  try {
    const fn = new Function(...Object.keys(ctx), `return (async () => { ${code} })();`);
    const result = await fn(...Object.values(ctx));
    return { ok: true, result, log };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? `${e.name}: ${e.message}` : String(e), log };
  }
}

function fmt(v) {
  if (typeof v === "string") return v;
  try { return JSON.stringify(v); } catch { return String(v); }
}
