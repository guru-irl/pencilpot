# Pencilpot — Architecture Docs

Living architecture notes for the Pencilpot programme. One doc lands per phase; each is updated as implementation evolves.

| Doc | Phase | Topic |
|---|---|---|
| [00-phase0-spike.md](00-phase0-spike.md) | Phase 0 | Viability spike: proxy/record/replay/serve design, chokepoint insight, RPC contract, disk store, GO decision |
| [01-runtime-store.md](01-runtime-store.md) | Phase 1 | EDN store format (project layout, manifest, per-page/component EDN, tokens-lib), engine API (serializeStore/loadStore/bumpRevn), runtime RPC handler table, shared-library resolution, revn lifecycle |

More docs land here as Phase 2 (F · frontend strip), Phase 3 (D · desktop shell), and Phase 4 (T · terminal + AI) are implemented.
