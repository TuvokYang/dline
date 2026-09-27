/**
 * Navigation decisions for the documentation site.
 *
 * `sidebar` is the only source of sidebar structure. Group labels are written in
 * the root locale (English) with Simplified Chinese translations keyed by BCP-47
 * tag; page entries use slugs so each locale shows its own page title and the
 * Pages base path is applied by Starlight.
 *
 * Starlight publishes every content file, including files missing from the
 * sidebar. `scripts/check-content.mjs` therefore requires each page to be either
 * reachable from `sidebar` or listed in `unlistedSlugs`, so no page is published
 * without an explicit decision.
 */

/** @type {NonNullable<import("@astrojs/starlight/types").StarlightUserConfig["sidebar"]>} */
export const sidebar = [
	{
		label: "Getting Started",
		translations: { "zh-CN": "快速开始" },
		items: [
			"dline-overview",
			"getting-started/installing-dline",
			"getting-started/migration-cline-to-dline",
			{
				label: "Models & Providers",
				translations: { "zh-CN": "模型与服务商" },
				items: [
					"getting-started/authorizing-with-dline",
					"running-models-locally/overview",
					{
						label: "Cloud Providers",
						translations: { "zh-CN": "云服务商" },
						collapsed: true,
						items: [
							"provider-config/qwen",
							"provider-config/anthropic",
							{
								label: "Amazon Bedrock",
								collapsed: true,
								items: [
									"provider-config/aws-bedrock/api-key",
									"provider-config/aws-bedrock/iam-credentials",
									"provider-config/aws-bedrock/cli-profile",
								],
							},
							"provider-config/deepseek",
							"provider-config/google-gemini",
							"provider-config/minimax",
							"provider-config/openai",
							"provider-config/openai-compatible",
							"provider-config/openrouter",
							"provider-config/zai",
							"provider-config/other-30-plus-providers",
						],
					},
				],
			},
			"getting-started/config",
		],
	},
	{
		label: "Usage",
		translations: { "zh-CN": "使用" },
		items: ["usage/ide"],
	},
	{
		label: "Configurations",
		translations: { "zh-CN": "配置" },
		items: [
			"tools-reference/all-dline-tools",
			"customization/rules",
			"customization/workflows",
			"customization/skills",
			"customization/terminal-environment",
			"customization/plugins",
			"mcp/mcp-overview",
			"customization/hooks",
			"customization/agentignore",
		],
	},
	{
		label: "Features",
		translations: { "zh-CN": "功能" },
		items: [
			"core-workflows/plan-and-act",
			"core-workflows/working-with-files",
			"core-workflows/using-commands",
			"core-workflows/checkpoints",
			"core-workflows/task-management",
			"features/auto-compact",
			"features/subagents",
			"features/image-generation",
		],
	},
	{
		label: "IDE Specific Features",
		translations: { "zh-CN": "IDE 专属功能" },
		items: ["features/auto-approve", "features/jupyter-notebooks", "features/multiroot-workspace"],
	},
	{
		label: "Troubleshooting",
		translations: { "zh-CN": "故障排查" },
		items: ["troubleshooting/networking-and-proxies", "troubleshooting/telemetry"],
	},
	{
		label: "Developer Guide",
		translations: { "zh-CN": "开发指南" },
		items: [
			"developer-guide/setup",
			"developer-guide/architecture",
			"developer-guide/prompt-architecture",
			"developer-guide/task-tool-execution-domain",
			"developer-guide/protobuf",
			"developer-guide/storage",
			"developer-guide/testing",
			"developer-guide/contributing",
		],
	},
]

/**
 * Slugs that are intentionally published without a sidebar entry.
 * The empty slug is the splash home page of each locale.
 * @type {ReadonlySet<string>}
 */
export const unlistedSlugs = new Set([""])
