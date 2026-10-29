// English prompts — key-value pairs only, no code logic.
const prompts: Record<string, string> = {
    description: `Fetches content from a specified URL and analyzes it using your prompt
- Takes a URL and analysis prompt as input
- Fetches the URL content and processes based on your prompt
- Use this tool when you need to retrieve and analyze web content
- IMPORTANT: If an MCP-provided web fetch tool is available, prefer using that tool instead of this one, as it may have fewer restrictions.
- The URL must be a fully-formed valid URL
- The prompt must be at least 2 characters
- HTTP URLs will be automatically upgraded to HTTPS
- This tool is read-only and does not modify any files`,
    standardDescription:
        "Fetches and analyzes content from a specified URL. IMPORTANT: If an MCP-provided web fetch tool is available, prefer using that tool instead of this one, as it may have fewer restrictions.",
    urlInstruction: "The URL to fetch content from",
    urlUsage: "https://example.com/docs",
    promptInstruction: "The prompt to use for analyzing the webpage content",
    promptUsage: "Summarize the main points and key takeaways",
    standardPromptInstruction: "Prompt for analyzing the webpage content",
}
export default prompts
