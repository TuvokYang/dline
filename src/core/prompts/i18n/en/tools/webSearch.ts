// English prompts — key-value pairs only, no code logic.
const prompts: Record<string, string> = {
    description: `Performs a web search and returns relevant results
- Takes a search query as input and returns search results with titles and URLs
- Optionally filter results by allowed or blocked domains
- Use this tool when you need to search the web for information
- The query must be at least 2 characters
- You may provide either allowed_domains OR blocked_domains, but NOT both
- Domains should be provided as a JSON array of strings
- This tool is read-only and does not modify any files`,
    standardDescription: "Searches the web and returns result titles, URLs, and available excerpts.",
    queryInstruction: "The search query to use",
    promptInstruction: "Optional instructions for the selected tool to process the search results.",
    queryUsage: "latest developments in AI",
    allowedDomainsInstruction: "JSON array of domains to restrict results to",
    allowedDomainsUsage: '["example.com", "github.com"]',
    blockedDomainsInstruction: "JSON array of domains to exclude from results",
    blockedDomainsUsage: '["ads.com", "spam.com"]',
}
export default prompts
