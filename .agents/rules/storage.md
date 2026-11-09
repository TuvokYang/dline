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

Hosts initialize storage through `createHostStorageContext()`, which resolves the system Documents directory before synchronous consumers use it. Runtime callers use the resolved `StorageContext` paths rather than constructing a second root.

## Current layouts

Shared state/data files are laid out below. Provider-specific credential stores define their additional files under `secrets/`.

```text
<data-root>/
├── globalState.json
├── secrets.json
├── settings/
│   ├── settings.json
│   └── api_profiles.json
├── secrets/
│   ├── api_keys.json
│   └── provider_secrets.json
└── workspaces/
    └── <workspace-hash>/
        ├── workspaceState.json
        └── settings.json
```

The documents root contains these task and global-capability directories:

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

Workspace capabilities are separate from persistent runtime state. Project rules, workflows, skills, subagents and hooks use `.agents/rules`, `.agents/workflows`, `.agents/skills`, `.agents/subagents` and `.agents/hooks`. Project MCP and plugin descriptors use `.dline/mcp` and `.dline/plugin`. Legacy compatibility roots do not change these current locations.

## StorageContext

`createStorageContext()` is the process boundary for global key-value state, settings paths, secrets, workspace storage, and TaskHistory paths. Callers receive resolved paths and store interfaces; they must not reconstruct these paths independently.

Workspace storage uses either an explicit `workspaceStorageDir` supplied by a host or a workspace-specific directory below the state/data root. Use the resolved boundary and its non-sensitive `workspaceId`; do not expose or persist the original workspace path when the identity is sufficient.

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

## Shared storage framework

- `StateManager` coordinates state/settings caches and buffered writes. Global and workspace settings use separate `SettingsRepository` instances; `ProfileCatalogRepository` owns the profile catalog. Shared documents mutate the latest value under the repository's cross-process lock, not a stale full-file snapshot.
- `src/core/storage/backend/api/` defines the entity schemas, queries, `UnifyStore` and database transaction contracts. Consumers use these contracts rather than introducing a parallel storage abstraction or depending on backend-specific queries.
- SQLite and JSONL backends preserve the same transaction, unique-index, blob and ordering contracts. `InstanceStorage` resolves existing databases through the backend framework; `DLINE_INSTANCE_STORAGE_BACKEND` selects the backend for new instance databases, defaulting to SQLite.
- Database-wide transactions use their transaction-scoped handles. Calling an independently opened store on the same database from inside that transaction can deadlock.
- `UnifyStore` writes resolve after their physical transaction commits. `BufferedUnifyStore` adds staged, in-memory updates for ordered message stores; owners must distinguish staging from durable commit and await the appropriate flush/close boundary.
- `StateManager.flushPendingState()` is the shared state/settings durability barrier. Shutdown rejects new mutations before the final drain; do not add an independent persistence queue beside the owning store.

## Task history

`tasks/taskHistory.db` is the current task index. It is one SQLite database per storage boundary, opened through the UnifyStore backend. Task ID is the primary key, so current reads are deduplicated by construction.

Task metadata writes may be queued off the UI hot path. Call `TaskHistory.flush()` when a lifecycle boundary requires durability. Completion projection updates are revision-aware transactional patches and must not be recreated as ordinary metadata overwrites.

## Per-task storage

A task directory is an instance root. A subagent run uses the same layout under `tasks/<task-id>/subagents/<subagent-id>/`; `InstanceLayout` and `resolveInstanceLayout()` in `src/core/storage/instance/` are the only source of these paths.

The canonical SQLite layout is shown below; SQLite sidecars and legacy import files are omitted. The JSONL backend stores each logical database in a same-named directory without the `.db` suffix.

```text
tasks/<task-id>/
├── journal.db
├── messages.db
├── activities.db
├── metrics.db
├── trajectory.db             (derived cache)
├── state.json
├── state.json.bak
├── context.json
├── context_history.jsonl
├── settings.json
├── task_metadata.json
├── artifacts/
├── subagents/
│   └── <subagent-id>/        (same instance layout)
└── tmp/
    ├── command-logs/
    ├── conversation-export/
    ├── shell-diagnostics/
    ├── input-resources/
    │   └── <resource-id>/        (content file + input-resource.json)
    ├── image-previews/
    └── image-viewer/
```

Ownership matters more than the physical filename:

- Each `.db` is opened through `openInstanceStorage(root)` and has exactly one high-frequency writer per process, registered by name on first write. Low-frequency maintenance writers are exempt. Do not open an instance database with a second writer to work around ownership.
- Only the window holding the task lock writes a task's instance storage. A window that opens the task without the lock gets a read-only session: `TaskRuntime` rejects submissions with `task_read_only`, upgrade imports and restored commands wait until the window owns the task, and the Controller projects a read-only view. Do not add a write path that bypasses this ownership check.
  - Two writes are allowed to a history display that holds no lock, and only while the task is ownerless: orphan activity recovery (`HistoryDisplaySession`), and maintenance of the derived `trajectory.db` cache (`TrajectoryMaintainer`, admitted through `OpeningTrajectoryAccess`). The cache is rebuildable from `messages.db`; writes use its compare-and-set contract and stop when another window owns the task. Neither exception extends to other task data.
- `journal.db` holds the conversation journal, command publication and task payloads in one transaction. It is the provider conversation authority; `JournalConversationView` renders it in memory and `readJournalConversation()` / `readTaskConversation()` are the read ports.
- `messages.db` owns chat rows and attachments through the UI message store.
- `activities.db` owns activity persistence through `TaskActivityPersistence` / `TaskActivityRowStore`.
- `metrics.db` owns API rate metrics and request/response execution data.
- `trajectory.db` is a derived message cache, not a conversation authority.
- `FileTaskStateVault` owns `state.json` and its `.bak` fallback. Runtime transitions, interactions, activity terminal states and journal identity must agree; a snapshot is not a substitute for those authorities. Legacy `snapshot.json` is not a runtime source.
- Task context helpers own `context.json` and `context_history.jsonl`.
- Artifact APIs own `artifacts/` and enforce task-relative paths. Do not expose conversation, snapshot, settings, or database files through the artifact read scope.
- `src/core/storage/task-temp.ts` owns `tmp/` and its cleanup policy. Command logs share the task's lifetime and size budget; do not add age-based deletion independent of that owner.
- `InputResourceStore` (`src/core/input-semantics/`) owns composer and task input resources, private permissions, and identity/owner/generation/hash validation. Access those resources through the store, not direct file operations.

Do not read or rewrite task files directly from controllers or UI code when an owning store exists. Task deletion goes through the deletion coordinator, which coordinates locks, active sessions, TaskHistory, database handles and owned files. New task-owned storage must participate in deletion and recovery ownership.

## Atomic file I/O

`src/shared/storage/atomic-file.ts` is the shared extension-host file replacement primitive. Use `writeJsonAtomic()` for JSON and `writeFileAtomic()` for other content; use their existing synchronous variants only where the owning path is synchronous. Do not introduce another temporary-file replacement implementation or import this Node-only module into the Webview.

- Writes replace the target from a temporary file in the same directory, so published content is complete. Backup rotation, `fsync` and file permissions are explicit options, not guarantees enabled by every call.
- `readJsonWithBackup()` validates through the supplied parser and tries the backup when the primary is missing or invalid. Its `primary`, `backup`, `missing` and `invalid` results remain distinct; the owning store decides recovery and diagnostics.
- Atomic replacement is not a cross-process read-modify-write transaction. Shared settings and catalog documents still require their repository's locking and latest-value mutation contract.

## State evolution boundaries

Legacy `ExtensionContext` state and old task formats are import sources, not parallel runtime authorities. Only the task-lock holder upgrades task storage.

Use `state-keys.ts` only for StateManager-owned categories and regenerate projected state contracts through their owner. User-visible settings must preserve validation, defaults and the Proto/controller/consumer round trip. Specialized credentials retain their own stores, permissions and deletion behavior.

### Migration baseline

- Base configuration migrations on the applicable persisted format already pushed to GitHub `dev` or `main` and exposed to users. Verify that remote commit or release tag before treating its format as a compatibility obligation; an arbitrary local commit is not a baseline.
- Unpushed development formats are intermediate implementations, not supported historical versions. A local commit, package version bump or schema revision alone does not justify another migration.
- If the external baseline is S and unpushed development changes it through A, B and C, implement only the necessary S-to-C migration. Do not retain S-to-A-to-B-to-C converters, fallback readers or compatibility branches for A and B.
- When a later local edit replaces an unpushed format, revise that implementation and its tests directly. Do not add an old-Profile-to-new-Profile conversion merely to preserve that intermediate format.
- Preserve migration coverage for actual supported external baselines. Updating these rules does not authorize deleting user data, running migrations on real data or rewriting previously published contracts.

Load `changing-persistent-state` for concrete setting changes, mutation examples and migration development methods.
