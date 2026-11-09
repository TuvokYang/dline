---
name: reviewing-prompt-contracts
description: Trace a Dline prompt or tool contract from its asset and descriptor to native/XML projection, execution and restored feedback; diagnose ineffective parameters and mismatched consumers.
---

# Review a Model-Visible Contract

Use this skill to find where an advertised input or result diverges from execution. `prompt-engineering` defines the project contract and asset ownership.

## Follow One Consumed Value

Start with the tool id or asset key and follow the actual route:

```text
i18n asset -> tool-specs.ts -> provider-projector.ts / xml-tool-projector.ts
           -> admission validation -> handler or hosted-provider call -> result
```

Read the ordered profile sets in `tool-ids.ts` to determine which projections apply. For a result string, start at its `formatResponse` entry and follow its callers instead of searching only for similar English text. Record the input, consuming symbol and effect together; a parameter can be accepted for compatibility without affecting the operation.

## Worked Case: Local Web's Legacy prompt Argument

A retrieval-only local Web path needs a URL. Its historical `prompt` argument does not create an analysis operation. Review this as three separate boundaries:

1. In the canonical descriptor, advertise the effective URL input. In the native schema, inspect properties and requiredness; in XML, inspect the documented parameters and the parser's accepted call.
2. In validation and execution, follow a URL-only call to the actual retrieval result. Check the existing handling of the legacy argument separately: tolerating it and advertising it are different decisions.
3. In the provider-hosted route, inspect that provider's own schema and request construction. The local argument's lack of effect says nothing about a hosted tool's analysis capability.

For this case, useful checks are a valid URL-only invocation, the existing legacy-compatible invocation, and the hosted route's request shape. Matching the sentence “Retrieve content” cannot establish any of those contracts.

A common incomplete edit changes the English description but leaves the old canonical parameter required. Compare the generated native properties/required set with XML's effective inputs, then exercise the handler with those inputs. Use `use-vitest` for the repository's prompt snapshot regeneration procedure.

## Worked Case: Feedback After Restart

`src/core/task/tools/utils/UserFeedbackUtils.ts` contains `separateRoundFeedback`. For a round-material-owned reply it presents the submitted feedback once, consumes the mode-switch flag and renders:

```typescript
const switched = config.taskState.didRespondToPlanAskBySwitchingMode === true
config.taskState.didRespondToPlanAskBySwitchingMode = false
return formatResponse.toolResult(formatResponse.interactionFeedbackRecorded(switched))
```

To review a change here:

- Follow the live handler's use of this helper and its `InteractionOutcome`, including `roundMaterialOwned`, `draft` and `feedbackPresented`.
- Follow the tool's restore policy through `RestoredToolDialogContinuation` to the result it produces for the persisted outcome. Compare outcome identity, mode-switch meaning and attachment ownership, not merely wording.
- Put a shared outcome's text in its owning formatter. Change the asset/formatter and both consuming paths together when they represent the same outcome; retain distinct outcomes where their semantics differ.

A focused recovery case submits feedback, reopens from the persisted interaction, and checks that the intended continuation receives it once with the correct mode and identity.

## Judge Explanations at the Calling Boundary

When text describes completion, a result allowance or TODO correction, identify the action the model must take. Completion needs its observable calling condition; a subagent needs its supplied allowance and output priorities; rejected TODO input needs the accepted/rejected update and the correction. Scheduling callbacks and budget-allocation formulas do not help those actions. Apply this distinction to the consumed asset key rather than deleting every diagnostic explanation.
