export const E2E_MOCK_PROVIDER_ROUTES = {
	"openai-compatible-chat": {
		provider: "openai",
		protocol: "openai-chat",
		basePath: "/mock/openai-compatible/chat/v1",
		endpoint: "/chat/completions",
		auth: "bearer",
	},
	"openai-compatible-responses": {
		provider: "openai",
		protocol: "openai-responses",
		basePath: "/mock/openai-compatible/responses/v1",
		endpoint: "/responses",
		auth: "bearer",
	},
	"openai-official-responses": {
		provider: "openai",
		protocol: "openai-responses",
		basePath: "/mock/openai/official/v1",
		endpoint: "/responses",
		auth: "bearer",
	},
	"deepseek-chat": {
		provider: "deepseek",
		protocol: "deepseek-chat",
		basePath: "/mock/deepseek/v1",
		endpoint: "/chat/completions",
		auth: "bearer",
	},
	"deepseek-responses": {
		provider: "deepseek",
		protocol: "openai-responses",
		basePath: "/mock/deepseek/responses/v1",
		endpoint: "/responses",
		auth: "bearer",
	},
	"anthropic-messages": {
		provider: "anthropic",
		protocol: "anthropic-messages",
		basePath: "/mock/anthropic",
		endpoint: "/v1/messages",
		auth: "x-api-key",
	},
	// The subscription provider speaks the same protocol but authenticates with
	// a bearer token, so it needs its own route rather than sharing the
	// x-api-key one.
	"claude-code-messages": {
		provider: "claude-code",
		protocol: "anthropic-messages",
		basePath: "/mock/claude-code",
		endpoint: "/v1/messages",
		auth: "bearer",
	},
} as const

export const E2E_OPENAI_IMAGE_ROUTE = {
	basePath: "/mock/openai/images/v1",
	endpoint: "/images/generations",
} as const

export type E2EMockProviderTarget = keyof typeof E2E_MOCK_PROVIDER_ROUTES
export type E2EMockApiProtocol = (typeof E2E_MOCK_PROVIDER_ROUTES)[E2EMockProviderTarget]["protocol"]

export function getE2EMockProviderBaseUrl(baseUrl: string, target: E2EMockProviderTarget): string {
	return `${baseUrl}${E2E_MOCK_PROVIDER_ROUTES[target].basePath}`
}

export function getE2EMockProviderUrl(baseUrl: string, target: E2EMockProviderTarget): string {
	const route = E2E_MOCK_PROVIDER_ROUTES[target]
	return `${getE2EMockProviderBaseUrl(baseUrl, target)}${route.endpoint}`
}

export function getE2EOpenAIImageBaseUrl(baseUrl: string): string {
	return `${baseUrl}${E2E_OPENAI_IMAGE_ROUTE.basePath}`
}

export const E2E_REGISTERED_MOCK_ENDPOINTS = {
	"/mock/web-fetch": {
		GET: ["/page"],
		POST: [],
		PUT: [],
	},
	"/mock/searxng": {
		GET: ["/search"],
		POST: [],
		PUT: [],
	},
	"/api/v1": {
		GET: [
			"/generation",
			"/organizations/{orgId}/balance",
			"/organizations/{orgId}/members/{memberId}/usages",
			"/organizations/{orgId}/api-keys",
			"/organizations/{orgId}/remote-config",
			"/users/me",
			"/users/me/remote-config",
			"/users/me/featurebase-token",
			"/users/{userId}/balance",
			"/users/{userId}/usages",
			"/users/{userId}/payments",
		],
		POST: ["/chat/completions", "/auth/token", "/users/me/budget/request"],
		PUT: ["/users/active-account"],
	},
	"/.test": {
		GET: [],
		POST: ["/auth", "/setUserBalance", "/setUserHasOrganization", "/setOrgBalance", "/setSpendLimitExceeded"],
		PUT: [],
	},
	"/health": {
		POST: [],
		GET: ["/", "/ping"],
		PUT: [],
	},
}

const replace_in_file = `I successfully replaced "john" with "cline" in the test.ts file. The change has been completed and the file now contains:

\`\`\`typescript
export const name = "cline"
\`\`\`

The TypeScript errors shown in the output are unrelated to this change - they appear to be existing issues in the broader codebase related to missing type definitions and dependencies. The specific task of updating the name in test.ts has been completed successfully.

<attempt_completion>
<result>
I have successfully replaced the name "john" with "cline" in the test.ts file. The file now exports:

\`\`\`typescript
export const name = "cline"
\`\`\`

The change has been applied and saved to the file.
</result>
</attempt_completion>`

const edit_request = `<thinking>
The user wants me to replace the name "john" with "cline" in the test.ts file. I can see the file content provided:

\`\`\`typescript
export const name = "john"
\`\`\`

I need to change "john" to "cline". This is a simple targeted edit, so I should use the replace_in_file tool rather than write_to_file since I'm only changing one small part of the file.

I need to:
1. Use replace_in_file to change "john" to "cline" in the test.ts file
2. The SEARCH block should match the exact content: \`export const name = "john"\`
3. The REPLACE block should be: \`export const name = "cline"\`
</thinking>

I'll replace "john" with "cline" in the test.ts file.

<replace_in_file>
<path>test.ts</path>
<diff>
------- SEARCH
export const name = "john"
=======
export const name = "cline"
+++++++ REPLACE
</diff>
</replace_in_file>`

export const E2E_MOCK_API_RESPONSES = {
	DEFAULT: "Hello! I'm a mock Cline API response.",
	REPLACE_REQUEST: replace_in_file,
	EDIT_REQUEST: edit_request,
}
