// English rules prompts — key-value pairs only, no code logic.

const prompts: Record<string, string> = {
	browserRules:
		'- The user may ask generic non-development tasks, such as "what\'s the latest news" or "look up the weather in San Diego", in which case you might use the browser_action tool to complete the task if it makes sense to do so, rather than trying to create a website or using curl to answer the question. However, if an available MCP server tool or resource can be used instead, you should prefer to use it over browser_action.\n',

	browserWaitRules:
		" Then if you want to test your work, you might use browser_action to launch the site, wait for the user's response confirming the site was launched along with a screenshot, then perhaps e.g., click a button to test functionality if needed, wait for the user's response confirming the button was clicked along with a screenshot of the new state, before finally closing the browser.",

	cliRules:
		"- After making code changes, consider running any available validation tools for the project (such as type checkers, linters, test suites, or build scripts) to catch errors, since you won't receive automatic diagnostics after edits.\n",

	yoloAskRule:
		"You are only allowed to ask the user questions using the ask_followup_question tool. Use this tool only when you need additional details to complete a task, and be sure to use a clear and concise question that will help you move forward with the task. However if you can use the available tools to avoid having to ask the user questions, you should do so",

	yoloNoAskRule:
		"Use your available tools and apply your best judgment to accomplish the task without asking the user any followup questions, making reasonable assumptions from the provided context",

	yoloOutputRule:
		" If output is still unavailable after reasonable checks and you need it to continue, use the ask_followup_question tool to request the user to copy and paste it back to you.",
}

export default prompts
