import type { UiMessage, UiSayTool } from "@shared/ExtensionMessage"
import type { Meta, StoryObj } from "@storybook/react-vite"
import { ToolGroupRenderer } from "./ToolGroupRenderer"

const cases = [
	{
		id: "read",
		tool: "readFile",
		path: "src/core/task/tools/handlers/ReadFileToolHandler.ts",
		readLineStart: 125,
		readLineEnd: 416,
	},
	{
		id: "search",
		tool: "searchFiles",
		path: "src/core/task/tools/handlers",
		regex: "describe|it|expect|vi|beforeEach",
		filePattern: "*.ts",
		count: 300,
		files: 42,
		truncated: true,
	},
	{
		id: "refs",
		tool: "findReferences",
		path: "src/core/task/tools/handlers/ToolExecutor.ts",
		symbolName: "ToolExecutor",
		count: 12,
		files: 3,
	},
	{
		id: "long-search",
		tool: "searchFiles",
		path: "src/core/task/tools/handlers",
		regex: "aVeryLongSearchExpressionThatMustNotHideTheResultCounts".repeat(5),
		count: 27,
		files: 5,
	},
	{
		id: "long-name",
		tool: "readFile",
		path: `C:\\workspace\\src\\handlers\\${"LongFileName".repeat(10)}.tsx`,
		readLineStart: 1,
		readLineEnd: 100,
	},
	{ id: "no-suffix", tool: "listFilesRecursive", path: "src/core/task/tools/handlers" },
] satisfies (UiSayTool & { id: string })[]

/** Each case has an independent request so active-path deduplication cannot mask a row. */
function LayoutExamples({ active = false }: { active?: boolean }) {
	return (
		<div data-testid="tool-layout-examples" style={{ width: "100%", paddingTop: 24 }}>
			{cases.map(({ id, ...payload }, index) => {
				const request: UiMessage = { ts: index * 2, type: "say", say: "api_req_started", text: "{}" }
				const message: UiMessage = {
					ts: index * 2 + 1,
					type: active ? "ask" : "say",
					...(active ? { ask: "tool" as const } : { say: "tool" as const }),
					text: JSON.stringify(payload),
				}
				return (
					<div data-testid={`case-${id}`} key={id}>
						<ToolGroupRenderer
							allMessages={active ? [request, message] : [message]}
							isLastGroup={active}
							messages={[message]}
						/>
					</div>
				)
			})}
		</div>
	)
}

const meta = {
	title: "Chat/Tool Group Layout",
	component: LayoutExamples,
	parameters: { layout: "fullscreen" },
} satisfies Meta<typeof LayoutExamples>

export default meta
type Story = StoryObj<typeof meta>
export const Completed: Story = {}
export const Active: Story = { args: { active: true } }
