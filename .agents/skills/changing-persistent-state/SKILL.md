---
name: changing-persistent-state
description: Change Dline settings through their UI/RPC/repository path, mutate latest values and sparse capability overrides, and develop storage importers using existing task stores and migration tests.
---

# Change Persistent State

Use `storage` for root, owner, scope and write-authority contracts.

## Trace an Existing Setting Before Adding One

`preferredLanguage` is a concrete global-setting example:

```text
PreferredLanguageSetting.tsx -> updateSetting("preferredLanguage", value)
  -> state/updateSettings.ts -> StateManager.setGlobalState
  -> pending Settings batch -> SettingsRepository.mutate
  -> settings/settings.json
```

The projected value returns through `Controller`'s state payload and `ExtensionStateContext` to the control.

1. Find the key in `src/shared/storage/state-keys.ts`: `preferredLanguage` has the declared default `English`.
2. Read the controller's `state/updateSettings.ts` branch. It calls `setGlobalState("preferredLanguage", request.preferredLanguage)`.
3. Follow `StateManager.setGlobalState`: `isSettingsKey` routes this key into `settingsCache` and `pendingSettings`, despite the setter's historical name. `persistSettingsBatch` commits that patch through the Settings repository.
4. Follow `Controller`'s `getGlobalSettingsKey("preferredLanguage")` projection, the generated state field and the Webview control's read. Check the default in `ExtensionStateContext` alongside the declared key default.

For a new setting on this route, add the typed key/default, generate the Settings projection, implement the update branch and return projection, then wire the control. `changing-protobuf-contracts` covers generation and conversion details. For durability, flush through `StateManager.flushPendingState()` and read through a newly opened owner; an immediate read of `settingsCache` covers only the optimistic update.

## Mutate a Value Derived from Existing State

A fixed scalar assignment can be committed as a patch. A map edit or increment needs the value read inside the transaction. In application code, use the existing entry point:

```typescript
await stateManager.mutateGlobalSettingsKey("globalSkillsToggles", (current) => ({
    ...current,
    [resourcePath]: false,
}))
```

`mutateGlobalSettingsKey` flushes pending settings, calls `SettingsRepository.mutateResolved`, applies the committed snapshot, and returns the canonical value. The repository reads the current disk document under its file lock before invoking the resolver; spreading a map captured before that callback would lose this property.

`src/core/storage/settings/__tests__/SettingsRepository.test.ts` provides the real concurrency pattern: two initialized repositories share one file; one changes `chatInputSendShortcut` while the other changes `terminalOutputLineLimit`; the persisted document contains both changes and revision 2. Its same-key case derives the winner from the two returned commit revisions, and its watcher case observes the external commit through `subscribe`.

## Use the Capability Scope Adapter

For a capability control, use `src/core/storage/settings/capability-toggle-store.ts` rather than selecting storage keys in the UI:

```typescript
await setCapabilityEnabled(
    stateManager,
    "skills",
    { hasWorkspace: true, hasTask: true },
    resourcePath,
    false,
)
await clearCapabilityOverride(stateManager, "skills", "task", resourcePath)
```

`setCapabilityEnabled` selects the active scope and matching key; `clearCapabilityOverride` removes one explicit key from a chosen scope. The first call above disables the resource only for the task; the second restores inheritance. Writing `true` is a new explicit override, not the same operation as removing the key. Trace these calls through `mutateScopedCapabilityToggles`, which routes task, workspace and global mutations to different owners.

Use `capability-scope-isolation.test.ts`, `capability-toggle-store.test.ts` and `workspace-settings-scope.test.ts` beside the repository tests for these scope-specific behaviors.

## Work on a Task Store

Start from `resolveInstanceLayout()` and identify the store that writes the affected data. Trace that owner's open, write, flush/close and deletion hooks before changing its persisted shape. Extend the owner's existing reopen and deletion tests rather than reading task files through a new path.

## Develop or Change an Importer

Read the existing owner's source selection, destination-state guard and source-retirement check before extending it. Those decisions differ between importers; a fixed history of past migrations is not a procedure for developing the next one.

### UI message import: preserve committed rows and source retirement

Use `src/core/storage/messages/importLegacyUiMessages.ts` when changing supported chat-history formats or deduplication:

1. Follow `LEGACY_UI_MESSAGE_FILES` and `readLegacyUiMessages()` to understand source precedence and repeated-timestamp handling.
2. Follow `importLegacyUiMessages()`: an empty destination is populated and queried again; a nonempty destination is never overwritten. Source retirement depends on the timestamp sequence check in `sameTimestamps()`.
3. Extend `src/core/storage/messages/__tests__/importLegacyUiMessages.test.ts` at the behavior being changed. Its streaming example reads timestamps `100, 200(partial), 300, 200(final)` and stores `100, 300, 200`: the chosen write's position matters, not numeric timestamp sorting.

The leftover-source test also matters: existing rows with timestamps `10, 20` retain their newer payloads even when the old source has different text; matching timestamps allow the source to be renamed. A source whose timestamp sequence disagrees stays in place. Do not mistake the current timestamp check for full payload equality when changing this importer.

### Task upgrade: verify dependencies and failed-open behavior

Use `src/core/task/composition/TaskUpgradeImport.ts` when changing imports that affect runtime hydration. Its current dependency order is:

```text
importConversation -> importLegacyCompactionState -> importInputQueue
```

The input queue must be positioned at the journal tail left by the preceding imports. Keep the upgrade on the task-lock-owning opening path. For a read-only pending-work check, use `taskUpgradeImportPending()` rather than invoking the importer.

Extend `TaskUpgradeImport.test.ts` beside the implementation. The existing queue case checks the saved state's journal watermark against the imported journal and hydrates the queued entry. The failure case rejects journal append, expects `ApiHistoryImportError`, and verifies that neither the queue nor state vault was touched. Its pending-work cases check that inspection writes neither store and that a completed import is no longer pending. These assertions distinguish ordering, authority and retry behavior; a successful final read alone would not.
