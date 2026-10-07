/**
 * Navigation decisions for the documentation site.
 *
 * `sidebar` is the only source of navigation structure. Each top-level group is
 * one documentation section: the header shows the sections as tabs, and the
 * route middleware (`src/routeData.ts`) narrows every page's sidebar to the
 * section that contains it. A slug may therefore appear only once.
 *
 * Group labels are written in the root locale (English) with Simplified Chinese
 * translations keyed by BCP-47 tag; page entries use slugs so each locale shows
 * its own page title and the Pages base path is applied by Starlight.
 *
 * Starlight publishes every content file, including files missing from the
 * sidebar. `scripts/check-content.mjs` therefore requires each page to be either
 * reachable from `sidebar` or listed in `unlistedSlugs`, so no page is published
 * without an explicit decision.
 */

/** @type {NonNullable<import("@astrojs/starlight/types").StarlightUserConfig["sidebar"]>} */
export const sidebar = [
	{
		label: "User Guide",
		translations: { "zh-CN": "使用指南" },
		items: [
			{
				label: "Quick Start",
				translations: { "zh-CN": "快速使用" },
				items: [
					"dline-overview",
					"getting-started/installing-dline",
					"usage/ide",
					"getting-started/migration-cline-to-dline",
				],
			},
			{
				label: "Models",
				translations: { "zh-CN": "模型" },
				items: [
					"getting-started/authorizing-with-dline",
					"features/thinking-effort",
					"features/usage-and-balance",
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
			{
				label: "Tasks",
				translations: { "zh-CN": "任务" },
				items: [
					"core-workflows/plan-and-act",
					"core-workflows/working-with-files",
					"core-workflows/using-commands",
					"core-workflows/task-management",
					"core-workflows/checkpoints",
					"features/auto-compact",
				],
			},
			{
				label: "Approval & Permissions",
				translations: { "zh-CN": "审批与权限" },
				items: ["features/auto-approve", "customization/agentignore"],
			},
			{
				label: "Capabilities",
				translations: { "zh-CN": "能力扩展" },
				items: [
					"customization/capability-scopes",
					"customization/rules",
					"customization/workflows",
					"customization/skills",
					"mcp/mcp-overview",
					"customization/hooks",
					"customization/plugins",
					"features/subagents",
				],
			},
			{
				label: "Tools & Workspace",
				translations: { "zh-CN": "工具与工作区" },
				items: [
					"tools-reference/all-dline-tools",
					"customization/terminal-environment",
					"features/image-generation",
					"features/jupyter-notebooks",
					"features/multiroot-workspace",
				],
			},
			{
				label: "Settings & Troubleshooting",
				translations: { "zh-CN": "设置与排错" },
				items: ["getting-started/config", "troubleshooting/networking-and-proxies", "troubleshooting/telemetry"],
			},
		],
	},
	{
		label: "Developer Guide",
		translations: { "zh-CN": "开发指南" },
		items: [
			{
				label: "Get Started",
				translations: { "zh-CN": "开始" },
				items: ["developer-guide/setup", "developer-guide/contributing"],
			},
			{
				label: "Runtime Architecture",
				translations: { "zh-CN": "运行时架构" },
				items: [
					"developer-guide/architecture",
					"developer-guide/task-tool-execution-domain",
					"developer-guide/prompt-architecture",
					"developer-guide/storage",
					"developer-guide/protobuf",
				],
			},
			{
				label: "Caching & Observability",
				translations: { "zh-CN": "缓存与可观测性" },
				items: ["developer-guide/prompt-cache-freshness", "developer-guide/telemetry"],
			},
			{
				label: "Verification",
				translations: { "zh-CN": "验证" },
				items: ["developer-guide/testing"],
			},
		],
	},
]

/**
 * Slugs that are intentionally published without a sidebar entry.
 * The empty slug is the splash home page of each locale.
 * @type {ReadonlySet<string>}
 */
export const unlistedSlugs = new Set([""])
