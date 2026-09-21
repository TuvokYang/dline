# Storage Ownership and Durability

Dline storage belongs to the VS Code extension runtime and is intentionally isolated from VS Code `ExtensionContext`. It is not one JSON directory. Every persistent value must have one explicit owner, scope, root, consistency model, migration path, and cleanup path.

## Root model

Dline intentionally resolves three independent roots:

| Root | Resolver and override | Primary contents |
| --- | --- | --- |
| State/data root | `getDlineDataDir()`; `<DLINE_DIR>/data` or `~/.dline/data` | Global state, canonical settings, workspace state/settings, profile catalog, and secrets |
| Resource home | `getDlineHomePath()`; `DLINE_HOME_DIR` or `~/.dline` | Provider metadata, cache, Puppeteer data, and other non-document resources |
| Documents root | `getDlineDocumentsPath()`; `DLINE_DOCS_DIR` or the operating-system Documents directory plus `dline` | Tasks, task-history database, global capabilities, hooks, MCP descriptors, and checkpoints |

`DLINE_DIR` and `DLINE_HOME_DIR` happen to resolve under `~/.dline` by default, but they are separate override contracts. `DLINE_DOCS_DIR` is already the final Dline documents root; do not append another `dline` segment to an explicit override.

The synchronous documents resolver depends on startup cache warm-up to discover the platform Documents directory. Host startup must call `warmupDocumentsPathCache()` before synchronous consumers. Tests that need full isolation should set `DLINE_DIR`, `DLINE_HOME_DIR`, and `DLINE_DOCS_DIR`; overriding only one root does not isolate the others.

`StorageContextOptions.clineDir` is a compatibility/test injection boundary. When supplied, it places state below `<clineDir>/data` and the TaskHistory paths below `<clineDir>/tasks`; normal task artifact helpers still resolve through the documents root. Do not use this option as evidence that production roots are co-located.

## Current layouts

The state/data root is approximately:

```text
<data-root>/
├── globalState.json
├── secrets.json
├── settings/
│   ├── settings.json
│   └── api_profiles.json
├── secrets/
│   ├── api_keys.json
│   ├── provider_secrets.json
│   └── profile-specific credential documents
└── workspaces/
    └── <workspace-hash>/
        ├── workspaceState.json
        └── settings.json
```

The documents root is approximately:

```text
<documents-root>/
├── tasks/
│   ├── taskHistory.db
│   └── <task-id>/
├── rules/
├── workflows/
├── skills/
├── subagents/
├── mcp/
├── hooks/
├── settings/
│   └── mcp_settings.json
└── checkpoints/
```

The resource home currently owns `providers/`, `cache/`, and `puppeteer/`. Cached marketplace and remote-configuration documents belong to the cache owner and are not canonical settings.

Workspace capabilities are separate from persistent runtime state. Current project capability roots include `.agents/rules`, `.agents/workflows`, `.agents/skills`, and `.agents/subagents`; project hooks and MCP/plugin descriptors live under `.dline`. Legacy compatibility roots may still be scanned, but new Dline content must use the current roots.

## StorageContext

`createStorageContext()` is the process boundary for global key-value state, settings paths, secrets, workspace storage, and TaskHistory paths. Callers receive resolved paths and store interfaces; they must not reconstruct these paths independently.

Workspace storage uses either an explicit `workspaceStorageDir` supplied by a host or a hash-derived directory below the state/data root. `workspaceId` is a SHA-256-derived, non-sensitive identity of the normalized resolved workspace storage boundary. Do not expose or persist the original workspace path when the stable identity is sufficient.

## State ownership

`StateManager` owns the process caches and routes each category to its real authority:

| Category | Authority | Durability |
| --- | --- | --- |
| Non-setting global state | `globalState.json` through the StorageContext backing store | Batched/debounced, with explicit flush and shutdown barriers |
| Global settings | Revisioned `SettingsRepository` over `settings/settings.json` | Cross-process file lock, read-latest mutation, atomic temp/rename, watcher reconciliation |
| Workspace settings | A separate `SettingsRepository` over `workspaces/<hash>/settings.json` | Same strong consistency as global settings; never merged into `workspaceState.json` |
| Workspace state | `workspaces/<hash>/workspaceState.json` | Batched/debounced key-value persistence |
| Task settings | `tasks/<task-id>/settings.json` | Per-task cache and atomic read/merge/temp/rename writes |
| Session overrides | `StateManager` memory only | Never persisted |
| Remote configuration | Remote-config cache plus runtime overlay | Cached data is not the remote authority |
| Typed StateManager secrets | Root `secrets.json`, owner-only mode | Batched through the secret APIs |
| Profile API keys and provider credentials | Specialized stores under `data/secrets/` | Owner-only mode; keyed by stable profile identity |
| API profile catalog | `settings/api_profiles.json` through `ProfileCatalogRepository` | Stable-ID merge against latest disk state, cross-process lock, watcher reconciliation |

Do not use `StorageContext.settings` as a generic flat settings map. Canonical settings writes go through `SettingsRepository` or the corresponding `StateManager` mutation API so revisions and cross-instance reconciliation remain intact.

## Setting and capability scopes

General task-aware setting resolution is:

```text
remote configuration
  -> session override
  -> explicit task setting
  -> canonical global setting
  -> temporary legacy fallback during migration
  -> declared default
```

Canonical global reads deliberately exclude task state. `autoApprovalSettings` is a live global permission and must not be shadowed by a historical task snapshot.

Capability toggle maps use explicit sparse scopes rather than one merged settings object:

```text
global override -> workspace override -> task override
```

An absent resource key means “inherit”, not “disabled”. Discovery is read-only and must never populate toggle maps. Use `getScopedCapabilityToggles()` and `mutateScopedCapabilityToggles()` for explicit scope access; routing workspace or task updates through generic global APIs collapses the scope chain.

## Multi-instance behavior

Dline can have multiple windows and hosts writing the same storage boundary.

- `SettingsRepository` serializes in-process operations, locks the file across processes, reads the latest disk revision while locked, atomically replaces the document, and watches for external commits.
- `ProfileCatalogRepository` merges one client's stable-ID diff into the latest catalog while locked, then broadcasts external catalog changes.
- `TaskHistory` watches both `taskHistory.db` and its WAL, coalesces reload notifications, and drains queued metadata writes at durability boundaries.
- Buffered JSONL message stores stage transient updates in memory and expose explicit flush/close barriers. Do not assume every in-memory streaming update is already durable.
- `StateManager.flushPendingState()` drains repeated batches until no mutations remain; shutdown rejects new mutations before the final drain.

Never replace a shared document with a stale full-file snapshot. Use the owning repository's mutation API.

## Task history

`tasks/taskHistory.db` is the current task index. It is one SQLite database per storage boundary, opened through the UnifyStore backend. Task ID is the primary key, so current reads are deduplicated by construction.

Task metadata writes may be queued off the UI hot path. Call `TaskHistory.flush()` when a lifecycle boundary requires durability. Completion projection updates are revision-aware transactional patches and must not be recreated as ordinary metadata overwrites.

Legacy `taskHistory.jsonl` and `taskHistory.json` functions remain migration/compatibility paths only. On initialization, absence of `taskHistory.db` is the one-time import marker; once the database exists, the legacy files are not the runtime authority.

## Per-task storage

A task directory can contain:

```text
tasks/<task-id>/
├── ui_messages.jsonl
├── api_conversation_history.jsonl
├── snapshot.json
├── context.json
├── context_history.jsonl
├── settings.json
├── task_metadata.json
├── activities.json
├── <task-id>.db
├── artifacts/
└── tmp/
    ├── command-logs/
    ├── shell-diagnostics/
    ├── image-previews/
    └── image-viewer/
```

Ownership matters more than the physical filename:

- `UIMessage` owns `ui_messages.jsonl` through the buffered JSONL backend. Partial messages may exist only in memory; complete/finalized messages and lifecycle flushes establish durability.
- `ApiConversation` owns `api_conversation_history.jsonl`, normalizes legacy identity, and guarantees usable unique timestamps for indexed operations.
- `TaskSnapshotPersistence` owns coalesced atomic `snapshot.json` writes used for snapshot-first recovery. Runtime transitions, interactions, activities, and snapshots must agree; one file is not a substitute for the others.
- Task context helpers own `context.json` and `context_history.jsonl`.
- `TaskActivityPersistence` owns schema-versioned `activities.json`; runtime cancellers are intentionally not serialized.
- The per-task `<task-id>.db` is a shared SQLite container for UnifyStore collections such as API rate metrics and API request/response execution data.
- `api_rate_metrics.jsonl` is a legacy migration source. Current metrics belong in the per-task database, with a durable fingerprinted migration marker that rejects changed or ambiguous sources.
- Artifact APIs own `artifacts/` and enforce task-relative paths. Do not expose conversation, snapshot, settings, or database files through the artifact read scope.
- `src/core/storage/task-temp.ts` owns `tmp/` and is the only source of that path. Command logs and shell diagnostics belong to the owning task; `command-logs` survives across sessions because chat rows and Activities keep a clickable path to it, so age alone never deletes a log. It is bounded only by a per-task total size budget enforced on the locked task, which drops the oldest logs first. `image-previews` and `image-viewer` stay process-ephemeral. Command execution without a task identity keeps using the process-level temp directory owned by `DlineRuntimeFileManager`, which also retains pre-migration logs.

Do not read or rewrite task files directly from controllers or UI code when an owning store exists. Task deletion must go through the task deletion coordinator so locks, active controllers, panels, TaskHistory, known databases, WAL/SHM files, and checkpoint ownership are handled coherently. When adding a task-owned file or directory, update deletion/recovery ownership explicitly; do not assume removing the task directory will succeed while unknown contents remain.

## Migration boundaries

Migration is directional and fail-safe:

1. VS Code bootstrap may read legacy `ExtensionContext` global state, workspace state, and secrets and export them into `StorageContext`.
2. Global and workspace migration use independent version sentinels so a newly opened workspace can migrate without replaying global migration.
3. Existing file-backed values win over legacy VS Code values; failed batches do not advance their sentinel.
4. `StateManager` migrates supported settings out of legacy global state into the revisioned settings document, then removes legacy duplicates only after the canonical document owns them.
5. TaskHistory imports legacy JSONL only when the SQLite database is absent.
6. UI/API message stores import legacy JSON files only when the current JSONL target is absent, then normalize legacy identities.
7. API rate metrics import legacy JSONL into the per-task database with integrity checks and an idempotent marker.

Legacy sources may be preserved as backup/import evidence. New runtime behavior must never restore a second read path that competes with the current authority.

## Adding or changing persistent state

1. Identify the owner, root, scope, authority, consistency requirement, and cleanup path before adding a field or file.
2. Add a key to `state-keys.ts` only when the value truly belongs to StateManager-managed global state, settings, workspace state, or secrets. Regenerate `proto/dline/state.proto` through the project generator when the projected state contract changes.
3. Use global/workspace `SettingsRepository` mutations for user settings. Use explicit scoped capability APIs for sparse capability overrides.
4. Use task settings only for task-owned overrides. Do not turn a task snapshot into a global default.
5. Use specialized repositories for profile catalogs, API keys, provider credentials, OAuth records, TaskHistory, messages, activities, metrics, and artifacts.
6. Propagate user-visible settings through the owning Proto/controller/Webview or CLI round trip; a field added only to an in-memory state payload is not persistent.
7. Define finite flush/close behavior for buffered writes and invoke it at task, controller, host shutdown, and recovery boundaries as applicable.
8. For secrets, verify owner-only permissions, redaction, migration, deletion, and that credentials are not duplicated into profile or settings documents.
9. Test restart recovery, concurrent windows, stale writers, workspace/task isolation, migration retries, malformed or partial files, and cleanup/deletion according to the changed owner.

Do not introduce direct `ExtensionContext` persistence, ad-hoc JSON writes, parallel authorities, or path construction outside the owning storage boundary.
