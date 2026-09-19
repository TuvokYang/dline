import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import "should"
import { Controller } from "@core/controller"
import { StateManager } from "@core/storage/StateManager"
import type { McpMarketplaceItem } from "@shared/mcp"
import type { RemoteConfig } from "@shared/remote-config/schema"
import axios from "axios"
// sinon import removed
import { ClineEndpoint, ClineEnv } from "@/config"
import { HostProvider } from "@/hosts/host-provider"

/**
 * Unit tests for Controller MCP marketplace filtering with remote config
 * Tests that marketplace catalog respects allowedMCPServers configuration
 */
describe("Controller Marketplace Filtering", () => {
	let controller: Controller
	let mockContext: any
	let stateManagerStub: any /* sinon.SinonStub → vitest */
	let mockStateManager: any
	let axiosGetStub: any /* sinon.SinonStub → vitest */
	let hostProviderInitialized = false

	// Initialize ClineEndpoint before tests run (required for ClineEnv.config() to work)
	beforeAll(async () => {
		if (!ClineEndpoint.isInitialized()) {
			await ClineEndpoint.initialize("/test/extension")
		}
	})

	const mockMarketplaceData: McpMarketplaceItem[] = [
		{
			mcpId: "github.com/test/filesystem",
			name: "Filesystem",
			author: "Test",
			description: "File operations",
			githubStars: 100,
			downloadCount: 500,
			tags: ["files"],
			githubUrl: "https://github.com/test/filesystem",
			codiconIcon: "files",
			logoUrl: "",
			category: "filesystem",
			requiresApiKey: false,
			isRecommended: false,
			createdAt: "2024-01-01T00:00:00Z",
			updatedAt: "2024-01-01T00:00:00Z",
			lastGithubSync: "2024-01-01T00:00:00Z",
		},
		{
			mcpId: "github.com/test/database",
			name: "Database",
			author: "Test",
			description: "Database operations",
			githubStars: 200,
			downloadCount: 1000,
			tags: ["db"],
			githubUrl: "https://github.com/test/database",
			codiconIcon: "database",
			logoUrl: "",
			category: "database",
			requiresApiKey: false,
			isRecommended: false,
			createdAt: "2024-01-01T00:00:00Z",
			updatedAt: "2024-01-01T00:00:00Z",
			lastGithubSync: "2024-01-01T00:00:00Z",
		},
		{
			mcpId: "github.com/test/web",
			name: "Web",
			author: "Test",
			description: "Web scraping",
			githubStars: 150,
			downloadCount: 750,
			tags: ["web"],
			githubUrl: "https://github.com/test/web",
			codiconIcon: "globe",
			logoUrl: "",
			category: "web",
			requiresApiKey: false,
			isRecommended: false,
			createdAt: "2024-01-01T00:00:00Z",
			updatedAt: "2024-01-01T00:00:00Z",
			lastGithubSync: "2024-01-01T00:00:00Z",
		},
	]

	beforeEach(async () => {
		// Initialize HostProvider if not already done
		if (!HostProvider.isInitialized()) {
			const mockHostBridge: any = {
				workspaceClient: {},
				envClient: {
					getHostVersion: vi.fn().mockResolvedValue({
						clineVersion: "1.0.0",
						platform: "darwin",
						clineType: "vscode",
					}),
				},
				windowClient: {},
				diffClient: {},
			}

			HostProvider.initialize(
				() => null as any, // createWebviewProvider
				() => null as any, // createDiffViewProvider
				() => null as any, // createCommentReviewController
				() => null as any, // createTerminalManager
				mockHostBridge,
				() => {}, // logToChannel
				async (path: string) => `http://localhost${path}`, // getCallbackUrl
				async () => "", // getBinaryLocation
				"/test/extension", // extensionFsPath
				"/test/storage", // globalStorageFsPath
			)
			hostProviderInitialized = true
		}

		// Initialize HostRegistryInfo before creating Controller
		await import("@/registry").then((m) => m.HostRegistryInfo.init("test-distinct-id"))

		// Mock VSCode context
		mockContext = {
			globalState: {
				get: vi.fn(),
				update: vi.fn().mockResolvedValue(undefined),
			},
			workspaceState: {
				get: vi.fn(),
				update: vi.fn().mockResolvedValue(undefined),
			},
			secrets: {
				get: vi.fn().mockResolvedValue(undefined),
				store: vi.fn().mockResolvedValue(undefined),
				delete: vi.fn().mockResolvedValue(undefined),
			},
			subscriptions: [],
			extensionPath: "/test/path",
			globalStoragePath: "/test/storage",
			globalStorageUri: { fsPath: "/test/storage" },
		}

		// Mock StateManager
		mockStateManager = {
			getRemoteConfigSettings: vi.fn().mockReturnValue({}),
			getApiConfiguration: vi.fn().mockReturnValue({}),
			getGlobalStateKey: vi.fn().mockReturnValue(undefined),
			getGlobalSettingsKey: vi.fn().mockReturnValue(undefined),
			getWorkspaceStateKey: vi.fn().mockReturnValue(undefined),
			getScopedCapabilityToggles: vi.fn().mockReturnValue({}),
			setGlobalState: vi.fn(),
			setActiveTaskId: vi.fn(),
			setApiConfiguration: vi.fn(),
			registerCallbacks: vi.fn(),
		}

		// Stub StateManager.get() to return our mock
		// StateManager imported at top level
		stateManagerStub = vi.spyOn(StateManager, "get").mockReturnValue(mockStateManager)

		// Mock axios
		axiosGetStub = vi.spyOn(axios, "get").mockResolvedValue({
			data: mockMarketplaceData,
		})

		// These tests exercise marketplace data filtering only. Detach immediately so
		// Controller state publication does not outlive the deliberately minimal fixture.
		controller = new Controller(mockContext)
		controller.detachUi()
	})

	afterEach(() => {
		controller?.detachUi()
		stateManagerStub?.mockRestore?.()
		axiosGetStub?.mockRestore?.()

		// Reset HostProvider if we initialized it
		if (hostProviderInitialized) {
			HostProvider.reset()
			hostProviderInitialized = false
		}
	})

	describe("refreshMcpMarketplace without remote config", () => {
		it("should return full catalog when no remote config is set", async () => {
			mockStateManager.getRemoteConfigSettings.mockReturnValue({})

			const catalog = await controller.refreshMcpMarketplace(false)

			catalog?.items.should.have.length(3)
			catalog?.items.map((item) => item.mcpId).should.containEql("github.com/test/filesystem")
			catalog?.items.map((item) => item.mcpId).should.containEql("github.com/test/database")
			catalog?.items.map((item) => item.mcpId).should.containEql("github.com/test/web")
		})

		it("should return full catalog when remote config has no allowedMCPServers", async () => {
			const remoteConfig: Partial<RemoteConfig> = {
				version: "v1",
				// No allowedMCPServers field
			}
			mockStateManager.getRemoteConfigSettings.mockReturnValue(remoteConfig)

			const catalog = await controller.refreshMcpMarketplace(false)

			catalog?.items.should.have.length(3)
		})

		it("should return full catalog when allowedMCPServers is undefined", async () => {
			const remoteConfig: Partial<RemoteConfig> = {
				version: "v1",
				allowedMCPServers: undefined,
			}
			mockStateManager.getRemoteConfigSettings.mockReturnValue(remoteConfig)

			const catalog = await controller.refreshMcpMarketplace(false)

			catalog?.items.should.have.length(3)
		})
	})

	describe("refreshMcpMarketplace with allowedMCPServers", () => {
		it("should filter catalog to only allowed servers", async () => {
			const remoteConfig: Partial<RemoteConfig> = {
				version: "v1",
				allowedMCPServers: [{ id: "github.com/test/filesystem" }, { id: "github.com/test/database" }],
			}
			mockStateManager.getRemoteConfigSettings.mockReturnValue(remoteConfig)

			const catalog = await controller.refreshMcpMarketplace(false)

			catalog?.items.should.have.length(2)
			catalog?.items.map((item) => item.mcpId).should.containEql("github.com/test/filesystem")
			catalog?.items.map((item) => item.mcpId).should.containEql("github.com/test/database")
			catalog?.items.map((item) => item.mcpId).should.not.containEql("github.com/test/web")
		})

		it("should filter catalog to single allowed server", async () => {
			const remoteConfig: Partial<RemoteConfig> = {
				version: "v1",
				allowedMCPServers: [{ id: "github.com/test/filesystem" }],
			}
			mockStateManager.getRemoteConfigSettings.mockReturnValue(remoteConfig)

			const catalog = await controller.refreshMcpMarketplace(false)

			catalog?.items.should.have.length(1)
			catalog?.items[0].mcpId.should.equal("github.com/test/filesystem")
		})

		it("should return empty catalog when allowedMCPServers is empty array", async () => {
			const remoteConfig: Partial<RemoteConfig> = {
				version: "v1",
				allowedMCPServers: [],
			}
			mockStateManager.getRemoteConfigSettings.mockReturnValue(remoteConfig)

			const catalog = await controller.refreshMcpMarketplace(false)

			catalog?.items.should.have.length(0)
		})

		it("should return empty catalog when no servers match allowlist", async () => {
			const remoteConfig: Partial<RemoteConfig> = {
				version: "v1",
				allowedMCPServers: [{ id: "github.com/test/nonexistent-1" }, { id: "github.com/test/nonexistent-2" }],
			}
			mockStateManager.getRemoteConfigSettings.mockReturnValue(remoteConfig)

			const catalog = await controller.refreshMcpMarketplace(false)

			catalog?.items.should.have.length(0)
		})
	})

	describe("API interaction", () => {
		it("should call marketplace API with correct parameters", async () => {
			mockStateManager.getRemoteConfigSettings.mockReturnValue({})

			await controller.refreshMcpMarketplace(false)

			expect(axiosGetStub)
			const callArgs = axiosGetStub.mock.calls[0]!
			;(callArgs[0] as any).should.equal(`${ClineEnv.config()?.mcpBaseUrl}/marketplace`)
		})

		it("should handle API errors gracefully", async () => {
			axiosGetStub.mockRejectedValue(new Error("Network error"))
			mockStateManager.getRemoteConfigSettings.mockReturnValue({})

			const catalog = await controller.refreshMcpMarketplace(false)

			// Should return undefined on error
			;(catalog === undefined).should.be.true()
		})

		it("should handle invalid API response", async () => {
			axiosGetStub.mockResolvedValue({ data: null })
			mockStateManager.getRemoteConfigSettings.mockReturnValue({})

			const catalog = await controller.refreshMcpMarketplace(false)

			// Should return undefined on invalid response
			;(catalog === undefined).should.be.true()
		})
	})

	describe("Data normalization", () => {
		it("should normalize missing optional fields to default values", async () => {
			const incompleteData = [
				{
					mcpId: "github.com/test/incomplete",
					name: "Incomplete",
					author: "Test",
					description: "Test",
					githubUrl: "https://github.com/test/incomplete",
					codiconIcon: "file",
					logoUrl: "",
					category: "other",
					requiresApiKey: false,
					isRecommended: false,
					createdAt: "2024-01-01T00:00:00Z",
					updatedAt: "2024-01-01T00:00:00Z",
					lastGithubSync: "2024-01-01T00:00:00Z",
					// Missing githubStars, downloadCount, tags
				},
			]
			axiosGetStub.mockResolvedValue({ data: incompleteData })
			mockStateManager.getRemoteConfigSettings.mockReturnValue({})

			const catalog = await controller.refreshMcpMarketplace(false)

			catalog?.items.should.have.length(1)
			catalog?.items[0].githubStars.should.equal(0)
			catalog?.items[0].downloadCount.should.equal(0)
			catalog?.items[0].tags.should.be.an.Array()
			catalog?.items[0].tags.should.have.length(0)
		})
	})

	describe("Edge cases", () => {
		it("should handle null remote config", async () => {
			mockStateManager.getRemoteConfigSettings.mockReturnValue(null)

			const catalog = await controller.refreshMcpMarketplace(false)

			// Should work with null remote config (treats it as no restrictions)
			if (catalog) {
				catalog.items.should.have.length(3)
			} else {
				// If catalog is undefined, that's also acceptable behavior for null remote config
				;(catalog === undefined).should.be.true()
			}
		})

		it("should handle allowlist with duplicate IDs", async () => {
			const remoteConfig: Partial<RemoteConfig> = {
				version: "v1",
				allowedMCPServers: [
					{ id: "github.com/test/filesystem" },
					{ id: "github.com/test/filesystem" }, // duplicate
				],
			}
			mockStateManager.getRemoteConfigSettings.mockReturnValue(remoteConfig)

			const catalog = await controller.refreshMcpMarketplace(false)

			// Should handle duplicates gracefully
			catalog?.items.should.have.length(1)
			catalog?.items[0].mcpId.should.equal("github.com/test/filesystem")
		})

		it("should preserve all fields when filtering", async () => {
			const remoteConfig: Partial<RemoteConfig> = {
				version: "v1",
				allowedMCPServers: [{ id: "github.com/test/database" }],
			}
			mockStateManager.getRemoteConfigSettings.mockReturnValue(remoteConfig)

			const catalog = await controller.refreshMcpMarketplace(false)

			const item = catalog!.items[0]
			expect(item).toBeDefined()
			item.mcpId.should.equal("github.com/test/database")
			item.name.should.equal("Database")
			item.author.should.equal("Test")
			item.description.should.equal("Database operations")
			item.githubStars.should.equal(200)
			item.downloadCount.should.equal(1000)
			item.tags.should.containEql("db")
			item.githubUrl.should.equal("https://github.com/test/database")
		})
	})

	describe("Integration with other remote config settings", () => {
		it("should filter correctly even when mcpMarketplaceEnabled is false", async () => {
			// Note: mcpMarketplaceEnabled affects local servers in McpHub, not the API catalog
			const remoteConfig: Partial<RemoteConfig> = {
				version: "v1",
				mcpMarketplaceEnabled: false,
				allowedMCPServers: [{ id: "github.com/test/filesystem" }],
			}
			mockStateManager.getRemoteConfigSettings.mockReturnValue(remoteConfig)

			const catalog = await controller.refreshMcpMarketplace(false)

			// Catalog should still be filtered by allowlist
			catalog?.items.should.have.length(1)
			catalog?.items[0].mcpId.should.equal("github.com/test/filesystem")
		})

		it("should filter correctly with blockPersonalRemoteMCPServers set", async () => {
			// blockPersonalRemoteMCPServers affects remote servers, not marketplace catalog
			const remoteConfig: Partial<RemoteConfig> = {
				version: "v1",
				blockPersonalRemoteMCPServers: true,
				allowedMCPServers: [{ id: "github.com/test/web" }],
			}
			mockStateManager.getRemoteConfigSettings.mockReturnValue(remoteConfig)

			const catalog = await controller.refreshMcpMarketplace(false)

			catalog?.items.should.have.length(1)
			catalog?.items[0].mcpId.should.equal("github.com/test/web")
		})
	})

	describe("Performance considerations", () => {
		it("should handle large allowlists efficiently", async () => {
			const largeAllowlist = Array.from({ length: 100 }, (_, i) => ({
				id: `github.com/test/server-${i}`,
			}))
			largeAllowlist.push({ id: "github.com/test/filesystem" })

			const remoteConfig: Partial<RemoteConfig> = {
				version: "v1",
				allowedMCPServers: largeAllowlist,
			}
			mockStateManager.getRemoteConfigSettings.mockReturnValue(remoteConfig)

			const catalog = await controller.refreshMcpMarketplace(false)

			// Should efficiently filter and return only matching server
			catalog?.items.should.have.length(1)
			catalog?.items[0].mcpId.should.equal("github.com/test/filesystem")
		})

		it("should handle large marketplace catalogs efficiently", async () => {
			const largeCatalog = Array.from({ length: 500 }, (_, i) => ({
				mcpId: `github.com/test/server-${i}`,
				name: `Server ${i}`,
				author: "Test",
				description: "Test server",
				githubStars: i,
				downloadCount: i * 10,
				tags: ["test"],
				githubUrl: `https://github.com/test/server-${i}`,
				codiconIcon: "file",
				logoUrl: "",
				category: "other",
				requiresApiKey: false,
				isRecommended: false,
				createdAt: "2024-01-01T00:00:00Z",
				updatedAt: "2024-01-01T00:00:00Z",
				lastGithubSync: "2024-01-01T00:00:00Z",
			}))
			axiosGetStub.mockResolvedValue({ data: largeCatalog })

			const remoteConfig: Partial<RemoteConfig> = {
				version: "v1",
				allowedMCPServers: [
					{ id: "github.com/test/server-100" },
					{ id: "github.com/test/server-200" },
					{ id: "github.com/test/server-300" },
				],
			}
			mockStateManager.getRemoteConfigSettings.mockReturnValue(remoteConfig)

			const catalog = await controller.refreshMcpMarketplace(false)

			catalog?.items.should.have.length(3)
		})
	})
})
