// English task progress prompts — key-value pairs only, no code logic.

const prompts: Record<string, string> = {
	generic: `UPDATING TASK PROGRESS

Use the task_progress parameter only when creating or updating TODO items. Follow exactly one lifecycle mode below. Omit the parameter when no TODO item is being created or updated; blank, whitespace-only, heading-only, or empty-checkbox values do not update the stored list.

**1. FIRST TIME — Create the initial checklist:** Pass the FULL checklist with \`# Title\`, optional \`## Section\` headings, and at least one non-empty \`- [ ]\` item. Do this ONCE at the start of a task. This is list creation, not a progress update.

**2. DURING WORK — Send an incremental update only:** The current checklist is already stored and is shown in \`environment_details\`. Do NOT repeat the full checklist, even if you copy it without changes. Pass only checklist items that are already present in the stored plan and that were completed in this update, using \`- [x]\` with EXACT original text copied character-for-character. You may also include at most ONE unchanged \`- [ ]\` item to identify the current step; it must be an existing item and must remain the next item in strict order.

An incremental update MUST NOT contain \`# Title\`, \`## Section\`, a new heading, or the complete list. Do not add, remove, reorder, rename, rephrase, or regroup items. Do not include unrelated unchecked items. If the plan structure needs to change, stop and use \`change_todo_list\` for user authorization instead of changing task_progress.

**3. ALL COMPLETED — Choose ONE:** When every item in the stored checklist is \`[x]\`, do not send another progress update merely to repeat completion. Choose one action:
   - Pass a NEW full checklist to continue with the next phase of work.
   - Call attempt_completion with a summary covering: what was accomplished, methods used, and test/verification results.
   - Call generate_report with findings, analysis, and recommendations.
   - Call make_plan with the complete plan (in ACT MODE, only when the user explicitly requested a plan).

A full checklist is allowed only for the first creation or after all items in the current checklist are complete and a new phase is genuinely starting. Submitting a full checklist while any current item remains \`[ ]\` is an unauthorized plan replacement and must be rejected.

Updates should be silent — do not announce them. Keep items focused on meaningful milestones. Do not deviate from the plan without user approval.
The task_progress parameter MUST be a separate parameter, not inside other content or argument blocks.

--- Mode 1: Initial creation ---
<task_progress>
# Build React Application
## Set up project
- [ ] Set up project structure
- [ ] Install dependencies
## Build components
- [ ] Create components
- [ ] Test application
</task_progress>

--- Mode 2: Incremental update with completed items only ---
<task_progress>
- [x] Set up project structure
- [x] Install dependencies
</task_progress>

--- Mode 2b: Incremental update with one current item ---
<task_progress>
- [x] Set up project structure
- [x] Install dependencies
- [ ] Create components
</task_progress>

The following is INVALID while the current checklist still has unchecked items because it repeats the full plan and attempts to replace it:
<task_progress>
# Build React Application
## Set up project
- [x] Set up project structure
- [x] Install dependencies
## Build components
- [ ] Create components
- [ ] Test application
</task_progress>

--- Mode 3a: All done, start new checklist ---
<task_progress>
# Add Features
## Authentication
- [ ] Add login page
- [ ] Add signup page
</task_progress>`,

	standardFused: `# TODO LIST MANAGEMENT

The TODO list is the runtime-owned execution record for multi-step work. It keeps the agreed milestones, completed work, and current step visible in \`environment_details\`. Treat the stored list as the source of truth for checklist state. Use \`task_progress\` only to initialize the list or report actual status changes; omit it when nothing changed. Do not use it to rewrite the plan—structural changes go through \`change_todo_list\` and user approval.

## Initialize the List

Pass a complete checklist with a \`# Title\`, optional \`## Section\` headings, and at least one non-empty \`- [ ]\` item. A complete checklist is allowed when creating the first list or after every item in the current list is \`[x]\` and a genuinely new phase is starting. If a current item remains \`[ ]\`, the runtime treats a complete checklist as an unauthorized replacement and rejects it.

### Initial creation

Provide this complete Markdown checklist as the \`task_progress\` value:

\`\`\`markdown
# Build React Application

## Set up project

- [ ] Set up project structure
- [ ] Install dependencies
\`\`\`

When every item in the stored checklist is \`[x]\`, compare the completed phase with the latest user request and the Objective before choosing the next action:

- If work remains to satisfy the user's request, pass a new complete checklist for the next phase and continue.
- If progress depends on a decision only the user can make, ask one focused question.
- If the user explicitly requested a plan or report for review, use the corresponding tool when it is ready.
- Use \`attempt_completion\` when the entire current task is complete and the relevant verification is consistent.

### Start the next checklist

When all current items are complete and work continues, provide a new complete Markdown checklist:

\`\`\`markdown
# Add Features

- [ ] Add login page
- [ ] Add signup page
\`\`\`

## Update Progress

The current checklist already exists. Pass only exact items present in the stored checklist. Report newly completed items with \`- [x]\`. You may also report exactly one unchanged existing \`- [ ]\` item, either by itself to identify the current work or after completed items to identify the next current work. Preserve strict item order and do not skip unchecked items.

Do not repeat the complete checklist during an incremental update, even when copying it without changes. Do not include \`# Title\`, \`## Section\`, a new heading, or unrelated unchecked items. Omit \`task_progress\` when no TODO item is being created or updated; blank, whitespace-only, heading-only, or empty-checkbox values are ignored. Do not narrate the checklist edit itself, keep checklist items focused on milestones, and provide \`task_progress\` as its own parameter rather than inside another content or argument block.

### Report completed items

Provide only the exact completed items:

\`\`\`markdown
- [x] Set up project structure
- [x] Install dependencies
\`\`\`

### Report current work only

Provide one exact existing unchecked item:

\`\`\`markdown
- [ ] Create components
\`\`\`

### Report completed items and the next current item

Provide the exact completed items followed by one exact current item:

\`\`\`markdown
- [x] Set up project structure
- [x] Install dependencies
- [ ] Create components
\`\`\`

## Change the Structure

Do not add, remove, reorder, rename, rephrase, or regroup checklist items through \`task_progress\`. If the plan structure needs to change, stop using \`task_progress\` and request user authorization with \`change_todo_list\`. Continue to follow the stored list until the replacement is approved.`,

	paramInstruction: `Omit task_progress when no TODO item is being created or updated. When provided, include at least one non-empty checklist item. During an existing checklist, send exact newly completed items and at most one exact current item; the current item may be sent by itself. Do not repeat the full checklist or change its structure. Use a full checklist only for initial creation or after all current items are complete and a new phase begins.`,
}

export default prompts
