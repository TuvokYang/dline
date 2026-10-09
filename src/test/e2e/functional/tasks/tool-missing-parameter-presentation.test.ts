import { E2ETestHelper, e2e } from "@e2e/utils/helpers"
import { expect } from "@playwright/test"

const TASK = "E2E_MCP_MISSING_SERVER_NAME_TASK"
const COMPLETION = "E2E_MCP_MISSING_SERVER_NAME_RECOVERED"
const REMINDER = "Missing value for required parameter 'server_name'"

e2e("Tool validation - missing MCP server_name stays model-only", async ({ helper, server, sidebar, userDataDir }) => {
	e2e.setTimeout(180_000)
	await helper.signin(sidebar)
	server.resetOpenAiMock()
	server.enqueueOpenAiResponses(
		{
			type: "tool",
			id: "call_missing_mcp_server_name",
			name: "use_mcp_tool",
			arguments: { tool_name: "e2e_missing_parameter_probe", arguments: "{}" },
		},
		{
			type: "tool",
			id: "call_missing_mcp_server_name_recovered",
			name: "attempt_completion",
			arguments: { result: COMPLETION },
			expectedRequestIncludes: [REMINDER],
		},
	)

	const input = sidebar.getByTestId("chat-input")
	await input.fill(TASK)
	await sidebar.getByTestId("send-button").click()
	await expect(sidebar.getByText(COMPLETION, { exact: false }).last()).toBeVisible({ timeout: 90_000 })

	await expect(sidebar.getByTestId("api-error-box")).toHaveCount(0)
	await expect(sidebar.getByText(REMINDER, { exact: false })).toHaveCount(0)
	await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
})
