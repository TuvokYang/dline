import { readFile } from "node:fs/promises"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"

const checklistPath = process.argv[2]
if (!checklistPath) throw new Error("A release checklist path is required")

const server = new McpServer({ name: "release-tools", version: "1.0.0" })
server.registerTool(
    "read_release_checklist",
    { description: "Read the project's release checklist.", inputSchema: {} },
    async () => ({ content: [{ type: "text", text: await readFile(checklistPath, "utf8") }] }),
)
await server.connect(new StdioServerTransport())
