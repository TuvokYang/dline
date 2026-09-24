/**
 * Navigation decisions for the documentation site.
 *
 * `sidebar` is the only source of sidebar structure. Group labels are written in
 * the root locale (Simplified Chinese) with English translations keyed by BCP-47
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
		label: "快速开始",
		translations: { en: "Getting Started" },
		items: [
			"dline-overview",
			"getting-started/installing-dline",
			"getting-started/migration-cline-to-dline",
			{
				label: "模型与服务商",
				translations: { en: "Models & Providers" },
				items: [
					"getting-started/authorizing-with-dline",
					"customization/profiles",
					"running-models-locally/overview",
					{
						label: "云服务商",
						translations: { en: "Cloud Providers" },
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
		label: "使用",
		translations: { en: "Usage" },
		items: ["usage/ide"],
	},
	{
		label: "配置",
		translations: { en: "Configurations" },
		items: [
			"tools-reference/all-dline-tools",
			"customization/dline-rules",
			"customization/skills",
			"customization/plugins",
			"mcp/mcp-overview",
			"customization/hooks",
			"customization/agentignore",
		],
	},
	{
		label: "功能",
		translations: { en: "Features" },
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
		label: "IDE 专属功能",
		translations: { en: "IDE Specific Features" },
		items: ["features/auto-approve", "features/jupyter-notebooks", "features/multiroot-workspace"],
	},
	{
		label: "故障排查",
		translations: { en: "Troubleshooting" },
		items: ["troubleshooting/networking-and-proxies", "troubleshooting/telemetry"],
	},
]

/**
 * Slugs that are intentionally published without a sidebar entry.
 * The empty slug is the splash home page of each locale.
 * @type {ReadonlySet<string>}
 */
export const unlistedSlugs = new Set([""])
