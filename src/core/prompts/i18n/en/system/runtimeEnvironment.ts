// English runtime-environment prompts — key-value pairs only, no code logic.
const prompts: Record<string, string> = {
	workspacePathRule: "Use `path` for the default workspace or `@workspace:path` to target a named workspace.",
	multiRootHint: " Available workspaces: @NAMES@.",
	browserSupport: ", use the browser",
	yoloAskText: ", and ask follow-up questions",
	browserCapabilities: `
- You can use the browser_action tool to interact with websites (including html files and locally running development servers) through a Puppeteer-controlled browser when you feel it is necessary in accomplishing the user's task. This tool is particularly useful for web development tasks as it allows you to launch a browser, navigate to pages, interact with elements through clicks and keyboard input, and capture the results through screenshots and console logs. This tool may be useful at key stages of web development tasks-such as after implementing new features, making substantial changes, when troubleshooting issues, or to verify the result of your work. You can analyze the provided screenshots to ensure correct rendering or identify errors, and review console logs for runtime issues.
- For example, if asked to add a component to a react website, you might create the necessary files, use execute_command to run the site locally, then use browser_action to launch the browser, navigate to the local server, and verify the component renders & functions correctly before closing the browser.`,
	webToolsCapabilities:
		"\n- Use web_fetch to retrieve and analyze content from a known URL when external source material is needed.",
	localWebSearchCapabilities:
		"\n- When the task requires current information (for example current documentation, best practices, or news), use web_search. This request routes that tool through Dline's local executor.",
	serverWebSearchCapabilities:
		"\n- Use web search only when the user explicitly requests external search or verification, or when the task cannot be completed reliably without external retrieval. Do not search merely because information may be current or recent.",
	connectedMcpServers: "Connected MCP servers: @NAMES@",
	workspaceReferenceHint: " Use `path` for the default workspace or `@workspace:path` to target a named workspace.",
	parallelToolsRule:
		"\n- You may use multiple tools in a single response when the operations are independent (e.g., reading several files, creating independent files). For dependent operations where one result informs the next, use tools sequentially and wait for the user's response.",
	clarifyPermission:
		" You may also ask the user clarifying questions with ask_followup_question to get a better understanding of the task.",
	parallelToolPolicyEnabled:
		"You may call multiple independent tools in one response when it improves progress without coupling dependent steps.",
	parallelToolPolicyDisabled: "Use one tool at a time and let each result inform the next step.",
	clarifyRuleYolo: "state safe, reversible assumptions clearly and continue only when risk is low",
	clarifyRuleInteractive: "ask a focused clarifying question rather than making risky assumptions",
	missingParamPolicyYolo: "stop and explain which required parameter cannot be inferred safely",
	missingParamPolicyInteractive:
		"do not invoke the tool, and instead ask the user for that parameter with ask_followup_question",
	legacyClarifyRuleYolo: "state your assumptions clearly before proceeding",
	legacyClarifyRuleInteractive: "**ask clarifying questions** using ask_followup_question rather than making assumptions",
	legacyMissingParamPolicyInteractive:
		" and instead, ask the user to provide the missing parameters using the ask_followup_question tool",
}

export default prompts
