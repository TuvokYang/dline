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

## Ownership and verification

- Follow `engineering-guide` for prompt asset locations, runtime placeholders, canonical descriptors, and Standard/Lite projections. Do not create a second prompt authority.
- Check the exact consumed key and its callers; an unused legacy string is not evidence that a current model request contains it.
- Inspect all affected consumers, including native/XML projection, local/hosted routes, dynamic tool results, subagent requests, and recovery where applicable.
- Test behavioral contracts and structured outputs. Parameter presence, required fields, route selection, real results, cancellation, and persistence are valid oracles; prose-presence assertions and mock call counts alone are not.
- Regenerate repository-owned prompt snapshots with `npm run test:snapshot` after intentional prompt changes, review the diff, then run the owning tests without update flags. Do not hand-edit snapshots.
