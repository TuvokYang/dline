/** Shared endpoint double; each suite registers it with its own hoisted vi.mock. */
export const ClineEndpoint = {
    isSelfHosted: () => false,
    init: () => {},
    config: {
        environment: "production",
        appBaseUrl: "https://app.dline.cc",
        apiBaseUrl: "https://api.dline.cc",
        mcpBaseUrl: "https://mcp.cline.bot",
    },
}

export const ClineEnv = {
    config: () => ({}),
    setEnvironment: () => {},
    getEnvironment: () => "production",
}

export class ClineConfigurationError extends Error {
    constructor(m: string) {
        super(m)
        this.name = "ClineConfigurationError"
    }
}

export const Environment = { production: "production" }
