# Copilot Instructions for Dline

Read the project rules before proposing changes:

- `.agents/rules/dline-overview.md` for the current VS Code extension architecture;
- `.agents/rules/engineering-guide.md` for editing, testing, prompt, provider, and generated-code contracts;
- `.agents/rules/storage.md` for persistence ownership;
- `.agents/rules/network.md` for proxy-aware transport requirements;
- `.agents/rules/protobuf-development.md` for Proto and ProtoBus changes.

## Current product boundary

Dline currently ships one VS Code extension from `src/extension.ts` with an embedded React Webview. `src/standalone`, `src/hosts/external`, and standalone projections are retained architecture for a future executable, not the current release surface.

## Build and verification

- Type checking: `npm run check-types`.
- Lint: `npm run lint`.
- Focused Vitest: `npm run test:run -- <test-file>`.
- Proto generation: `npm run protos`; never edit generated projections as source.
- Production bundle: `npm run package`.

Do not use a hand-written `tsc -b` command or start Vitest watch mode for one-shot verification.

## Protobuf and Webview RPC

Proto sources live under `proto/dline/`. Webview RPC uses generated ProtoBus envelopes over VS Code `postMessage`; it is not a network gRPC socket. A contract change normally requires the owning Proto service, regenerated projections, a controller or host handler, a generated client call, and focused transport tests.

## Providers and models

Provider handlers live under `src/core/api/providers/`; runtime model metadata belongs to `src/core/model-registry/`. Use shared proxy-aware transports from `@shared/net` and current analogous providers. Prompt behavior has only Standard and Lite profiles; do not add model-family prompt variants.

## Tools and prompts

Built-in tool identities are declared in `src/shared/tools.ts`. Canonical descriptors live in `src/core/prompts/tools/tool-specs.ts`, ordered memberships in `tool-ids.ts`, and model-visible prose in `src/core/prompts/i18n/en/`. Follow the project `add-new-tool` skill for the complete change chain.

## Storage

Runtime persistence is file-backed through `StorageContext`, `StateManager`, and owning repositories. VS Code `ExtensionContext` is a migration source, not the current authority. Do not add ad-hoc JSON writes or reconstruct storage paths outside their owner.
