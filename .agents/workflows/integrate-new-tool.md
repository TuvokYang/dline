---
name: integrate-new-tool
description: Integrate a new built-in Dline tool through classification, admission, approval, lanes, descriptors, execution, conditional UI/host/recovery wiring, and focused verification.
---

# Integrate a New Built-in Tool

Use for a new AI-callable built-in tool or a similarly broad integration, not a wording edit or isolated handler fix. Follow `dline-overview`, `engineering-guide`, and `prompt-engineering`. Load `add-new-tool` for technical methods and complete handler/interaction/host examples; this workflow owns the long implementation order and closure.

## 1. Establish Behavior and Ownership

Read the nearest analogous tool end to end: identity, admission, approval classification, lanes, descriptor, handler, presentation and tests.

Record read-only/workspace-changing behavior, permission scope, exclusive resources, turn-ending status, host needs, subagent availability, and Standard/Lite membership. Choose grouped row, dedicated say row, backend interaction, or Task activity from the skill's classification examples. Define success, failure, cancellation, interruption, and restored behavior.

Output: the behavior and ownership contract. Resolve any undecided permission scope, toggle, ceiling, public setting or durable transport contract before implementing the dependent stages.

## 2. Establish Identity, Admission, Approval, and Lanes

Add matching shared and kernel identities and their read-only/conversational classifications. Compare both identity sets manually; do not assume a generated check relates them.

Wire required parameters, value checks, declared paths and dynamic fanout. Build approval presentation from parameters, without target I/O. Choose the explicit scope and verify approval-kind precedence, then classify static/path/MCP/unrestricted lanes for the chosen behavior. Do not defer safety classification until after handler work.

Output: the tool can be recognized and admitted under the correct approval and exclusive-resource contract, with no target side effects before approval.

## 3. Publish the Model Contract and Implement Execution

Create/register the i18n assets and inventory; put shared live/restored results behind the owning formatter. Add one canonical descriptor with meaningful parameters and explicit Standard/Lite membership. Review native/XML projections with `reviewing-prompt-contracts`; do not add model-family variants or hand-edit snapshots.

Implement the approved-execution handler and register it in `toolHandlersMap`. Add partial/approval/denial/preparation interfaces only where required. Connect the explicit-instruction gate if the tool requires explicit user instruction. Verify that the coordinator's preconditions and side-effect handling apply; do not re-read approval settings or own approval dialogs inside the handler.

Output: a callable tool whose advertised inputs, execution and result agree. A registered handler alone is not the finished integration.

## 4. Complete Behavior-Dependent Branches

- **Workspace-changing:** add the tool to `WORKSPACE_MUTATION_TOOLS` in `ToolExecutorCoordinator.ts` and make `mayMutateWorkspace()` distinguish previews from real edits. The coordinator calls `beginWorkspaceMutation` and settles its ticket in `finally`; the handler still owns file trackers, read-cache invalidation and deleted-path handling. Compare a real write, a dry run and cancellation against the existing editing tools.
- **Turn-ending/interactive:** add ordering membership, interaction kind/continuation and restore policy. Use the matching interaction API, including completion's special staging path. Verify native/XML ordering and answers after restart.
- **Subagents:** decide availability explicitly, then align policy/default allowlist/YAML and the configuration UI's description/exclusion registry. Do not accidentally expose delegation or turn-ending tools.
- **Presentation:** connect the chosen grouped/dedicated/activity surface and structured row contract; reuse existing rows where semantics fit. Define every terminal and restored state.
- **IDE-native only:** load `changing-protobuf-contracts`; change the authoritative host Proto, generate, implement the VS Code adapter and expose through HostProvider. Inspect all generated projections, including retained standalone projections. A buffer edit must save the affected documents when disk changes are promised. Skip a host bridge when Node can do the work.

Output: every branch selected in step 1 is reachable; branches not needed are explicitly not applicable rather than copied as empty machinery.

## 5. Close Lifecycle and Verify the Chain

Use kernel lifecycle events, TaskActivityStore where applicable, finite cancellation/resource cleanup, and accurate partial-side-effect reporting. Do not add parallel booleans or process registries.

Load `use-vitest` before test execution and snapshot regeneration. Run the smallest checks that prove each changed boundary, then broaden for shared contracts:

```text
npm run check-types
npm run lint
npm run test:run -- <focused test files>
npm run test:snapshot             # canonical prompt output changed
npm run test:webview              # Webview presentation changed
npm run protos                    # a Proto source changed
```

Check current scripts/lifecycle hooks first; avoid unnecessary repeated generation. Also verify, when applicable:

- admission: required parameters, declared paths, and zero target I/O before approval;
- approval kind for each auto-approve configuration, including rejection with zero side effects;
- lane classification and parallel behavior;
- Standard and Lite membership, native and XML projections;
- partial streaming and final result ordering;
- cancellation, interruption, and restart recovery;
- subagent allowlist and configuration UI exposure;
- E2E when the change crosses a real host, ProtoBus, persistence, or Task lifecycle boundary; load `use-e2e` and `e2e-validation` to choose the focused tier.


## Completion Checklist

### Identity and admission
- [ ] `DlineDefaultTool`, `READ_ONLY_TOOLS`, `CONVERSATIONAL_TOOL_NAMES` (`src/shared/tools.ts`)
- [ ] `KernelToolId` and `KERNEL_CONVERSATIONAL_TOOL_IDS` (`kernel/turn/tool-identities.ts`)
- [ ] `ToolAdmissionRegistry`: required parameters, validation, declared paths, approval presentation
- [ ] permission scope in `approval-kind.ts`
- [ ] lane classification in `tool-lanes.ts`

### Prompt
- [ ] i18n module registered; prompt-asset inventory updated
- [ ] one canonical descriptor in `tool-specs.ts`
- [ ] Standard/Lite membership in `tool-ids.ts`
- [ ] snapshots regenerated with `npm run test:snapshot` when canonical output changes

### Runtime
- [ ] handler registered in `toolHandlersMap`; no approval logic inside it
- [ ] `WORKSPACE_MUTATION_TOOLS` / `mayMutateWorkspace()` and mutation-ticket settlement for editing tools; previews do not claim a mutation
- [ ] file tracking, read-cache invalidation and deleted-path handling match the actual edits
- [ ] turn-ending set, interaction kind, and restore policy for interactive tools
- [ ] subagent policy, default allowlist decision, and `TOOL_DESCRIPTIONS`

### Host and presentation, when required
- [ ] Proto source, `npm run protos`, host adapter, `HostProvider` exposure
- [ ] grouped row, dedicated row, or activity rendering chosen intentionally
- [ ] `UiSayTool`/`UiAsk` changed only for a real shared contract
- [ ] loading, completed, failed, cancelled, interrupted, and restored states covered

### Verification
- [ ] focused tests pass, including admission, approval-kind, lane, and inventory tests
- [ ] type checking and lint pass
- [ ] relevant Webview or E2E coverage passes

## Report

Report the behavior/ownership choice, registrations, applicable integration branches, compatibility impact and actual verification results.
