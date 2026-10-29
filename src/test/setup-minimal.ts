import { vi } from "vitest"

vi.mock("@/config", () => ({
    ClineEndpoint: { config: { environment: "production" }, isSelfHosted: () => false, init: () => {} },
    ClineEnv: { config: () => ({}), setEnvironment: () => {}, getEnvironment: () => "production" },
    ClineConfigurationError: class extends Error {},
    Environment: { production: "production" },
}))

vi.mock("@/hosts/host-provider", () => ({
    HostProvider: { isInitialized: () => true, reset: () => {}, initialize: () => {}, window: {}, env: {}, workspace: {} },
}))

vi.mock("@/registry", () => ({
    HostRegistryInfo: { init: async () => {}, get: () => ({}) },
    ExtensionRegistryInfo: { version: "0.0.0" },
}))
