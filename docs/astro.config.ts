import { isUnifiedProcessor, unified } from "@astrojs/markdown-remark"
import starlight from "@astrojs/starlight"
import type { AstroIntegration } from "astro"
import { defineConfig } from "astro/config"
import { resolveSiteConfig } from "./site.config.mjs"
import { DOCS_ASSETS_ALIAS, DOCS_ASSETS_DIR } from "./src/data/assets.mjs"
import { locales, ROOT_LOCALE } from "./src/data/locales.mjs"
import { sidebar } from "./src/data/navigation.mjs"
import { redirects } from "./src/data/redirects.mjs"
import { remarkBaseLinks, toPrefix, withBase } from "./src/plugins/remark-base-links.mjs"

const { site, base } = resolveSiteConfig()
const repositoryUrl = "https://github.com/TuvokYang/dline"

export default defineConfig({
	site,
	base,
	// The base-link rewrite is a remark plugin, so content must run on the unified pipeline.
	markdown: { processor: unified() },
	vite: {
		resolve: { alias: { [DOCS_ASSETS_ALIAS]: DOCS_ASSETS_DIR } },
		// The images sit outside the docs project root; let the dev server read them.
		server: { fs: { allow: [".", DOCS_ASSETS_DIR] } },
	},
	integrations: [
		baseSafeContentLinks(),
		starlight({
			title: {
				en: "Dline Docs",
				"zh-CN": "Dline 文档",
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
			components: {
				Header: "./src/components/Header.astro",
				PageFrame: "./src/components/PageFrame.astro",
			},
			routeMiddleware: "./src/routeData.ts",
			sidebar,
		}),
	],
})

/**
 * Astro prefixes redirect sources with `base` but emits destinations verbatim,
 * so base-free destinations would leave the Pages project path. Prefix them with
 * the final base so the redirect data stays deployment-independent.
 */
function withBaseDestinations(map: Readonly<Record<string, string>>, siteBase: string): Record<string, string> {
	const prefix = toPrefix(siteBase)
	return Object.fromEntries(Object.entries(map).map(([from, to]) => [from, withBase(to, prefix)]))
}

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
			"astro:config:setup": ({ config, updateConfig }) => {
				// Registered here rather than at the top level so a `--base` CLI override
				// (used by `npm run dev`) also reaches redirect destinations.
				updateConfig({ redirects: withBaseDestinations(redirects, config.base) })
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
