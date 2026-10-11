---
name: add-new-tool
description: Add a new AI-callable tool to Dline across canonical descriptors, prompt profiles, execution, interaction ownership, host bridges, Webview presentation, cancellation, persistence, and tests.
---

# Add a New Dline Tool

Use this skill only after reading the nearest analogous tool end to end. A tool is complete only when its identity, canonical prompt contract, runtime handler, presentation ownership, approval or interaction behavior, cancellation, recovery, and tests agree.

---

## Step 0: Classify Ownership Before Editing

Choose the existing ownership model that matches the behavior:

1. **Grouped tool row** — routine read-only or low-stakes operations rendered by `ToolGroupRenderer`.
2. **Dedicated say/ask row** — tools with distinct output or interactive presentation in `ChatRow` and a focused component.
3. **Backend-owned interaction** — causal user interactions such as follow-up, plan, completion, report, retry, or resume, coordinated through `InteractionCoordinator` and durable interaction state.
4. **Task activity** — long-running command or subagent work whose output, cancellation, retry, and recovery belong to `TaskActivityStore` and the Activities view.

Also decide whether the tool is read-only, state-changing, approval-gated, turn-ending, IDE-native, available to subagents, and enabled in Standard, Lite, or both profiles. Do not create a parallel lifecycle boolean beside `TaskRuntime`, duplicate interaction state in the Webview, or assume every tool needs a custom component.

---

## Step 1: Add a Host Bridge Only for IDE-Native Capability

Skip this step when core Node.js code can implement the tool without importing VS Code APIs. Shared core must depend on `HostProvider`, not `vscode`.

For an IDE-native capability:

1. Add the owning contract under `proto/dline/host/{service}.proto` using the existing `dline` namespace and compatible field numbers.
2. Run `npm run protos`; never edit generated files as the source change.
3. Implement the VS Code adapter under `src/hosts/vscode/hostbridge/{service}/`.
4. Follow the nearest generated host client and external-host adapter to expose the capability through `HostProvider`.
5. Verify the generated projections under `src/shared/proto/`, `src/generated/hosts/`, grpc-js/nice-grpc output, the Webview client when applicable, and the standalone descriptor set.

Treat Webview ProtoBus as generated envelopes over `postMessage`, not as a network gRPC socket. Keep VS Code-only types and behavior inside the host adapter.

### Important: Save after applyEdit
For VSCode handlers that use `vscode.workspace.applyEdit()`, the edit only changes the text buffer — NOT the disk. Always save modified documents:
```typescript
const applied = await vscode.workspace.applyEdit(edit)
if (applied) {
    for (const [uri] of edit.entries()) {
        const doc = vscode.workspace.textDocuments.find(d => d.uri.toString() === uri.toString())
        if (doc) await doc.save()
    }
}
```

---

## Step 2: Tool ID Registration

### 2a. Add enum value
File: `src/shared/tools.ts`
```typescript
export enum DlineDefaultTool {
    // ... existing
    MY_NEW_TOOL = "my_new_tool",
}
```

### 2b. Add to READ_ONLY_TOOLS (if read-only)
```typescript
export const READ_ONLY_TOOLS = [
    DlineDefaultTool.MY_NEW_TOOL,  // only if tool does NOT modify files
] as const
```

---

## Step 3: Define AI-Visible Text Through I18n

AI-visible descriptions, parameter instructions, usage constraints, and handler diagnostics belong under `src/core/prompts/i18n/en/` and are read with `getPrompt()`. Follow the nearest current tool's key naming; there is no required `description`/`nativeDescription` pair.

The canonical descriptor must be complete enough for both native provider tools and XML documentation. Provider transport differences are projections, not separate model-family prose.

---

## Step 4: Add the Canonical Descriptor

Edit `src/core/prompts/tools/tool-specs.ts`:

- add exactly one canonical `ProfileToolSpec` descriptor;
- use `spec(...)` for native and XML transport, or `nativeSpec(...)` only when XML exposure is intentionally unsupported;
- model parameter type, requiredness, enum values, dependencies, and runtime `contextRequirements` explicitly;
- include `task_progress` only when the tool participates in the current focus-tracking contract;
- keep runtime capability gates in named predicates rather than provider or model-family branches.

`provider-projector.ts` and `xml-tool-projector.ts` project the same descriptor to provider-native schemas and XML documentation. Do not add `ModelFamily.GENERIC`, `NATIVE_NEXT_GEN`, GPT-specific, Gemini-specific, Hermes, GLM, or other model-family variants.

---

## Step 5: Add Profile Membership

Edit `src/core/prompts/tools/tool-ids.ts`:

- add the ID to `STANDARD_TOOL_IDS` when Standard should expose it;
- add it to `LITE_TOOL_IDS` only when it fits Lite's intentionally smaller contract;
- preserve the deliberate order because prompt/tool ordering is observable and snapshot-tested.

The supported prompt profiles are exactly `PromptProfile.Standard` and `PromptProfile.Lite`. Do not create a third profile or a per-model tool list.

---

## Step 6: Handler Implementation

File: `src/core/task/tools/handlers/{ToolName}Handler.ts`

Implement the smallest runtime contract that owns the behavior:

- `IToolHandler` is the required base contract;
- add `IPartialBlockHandler` only when streaming partial presentation is meaningful;
- use `IFullyManagedTool` only when the handler truly owns its complete approval flow.

The executor checks partial support structurally, so do not add partial UI or approval ownership merely for consistency.

### Optional two-phase rendering pattern

```typescript
export class MyNewToolHandler implements IToolHandler, IPartialBlockHandler {
    readonly name = DlineDefaultTool.MY_NEW_TOOL

    getDescription(block: ToolUse): string {
        return `Run my new tool for ${block.params.required_param}`
    }

    async handlePartialBlock(block: ToolUse, uiHelpers: StronglyTypedUIHelpers): Promise<void> {
        const config = uiHelpers.getConfig()
        if (config.isSubagentExecution) return
        await uiHelpers.say("tool", buildPresentation(block, true), undefined, undefined, true, block.ts)
    }

    async execute(config: TaskConfig, block: ToolUse): Promise<ToolHandlerResult> {
        const result = await doWork(block.params)
        const content = formatResult(result)
        await config.callbacks.say("tool", buildPresentation(block, false, content), undefined, undefined, false, block.ts)
        return content
    }
}
```

Follow an existing handler with the same approval and presentation ownership. Keep validation, side effects, final rendering, and returned tool result consistent.

### Path rules:
- **Always use workspace-relative paths** via `getReadablePath(config.cwd, absPath)`
- For display, set `operationIsLocatedInWorkspace: true`
- Paths outside the workspace use absolute paths

### Content format for EditResultRow (edit tools):
```
Rename: oldName -> newName (3 files, 5 changes) (preview)

test-tools/utils/math.ts L3:17
  old line content
  new line content
```
- Line 1: `Prefix: old -> new (stats) (preview)?` — parsed by EditResultRow for header
- Path lines: `relative/path L:col` — clickable to jump to file:line
- Old/new lines: indented, formatted by EditResultRow with red/green backgrounds

---

## Step 7: Handler Registration

File: `src/core/task/tools/ToolExecutorCoordinator.ts`

### 7a. Import
```typescript
import { MyNewToolHandler } from "./handlers/MyNewToolHandler"
```

### 7b. Add to toolHandlersMap
```typescript
[DlineDefaultTool.MY_NEW_TOOL]: (_v: ToolValidator) => new MyNewToolHandler(),
```

---

## Step 8: Webview Rendering (CRITICAL)

---

### 8A. Read Tools — ToolGroupRenderer Path

#### 8A-1. Add to LOW_STAKES_TOOLS
File: `webview-ui/src/components/chat/chat-view/utils/messageUtils.ts`
```typescript
const LOW_STAKES_TOOLS = new Set([
    "readFile", "searchFiles", // ... existing
    "myNewTool",               // ← ADD
])
```

#### 8A-2. Add icon
File: `webview-ui/src/components/chat/chat-view/utils/messageUtils.ts`
```typescript
export function getIconByToolName(toolName: string) {
    switch (toolName) {
        case "myNewTool": return SearchIcon  // ← ADD
    }
}
```

#### 8A-3. Add display info
File: `webview-ui/src/components/chat/chat-view/components/messages/ToolGroupRenderer.tsx`

**getToolDisplayInfo** — controls the collapsed tool group line:
```typescript
case "myNewTool":
    return { icon, path: filePath, label: "my action" }
    // Optional: displayText overrides the path display
```

**EXPANDABLE_TOOLS** — if content should show on click:
```typescript
const EXPANDABLE_TOOLS = new Set(["searchFiles", "myNewTool", ...])
```

**getToolGroupSummaryFromParsedTools** — for summary header "Dline read N files":
```typescript
case "myNewTool": counts.myTool++; break
// Then: parts.push(`${counts.myTool} items`)
```

**getActivityText** — "in progress" text while streaming:
```typescript
case "myNewTool": return `Doing something in ${cleanedPath}...`
```

**formatSearchDisplay** — used for search-like tools to show `"pattern" in path/`:
```typescript
return `${termDisplay} in ${cleanPathPrefix(path)}/`
```

---

### 8B. Edit Tools — Standalone Component Path

#### 8B-1. Add ClineSayTool type
File: `src/shared/ExtensionMessage.ts`
```typescript
export interface ClineSayTool {
    tool: "editedExistingFile" | ... | "myNewTool"  // ← ADD
    path?: string
    content?: string  // used by EditResultRow
}
```

#### 8B-2. Add ChatRow case
File: `webview-ui/src/components/chat/ChatRow.tsx`
```typescript
case "myNewTool":
    return <EditResultRow content={tool.content!} isExpanded={isExpanded} onToggleExpand={handleToggle} />
```

Use `EditResultRow` for tools that show old→new transformations. For simpler display, use `CodeAccordian`.

#### 8B-3. EditResultRow component
EditResultRow expects content in this format:
```
Prefix: old -> new (N files, N changes) (preview)

rel/path.ts L:col
  old line content
  new line content
```

**Color constants** (matching DiffEditRow):
```typescript
const OLD_BG = "bg-red-500/20"   // 20% red on VSCode bg-code
const NEW_BG = "bg-green-500/20"  // 20% green on VSCode bg-code
```

**Styles applied by EditResultRow**:
- Header: old name red bg, new name green bg + bold
- Path lines: clickable → `openFileRelativePath("file:line")`, hover: cursor-pointer
- Old content lines: red bg
- New content lines: green bg + bold

---

### 8C. Interactive and Turn-Ending Tools

Do not model a new interactive tool as a standalone button table in the Webview. First inspect `AskFollowupQuestionToolHandler`, `MakePlanHandler`, `QnaRespondHandler`, `AttemptCompletionHandler`, or `GenerateReportHandler` and follow the matching ownership model.

Interactive tools must:

- establish or resume a causal interaction through `InteractionCoordinator`;
- persist enough state to survive interruption and restart;
- implement `continueInteraction(...)` when a response can arrive after recovery;
- distinguish approval, rejection, feedback, retry, and cancellation outcomes;
- avoid replaying already committed side effects when an interaction resumes.

Only add a transport enum or conversion under `proto/dline/` and `src/shared/proto-conversions/` when the durable message contract truly needs a new value. There is no current `buttonConfig.ts` registry to update.

If custom presentation is required, add a focused component under `webview-ui/src/components/chat/` and route it from `ChatRow.tsx`. Reuse existing rows only when their semantics match; a custom component is not mandatory for every tool.

For turn-ending tools, update `src/core/task/assistant-message-order.ts` and test both native and XML ordering. Turn-ending behavior also needs durable interaction and recovery tests; ordering alone is insufficient.

---

## Step 9: Preserve Lifecycle, Cancellation, and Recovery

A running tool must define its terminal projections: completed, failed, cancelled, interrupted, and restored. Long-running work should use the existing command/subagent activity model rather than inventing a parallel spinner or process registry.

When a tool changes Task lifecycle, express it through `TaskRuntime` events and reducer transitions. When it owns durable user interaction, use `InteractionCoordinator`. When it owns long-running output or retry metadata, use `TaskActivityStore`.

---

## Step 10: Verify the Complete Chain

Choose the smallest tests that prove each changed boundary, then broaden for shared contracts:

```text
npm run check-types
npm run lint
npm run test:run -- <focused test files or --project ...>
npm run test:snapshot             # when canonical prompt output changed
npm run protos                    # when a Proto source changed
```

Also verify, when applicable:

- Standard and Lite profile membership;
- provider-native and XML projections from the same descriptor;
- required and optional parameter schemas;
- approval, rejection, cancellation, timeout, and sanitized errors;
- partial streaming and final tool result ordering;
- Webview grouped/dedicated/activity rendering;
- interruption and restart recovery;
- VS Code host behavior for host-bridged capabilities;
- E2E behavior when the change crosses a real host, ProtoBus, persistence, or Task lifecycle boundary.

Never hand-edit generated Proto output or prompt snapshots.

---

## Completion Checklist

### Canonical contract
- [ ] `src/shared/tools.ts`: identity and read-only classification
- [ ] `src/core/prompts/i18n/en/`: AI-visible prose
- [ ] `src/core/prompts/tools/tool-specs.ts`: one canonical descriptor
- [ ] `src/core/prompts/tools/tool-ids.ts`: Standard/Lite membership
- [ ] provider-native and XML projection tests

### Runtime
- [ ] focused handler under `src/core/task/tools/handlers/`
- [ ] registration in `ToolExecutorCoordinator`
- [ ] validation, approval, cancellation, errors, and partial/final output tests
- [ ] `TaskRuntime`, `InteractionCoordinator`, snapshot, or activity integration only where the ownership model requires it

### Host and transport, when required
- [ ] source contract under `proto/dline/` or `proto/dline/host/`
- [ ] regenerated projections through `npm run protos`
- [ ] host adapter and `HostProvider` exposure
- [ ] transport and cancellation tests

### Presentation, when required
- [ ] grouped row, dedicated say/ask row, or activity rendering selected intentionally
- [ ] `ExtensionMessage`/Proto conversion updated only for a real shared contract
- [ ] loading, completed, failed, cancelled, interrupted, and restored states covered

### Verification
- [ ] focused tests pass
- [ ] prompt snapshots regenerated and verified when changed
- [ ] type checking and lint pass for the affected chain
- [ ] relevant Webview or E2E coverage passes
