// English tool use guidelines prompts — key-value pairs only, no code logic.

export const EXPLICIT_INSTRUCTIONS_SECTION = `## Explicit Instructions

Explicit Instructions are one-time runtime invocation contracts injected directly into the current conversation for operations that are not advertised through the regular tool or capability catalogs. Each instruction applies only to the operation and scope defined by its injected block and does not create a persistent tool or capability.

An Explicit Instruction is provided in a block such as \`<explicit_instructions type="operation_name">...</explicit_instructions>\`. The \`type\` identifies the operation, and the block body provides the complete XML invocation template. That template defines the entire allowed XML grammar for the invocation: the root element, nested elements, element order, value placement, and every permitted XML construct. The grammar is opt-in—only syntax explicitly demonstrated by the injected template is available. For example, CDATA sections (\`<![CDATA[...]]>\`), attributes, namespaces, self-closing elements, comments, processing instructions, or XML declarations are valid only when the injected template itself includes and defines their use. Otherwise, values are written as ordinary element text with standard XML escaping.

Invoke the operation by filling that template and emitting exactly one complete, well-formed XML document. The invocation begins with the template's single root opening tag and is complete only when the matching root closing tag has been emitted; every nested element must also be correctly ordered, nested, and closed. The matching root closing tag is the execution boundary: the invocation can be parsed and executed only when the entire response forms that one closed XML document, with no second root, wrapper, or content outside it. Preserve the injected structure exactly, and when a general response-format rule differs from this contract, the Explicit Instruction governs that invocation.`

const prompts: Record<string, string> = {
	main: `# Tool Use Guidelines

1. Assess the information already available and what the current step still requires.
2. Choose the most appropriate exposed tool and provide every required parameter from the user request or verified context.
3. Do not assume a tool outcome. Inspect each returned result before starting any action that depends on it.
4. Formulate every tool call using the XML format specified for that tool.
5. Treat failures, diagnostics, and partial results as new evidence; correct the approach before continuing.

## TURN-END Tools

Tools marked [TURN-END] hand control back to the user. Calling one terminates the current execution turn: the runtime stops the automatic API/tool loop and opens the tool's user interaction. Do not emit additional tool calls after a TURN-END call in the same response. Execution resumes from the user's submitted feedback or selected action.

${EXPLICIT_INSTRUCTIONS_SECTION}`,
}

export default prompts
