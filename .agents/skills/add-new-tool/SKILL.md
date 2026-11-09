---
name: add-new-tool
description: Implement or diagnose built-in tool identity, admission, approval classification, lanes, descriptors, handlers, interactions, host/UI wiring and recovery, with concrete examples; use integrate-new-tool for the full integration workflow.
---

# Add a New Dline Tool

Use this skill for concrete tool-development techniques, including targeted repairs. Read the nearest analogous tool end to end: identity, admission, approval classification, lanes, descriptor, handler, presentation and tests. Load `integrate-new-tool` for a new tool's long implementation workflow; this skill's topics are not an instruction to run every integration stage for a local change.

---

Approval, admission and kernel ownership are defined in `dline-overview`; canonical prompt/profile contracts are in `prompt-engineering`. The topics below explain the corresponding implementation points.

---

## Classify Ownership and Exposure

Choose the ownership model that matches the behavior:

1. **Grouped tool row**: routine read-only or low-stakes operations rendered by `ToolGroupRenderer`.
2. **Dedicated say row**: tools with distinct output, such as edit results, rendered from `ChatRow`.
3. **Backend-owned interaction**: follow-up, plan, Q&A, report, or completion. These own their interaction through `config.interactions` and the kernel dialog machine, resolve to approval kind `none`, and hold `LANE_USER_INTERACTION`.
4. **Task activity**: long-running command or subagent work whose output, cancellation, retry, and recovery belong to `TaskActivityStore` and the Activities view.

Then decide, explicitly:

- read-only or workspace-changing;
- permission scope (read, edit, a direct scope, or interaction-owning);
- exclusive lanes;
- turn-ending or conversational;
- IDE-native (needs a host bridge) or plain Node.js;
- available to subagents;
- Standard, Lite, or both.

Adding a new permission scope, auto-approve toggle, ceiling, or settings field changes a public settings contract; confirm it with the user before implementing.

---

## Identity

1. `src/shared/tools.ts`:
   - add the `DlineDefaultTool` value;
   - add it to `READ_ONLY_TOOLS` only when its behavior is read-only; workspace-mutation tickets have a separate explicit classification in the coordinator, described below;
   - add it to `CONVERSATIONAL_TOOL_NAMES` only if it opens a user interaction.
2. `src/core/task/kernel/turn/tool-identities.ts`:
   - add the same string to `KernelToolId`;
   - add it to `KERNEL_CONVERSATIONAL_TOOL_IDS` when it owns a user interaction.

These are separate declarations; compare their values when adding an identity. The lane coverage test reads `toolHandlersMap`, so passing it does not by itself prove that both identity declarations agree.

---

## Admission

File: `src/core/task/executors/tool/ToolAdmissionRegistry.ts`.

- `REQUIRED_PARAMETERS`: required parameters.
- `validateParameters`: value checks (follow the existing `bash`, `spawn_task`, and `browser_action` branches).
- `declaredPaths`: needed when the tool targets paths through parameters other than `path`/`file_path`, or several paths (for example a source and a destination). The default branch handles one path only.
- Dynamic write fanout: a declared file may be only an anchor, not the complete write set. Follow `reviewRegisteredToolBoundary` for the post-approval review and the dynamic-write lane assignments in `tool-lanes.ts`; do not discover files or canonicalize targets during admission.
- Approval card payload: map the tool in `PRESENTATION_TOOLS` / `approvalAsk` / `buildPresentation`, or implement `IApprovalPresentingToolHandler.getApprovalPresentation` on the handler. Both must build the card from parameters only. Unmapped tools fall back to a neutral `genericTool` card.

Tests: `src/core/task/executors/tool/__tests__/ToolAdmissionRegistry.test.ts`, including "classifies every remaining tool".

---

## Permission Scope and Approval Kind

Files: `src/core/task/kernel/turn/approval-kind.ts`, `src/shared/AutoApprovalSettings.ts`.

- Put the tool in exactly one scope: `READ_TOOLS`, `EDIT_TOOLS`, or `DIRECT_SCOPES`. Interaction-owning tools are recognized by `ownsItsInteraction`.
- An unclassified tool falls through to the `conversational` scope. That scope has no toggle and a fixed ceiling, so every call becomes a manual prompt unless YOLO or approve-all is on.
- `resolveApprovalKind` order: ceiling `manual_only` → inherited approval → interaction-owning tools get `none` → blanket or scope toggle gives `automatic` → `ai_approvable` gives `ai_approver` → otherwise `manual`.
- A new scope needs `PermissionScope`, `DEFAULT_CEILINGS`, `FIXED_CEILING_SCOPES` or a configurable ceiling, `isScopeToggledOn`, `ConfigurablePermissionScope`/`ceilings`, and the settings round trip. Ask the user first, as described under ownership classification.

Tests: `src/core/task/tools/__tests__/AutoApprove.ceilings.test.ts`, `autoApprove.conversational.test.ts`, `src/core/task/executors/tool/__tests__/ToolPreflight.test.ts`, `production/__tests__/ProductionToolHandlerRuntime.riskFacts.test.ts`.

---

## Concurrency Lanes

File: `src/core/task/kernel/turn/tool-lanes.ts`.

Lanes are named exclusive resources compared by exact string. Calls that hold the same lane run one at a time; calls with disjoint lanes may run in parallel. Declare all memberships the tool needs; static and parameterized lanes can be combined:

- `STATIC_LANES`: fixed lanes, such as `LANE_USER_INTERACTION` for interactive or turn-ending tools and `LANE_DIFF_EDITOR` for tools that drive the diff editor;
- `PATH_SCOPED_TOOLS`: per-path `write-path:` lanes for tools that write declared paths (usually combined with a static lane);
- `MCP_SCOPED_TOOLS`: per-server MCP lanes;
- `UNRESTRICTED_TOOLS`: no lane.

Test: `src/core/task/kernel/turn/__tests__/tool-lanes.test.ts` ("classifies every registered tool" parses `toolHandlersMap`).

---

## AI-Visible Text Through I18n

Follow `prompt-engineering` for project asset rules; load `reviewing-prompt-contracts` for consumer tracing and contract review examples.

- Create `src/core/prompts/i18n/en/tools/<name>.ts` for the description, parameter instructions, usage constraints, and examples. Shared handler results, errors, feedback, and restored answers belong in `i18n/en/tools/toolHandlers.ts` through `formatResponse` in `src/core/prompts/responses.ts`; reuse the owning tool module for existing tool-specific diagnostics rather than duplicating them.
- Register it in `src/core/prompts/i18n/en/tools/index.ts` `toolPromptModules` with `defineLegacyModule(...)`. Use `createRuntimeContract` when the text has runtime variables.
- Read it with `getPrompt` or `renderPrompt` from `src/core/prompts/i18n`.
- Update `src/core/prompts/i18n/__tests__/prompt-asset-inventory.test.ts`: expected namespaces, total module count, per-group counts, and tool entries.

---

## Canonical Descriptor and Profiles

- `src/core/prompts/tools/tool-specs.ts`: add one entry to `STANDARD_TOOL_SPECS` with `spec(...)`, or `nativeSpec(...)` only when XML exposure is intentionally unsupported. The `ProfileToolSpec`/`ProfileToolParam` types live in `profile-tool-set.ts`; Lite derives from the same spec through `tool-profile.ts`.
- Model parameter types, requiredness, enum values, dependencies, and runtime `contextRequirements` explicitly. Include `task_progress` only when the tool participates in the focus-tracking contract.
- `src/core/prompts/tools/tool-ids.ts`: add the id to `STANDARD_TOOL_IDS`, and to `LITE_TOOL_IDS` only when it fits Lite's smaller contract. Order is observable and snapshot-tested.
- `provider-projector.ts` and `xml-tool-projector.ts` project the same descriptor. Do not add `ModelFamily` or provider-specific variants.

Tests: `src/core/prompts/tools/__tests__/provider-projector.test.ts`, `xml-tool-projector.test.ts`, `profile-tool-set.test.ts`, and under `src/core/prompts/system-prompt/__tests__/`: `profile-matrix-snapshot.test.ts`, `command-profile-snapshot.test.ts`, `behavior-matrix.test.ts`, `subagent-tool-mentions.test.ts`. Regenerate snapshots with `npm run test:snapshot`; never hand-edit `.snap` files.

---

## Handler and Registration

Handler file: `src/core/task/tools/handlers/<ToolName>Handler.ts`.

Required contract: `IToolHandler` (`name`, `getDescription(block)`, `execute(config: TaskConfig, block: ToolUse): Promise<ToolHandlerResult>`).

Optional contracts, all in `src/core/task/tools/ToolExecutorCoordinator.ts`. Add one only when it carries real behavior:

- `IPartialBlockHandler`: streaming presentation only (`handlePartialBlock(block, uiHelpers)`); it must not decide approval or perform side effects;
- `IApprovalPresentingToolHandler`: builds the approval card from parameters;
- `IDenialDescribingToolHandler` / `IDenialPresentingToolHandler`: custom rejection result or presentation;
- `IPreparableToolHandler`: `prepare`/`discardPrepared` for work that must be staged before execution.

`IFullyManagedTool` is a legacy marker meaning "partial methods are presentation-only". It does not grant approval ownership.

Register the handler in `toolHandlersMap` in `src/core/task/tools/ToolExecutorCoordinator.ts`:

```typescript
[DlineDefaultTool.MY_NEW_TOOL]: (_v: ToolValidator) => new MyNewToolHandler(),
```

The map is an exhaustive `Record<DlineDefaultTool, ...>`, so TypeScript fails until the entry exists. `ProductionToolHandlerRuntime` registers mapped handlers automatically.

After approval, `ToolExecutorCoordinator.execute()` checks the explicit-instruction gate, opens a workspace-mutation ticket when applicable, settles preceding progress, and calls the execution policy or handler. It settles the mutation ticket in `finally` and completes checklist handling through `ToolCallProgress.finish()`. Explicit-only tools use `src/core/task/explicit-instructions/explicit-tool-gate.ts`; do not duplicate that authorization in the handler.

### Minimal handler shape

```typescript
export class MyNewToolHandler implements IToolHandler, IPartialBlockHandler {
    readonly name = DlineDefaultTool.MY_NEW_TOOL

    getDescription(block: ToolUse): string {
        return `[${block.name}] ${block.params.required_param ?? ""}`
    }

    async handlePartialBlock(block: ToolUse, uiHelpers: StronglyTypedUIHelpers): Promise<void> {
        if (uiHelpers.getConfig().isSubagentExecution) return
        await uiHelpers.say("tool", buildPresentation(block, true), undefined, undefined, true, block.ts)
    }

    // Runs only after admission and approval succeeded.
    async execute(config: TaskConfig, block: ToolUse): Promise<ToolHandlerResult> {
        const result = await doWork(block.params)
        const content = formatResult(result)
        await config.callbacks.say("tool", buildPresentation(block, false, content), undefined, undefined, false, block.ts)
        return content
    }
}
```

### Path rules

- Display workspace-relative paths with `getReadablePath(config.cwd, absPath)` and set `operationIsLocatedInWorkspace: true`.
- Paths outside the workspace are shown as absolute paths.

### Content format for `EditResultRow`

```text
Rename: oldName -> newName (3 files, 5 changes) (preview)

test-tools/utils/math.ts L3:17
  old line content
  new line content
```

- Line 1: `Prefix: old -> new (stats) (preview)?`, parsed for the header.
- Path lines: `relative/path L:col`, clickable.
- Indented old/new lines: rendered with red/green backgrounds.

---

## Side Effects and File Bookkeeping

- `src/core/task/tools/ToolExecutorCoordinator.ts`: add file-editing tools to `WORKSPACE_MUTATION_TOOLS`. Extend `mayMutateWorkspace()` when parameters distinguish a preview from a real mutation; `rename` and `replace_text` use `dry_run` this way. The coordinator pairs `beginWorkspaceMutation` with settlement in `finally`, including failure and cancellation paths. A handler must not create a second checkpoint queue.
- `src/core/task/tools/ToolCallSideEffects.ts` owns `ToolCallProgress`, which applies supported checklist updates at presentation or completion. It is not the workspace-mutation registry.
- File tracking: `config.services.taskFileTracker`, `config.services.fileContextTracker` (`src/core/context/context-tracking/FileContextTracker.ts`), and `config.taskState.fileReadCache`. Follow `WriteToFileToolHandler` and `ReadFileToolHandler`. Do not record file context for paths the tool deleted.

Tests: `src/core/task/tools/__tests__/ToolExecutorCoordinator.taskProgress.test.ts` covers mutation tickets, non-mutating tools, previews and checkpoint-barrier failure alongside checklist behavior.

---

## Turn-Ending and Interactive Tools

Read `AskFollowupQuestionToolHandler`, `MakePlanHandler`, `QnaRespondHandler`, `GenerateReportHandler`, and `AttemptCompletionHandler` first, and follow the matching one.

- Turn-ending: add the id to `TURN_ENDING_TOOL_NAMES` in `src/core/task/assistant-message-order.ts`. The same set drives planning and subagent policy. Test native and XML ordering.
- Interaction kind: define it in `src/core/task/interaction/InteractionRegistry.ts` (`INTERACTION_KINDS`, `DEFINITIONS`), map the tool in `interaction/InteractionContinuation.ts` `interactionKindForToolName`, and add a restore policy in `src/core/task/session/RestoredToolDialogContinuation.ts` `RESTORED_TOOL_DIALOG_POLICIES`.
- Partial stage: `uiHelpers.ask(kind, body, true, { existingTs: block.ts })`.
- Execute stage: open the interaction and consume its outcome:

```typescript
const outcome = await config.interactions.open({
    turnId: interactionTurnId(block),
    interactionId: interactionId(block),
    kind: "my_interaction",
    presentation,
    existingTs: block.ts,
})
// outcome: InteractionOutcome with actionId, draft, selection
```

  `attempt_completion` uses `config.interactions.stageCompletion` and `config.interactions.complete` instead.
- Answers that arrive after a restart are routed by `RestoredToolDialogContinuation`. Do not rely on a handler `continueInteraction` method being dispatched externally.
- Approval and rejection are kernel `tool_approval` dialogs, not interactions the handler owns.
- Add a transport enum or conversion under `proto/dline/` and `src/shared/proto-conversions/` only when the durable message contract needs a new value. There is no `buttonConfig.ts` registry.

Tests: `src/core/task/interaction/__tests__/HandlerInteractionMatrix.test.ts`, `src/core/task/tools/handlers/__tests__/TurnEndFeedbackHandlers.test.ts`, `src/core/task/session/__tests__/RestoredToolDialogContinuation.test.ts`, `src/core/task/__tests__/assistant-message-order.test.ts`.

---

## Subagent Exposure

- `src/core/task/tools/subagent/DefaultSubagentConfig.ts`: `DEFAULT_SUBAGENT_ALLOWED_TOOLS` and `DEFAULT_SUBAGENT_YAML_CONTENT` define the default allowlist.
- `src/core/task/tools/subagent/subagent-tool-policy.ts`: `isForbiddenSubagentTool` (turn-ending, conversational, and delegation tools) and `sanitizeSubagentTools`.
- `src/core/controller/file/getAvailableTools.ts`: `TOOL_DESCRIPTIONS` and `EXCLUDED_TOOLS`. A tool missing from `TOOL_DESCRIPTIONS` is silently hidden from the subagent configuration UI.

Tests: `src/core/task/tools/subagent/__tests__/subagent-tool-policy.delegation.test.ts`, `SubagentBuilder.test.ts`.

---

## Webview Presentation

### Grouped rows

- `webview-ui/src/components/chat/chat-view/utils/messageUtils.ts`: `LOW_STAKES_TOOLS`, `getIconByToolName`.
- `webview-ui/src/components/chat/chat-view/components/messages/ToolGroupRenderer.tsx`: `getToolDisplayInfo`, `EXPANDABLE_TOOLS`, `getToolGroupSummaryFromParsedTools`, `getActivityText`, `formatSearchDisplay`. These return structured `ToolItemText` values, not plain strings; copy the shape of an existing case.

### Dedicated rows

- `src/shared/ExtensionMessage.ts`: add the value to the `UiSayTool["tool"]` union (related types: `UiAsk`, `UiSay`).
- `webview-ui/src/components/chat/ChatRow.tsx`: add a case; `renameSymbol` and `replaceText` are current examples routed to `EditResultRow`.
- `EditResultRow` takes `content`, `toolType`, `matches`, and expansion props. Use `CodeAccordian` for simpler content. Add a focused component only when existing rows do not match the semantics.

Every running presentation must define completed, failed, cancelled, interrupted, and restored projections.

Tests: `npm run test:webview` plus focused component tests.

---

## Host Bridge for IDE-Native Capability Only

Skip a host bridge when core Node.js can implement the tool without VS Code APIs. Core code depends on `HostProvider` (`src/hosts/host-provider.ts`), never on `vscode`.

1. Add the contract under `proto/dline/host/{service}.proto` with the `dline` namespace and compatible field numbers.
2. Run `npm run protos`; never edit generated files.
3. Implement the VS Code adapter under `src/hosts/vscode/hostbridge/{service}/`.
4. Expose it through `HostProvider`, following the nearest generated host client.
5. Check the generated output under `src/shared/proto/`, `src/generated/hosts/`, `src/generated/grpc-js/`, `src/generated/nice-grpc/`, and the Webview client when applicable.

Webview ProtoBus is generated envelopes over `postMessage`, not a network gRPC socket.

`vscode.workspace.applyEdit()` changes the text buffer, not the disk. Save each affected document:

```typescript
const applied = await vscode.workspace.applyEdit(edit)
if (applied) {
    for (const [uri] of edit.entries()) {
        const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString())
        if (doc) await doc.save()
    }
}
```

---

## Lifecycle, Cancellation, and Recovery

- A running tool defines its terminal projections: completed, failed, cancelled, interrupted, and restored.
- Lifecycle changes go through kernel events and transitions, not handler or Webview booleans.
- Long-running output, cancellation, and retry metadata belong to `TaskActivityStore`; do not invent a parallel spinner or process registry.
- Cancellation must close owned resources and must not leave partial side effects unreported.

---

## Select Verification for the Changed Boundary

Each topic above lists its owning tests. Load `use-vitest` for execution and snapshot regeneration. `integrate-new-tool` owns the end-to-end integration order and completion checklist.
