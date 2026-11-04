# Prompt Engineering Contract

This rule governs product-authored text sent to a model: system sections, tool descriptions and schemas, dynamic guidance, tool results, and restored continuations. It does not prohibit inspecting implementation details when the user requests source-code work.

## Describe the behavioral contract, not the implementation

- Tell the model what it must do, what it must not do, what inputs are valid, what actually happened, and the next permitted action.
- Do not explain internal execution, commit or publication timing, callback ownership, scheduling, budget allocation algorithms, other consumers, or delayed delivery state machines unless the model must act on an explicitly exposed contract.
- For example, say that a completion tool requires the work and existing TODO list to be complete. Do not explain how presentation, feedback, persistence, or replay implement that rule.
- A tool's observable calling rules remain necessary: required parameters, approval, mode and workspace boundaries, cancellation, timeouts, output limits, and whether the call hands control back to the user.
- Corrective feedback may describe accepted or rejected updates and tolerated mistakes, including TODO order warnings. Do not automatically classify such feedback as forbidden implementation detail or remove it without checking the approved behavior.

## Expose only effective capabilities and inputs

- Trace the actual execution path before describing a capability. Do not promise AI analysis, aggregation, summarization, or an effect that the selected implementation does not perform.
- Advertise only parameters that have meaning on the selected route. Keep canonical descriptors, native schemas, XML instructions, validation, execution, and results consistent.
- Local Web Search returns search results. Local Web Fetch retrieves page content. Neither implies a separate AI analysis stage; do not expose an analysis `prompt` for these local operations.
- Do not name internal executors or explain route selection to the model when the available tool and its contract already provide everything needed to call it correctly.
- Preserve provider-hosted tool contracts independently. Fixing a local contract must not silently change hosted schemas, routing, or permissions.
- Keep intentional compatibility at the input boundary. A historical unused argument must not become a new capability or a reason to reject an otherwise valid call without an explicit contract change.

## Keep guidance minimal and truthful

- State a rule once at its owning level. Shared policy belongs in shared guidance; a tool description adds only tool-specific requirements.
- Give subagents their current effective final-result allowance and required output priorities, not the parent task's ledger, competing consumers, allocation formula, or compaction delivery mechanism.
- Never recommend an alternative tool or channel because it has fewer restrictions. Alternatives remain subject to the same user authorization and safety boundaries.
- Report verified outcomes. Missing results do not establish that execution succeeded, failed, was approved, or was caused by a particular internal fault.
- Retain actionable failure diagnostics, but avoid revealing unnecessary permission-matching rules or internal reasons merely to explain a refusal. Keep detailed engineering diagnostics in the appropriate user-facing logs or UI.
- Do not rely on prompt secrecy to enforce permissions. Authorization and state validation remain runtime responsibilities.

## Project authorities and asset locations

The only stable prompt profiles are Standard and Lite. Tool descriptors have one canonical source in `src/core/prompts/tools/tool-specs.ts`, with ordered inclusion in `tool-ids.ts`. Native and XML definitions are projected from that source. Do not create `system-prompt/tools/<tool>.ts` model-family variants or edit generated provider schemas independently.

Every sentence the model reads lives in the English i18n tree under `src/core/prompts/i18n/en/`, never inline in descriptors, handlers, or continuations:

- **Tool descriptor text** (description, parameter instructions and usage examples) goes in `i18n/en/tools/<toolName>.ts`, a key-value module with no logic, registered in `i18n/en/tools/index.ts` with `defineLegacyModule("<toolName>", "tools", module, contracts)`. `tool-specs.ts` reads it with `getPrompt("<toolName>", "<key>")`.
- **Runtime values** are written as `@NAME@` in the text and declared with `createRuntimeContract("NAME", ...)` in that module's registration.
- **Shared handler-side text** (tool results, errors, feedback wrappers, recovery answers) goes in `i18n/en/tools/toolHandlers.ts` and is rendered through a `formatResponse` entry in `src/core/prompts/responses.ts`. Existing tool-specific diagnostics may retain their owning tool module; do not duplicate the same outcome. Live and restored answers for the same outcome call the same formatter.
- **Slash-command and explicit-instruction text** (for example `/newtask`) goes in `i18n/en/commands/`.
- Inline literals are acceptable only for protocol markers and structural tags a parser depends on, not for prose.
- `i18n/__tests__/prompt-asset-inventory.test.ts` locks the module inventory; update it when adding or removing a module, and delete a module once no `getPrompt`/`renderPrompt` reader remains.
- `zh-CN` currently overlays only `system`; tool and command text is English-only.

## Ownership and verification

Load `reviewing-prompt-contracts` for model-visible text, parameters, results and restored-answer review techniques. For a new tool, `add-new-tool` teaches implementation and `integrate-new-tool` orders the long integration. Load `use-vitest` for execution and prompt snapshot regeneration.

Verify effective inputs, route selection, results and restored continuations at their consuming boundary. Intentional generated prompt changes require repository snapshot regeneration, diff review and owning tests without update flags; generated snapshots are not hand-edited.
