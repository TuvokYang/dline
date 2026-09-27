// English prompts — key-value pairs only, no code logic.
const prompts: Record<string, string> = {
	description:
		"Request to list files and directories within the specified directory. Each entry includes file size (KB), last modification time, and line count (for non-recursive listings on text files). If recursive is true, it will list all files and directories recursively. If recursive is false or not provided, it will only list the top-level contents. Do not use this tool to confirm the existence of files you may have created, as the user will let you know if the files were created successfully or not.",
	pathInstruction: "The directory path to list. @WORKSPACE_PATH_RULE@@MULTI_ROOT_HINT@",
	pathUsage: "Directory path here",
	standardPathInstruction: "The directory path to list. @WORKSPACE_PATH_RULE@@MULTI_ROOT_HINT@",
	recursiveInstruction: "Whether to list files recursively. Use true for recursive listing, false or omit for top-level only.",
	recursiveUsage: "true or false (optional)",
	showMetadataInstruction:
		"Whether to include file size, modification time, and line count metadata in the output. Defaults to true. Set to false for lightweight listings.",
	showMetadataUsage: "true or false (optional, defaults to true)",
}
export default prompts
