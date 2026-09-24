import { isUnifiedProcessor, unified } from "@astrojs/markdown-remark"
import starlight from "@astrojs/starlight"
import type { AstroIntegration } from "astro"
import { defineConfig } from "astro/config"
import { resolveSiteConfig } from "./site.config.mjs"
import { locales, ROOT_LOCALE } from "./src/data/locales.mjs"
import { sidebar } from "./src/data/navigation.mjs"
import { redirects } from "./src/data/redirects.mjs"
import { remarkBaseLinks } from "./src/plugins/remark-base-links.mjs"

const { site, base } = resolveSiteConfig()
const repositoryUrl = "https://github.com/TuvokYang/dline"

export default defineConfig({
	site,
	base,
	redirects,
	// The base-link rewrite is a remark plugin, so content must run on the unified pipeline.
	markdown: { processor: unified() },
	integrations: [
		baseSafeContentLinks(),
		starlight({
			title: {
				"zh-CN": "Dline 文档",
				en: "Dline Docs",
			},
			defaultLocale: ROOT_LOCALE,
			locales,
			logo: {
				light: "./src/assets/brand/logo-light.svg",
				dark: "./src/assets/brand/logo-dark.svg",
				alt: "Dline",
			},
			social: [{ icon: "github", label: "GitHub", href: repositoryUrl }],
			editLink: { baseUrl: `${repositoryUrl}/edit/dev/docs/` },
			customCss: ["./src/styles/custom.css"],
			sidebar,
		}),
	],
})

/**
 * Register the base-link rewrite with the resolved base, so a `--base` CLI
 * override (used by `npm run dev`) and DOCS_BASE produce consistent links.
 * Fails fast when the configured processor cannot run remark plugins, because
 * silently skipping the rewrite would publish links that miss the Pages base.
 */
function baseSafeContentLinks(): AstroIntegration {
	return {
		name: "dline-docs:base-safe-links",
		hooks: {
			"astro:config:setup": ({ config }) => {
				const processor = config.markdown.processor
				if (!processor || !isUnifiedProcessor(processor)) {
					throw new Error(
						`dline-docs:base-safe-links requires the unified Markdown processor, got "${processor?.name ?? "none"}".`,
					)
				}
				processor.options.remarkPlugins.push([remarkBaseLinks, { base: config.base }])
			},
		},
	}
}
