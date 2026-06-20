# `penpot-headless` MCP server

Headless Penpot editing over stdio. Check out a file into an in-memory working
copy, edit it with JS or dedicated tools, validate with Penpot's own validator,
then commit. No browser, no manual transit wrangling.

## Run

```bash
node headless-core/mcp/server.mjs        # stdio transport
```

Environment:

- `PENPOT_HL_BASE` — base URL of the Penpot/pencilpot backend (`checkout`/`commit` target).
- `PENPOT_TOKEN` — access token for that backend.

## Register with an MCP client

```jsonc
// e.g. Claude Desktop / Cursor mcpServers config
{
  "mcpServers": {
    "penpot-headless": {
      "command": "node",
      "args": ["/mnt/data/src/penpot/headless-core/mcp/server.mjs"],
      "env": { "PENPOT_HL_BASE": "http://localhost:7890", "PENPOT_TOKEN": "<token>" }
    }
  }
}
```

> pi itself has no MCP host (by design — it favours CLI tools + skills). When
> running under pi, use the **`pencilpot` CLI** below; the MCP is for MCP-capable
> clients.

## Tools

| Tool | Purpose |
|------|---------|
| `checkout(fileId)` | Load a file into a working copy. |
| `script(code)` | Run JS against `wc` (addBoard/addRect/addEllipse/addText/closeBoard/validate/pendingChanges, plus `wc.retargetFonts` / `wc.mapFontsToVariable`). |
| `scene()` | Object map (id → shape). |
| `map_fonts_variable(mapping)` | Map families onto a **variable font** with per-family axis settings (wdth/opsz/GRAD/ROND/slnt) and strip stale position-data. |
| `validate()` | Penpot validator (empty array = valid). |
| `status()` | Pending change count + revn. |
| `commit()` / `discard()` | Persist / reset. |

### `map_fonts_variable` mapping shape

```jsonc
{
  "Google Sans Flex Compressed": { "fontId": "custom-google-sans-flex", "family": "Google Sans Flex", "axes": { "wdth": 62.5 } },
  "Bebas Neue":                  { "fontId": "custom-google-sans-flex", "family": "Google Sans Flex", "axes": { "wdth": 50 } }
}
```

**Persistence note:** `map_fonts_variable` / `wc.mapFontsToVariable` is a whole-file
`:data` transform, *not* a recorded change, so it does **not** round-trip through
`commit()`. For local pencilpot designs, persist with the CLI:

```bash
pencilpot map-variable <project.pencil> \
  --font-id custom-google-sans-flex --var-family "Google Sans Flex" \
  --map "Google Sans Flex Compressed=wdth:62.5" \
  --map "Bebas Neue=wdth:50" \
  --map "Google Sans Flex Wide=wdth:125,opsz:120"
```

The CLI loads the design, applies the same engine transform
(`session.mapFontsToVariable`), validates, and writes the canonical EDN back —
the supported path for bulk variable-font remapping on disk.

## Related CLI font commands

- `pencilpot fonts <project>` — list registered fonts + report missing families.
- `pencilpot retarget-fonts <project> --family "Name=fontId"` — consolidate
  duplicate font-ids per family (no axis changes).
- `pencilpot map-variable <project> --font-id <id> --map "Family=wdth:..,opsz:.."`
  — map families onto a variable font with per-family axes (realises true
  Condensed/Compressed/Wide widths that static instances can't express; folds
  non-Google families onto the variable font). Strips stale position-data so the
  new widths re-layout on load.
