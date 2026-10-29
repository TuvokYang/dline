# Vendored Tree-sitter Runtime

This directory makes `verify-architecture-diagrams` self-contained. It contains:

- `tree-sitter.js` and `tree-sitter.wasm` from `web-tree-sitter` 0.22.6 (MIT);
- selected language grammar WASM files from `tree-sitter-wasms` 0.1.13 (Unlicense);
- architecture-query starting points copied from Dline's Tree-sitter service.

The Skill does not import `src/services/tree-sitter`, root `node_modules`, product package scripts, or product tests at runtime.

Enabled source extensions are declared only in `scripts/lib/tree-sitter-runtime.mjs`. Query sources are registered by language and category in `queries/index.mjs`; `scripts/lib/tree-sitter-facts.mjs` is the only owner of normalized paths, source positions, diagnostics, stable fact ids, bounded capture text and deterministic cross-file ordering. The Swift grammar remains vendored but is runtime-quarantined because `web-tree-sitter` 0.22.6 plus this grammar triggers a native Zone OOM on Node 24 shutdown; `.swift` is therefore reported unsupported/unverifiable instead of crashing or using a subprocess provider. Add or re-enable a language only after its grammar, all query categories and process lifecycle pass an isolated fixture test. Syntax support is not semantic proof: unsupported or ambiguous relationships must be reported as unverifiable.
