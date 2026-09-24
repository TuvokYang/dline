import { docsLoader, i18nLoader } from "@astrojs/starlight/loaders"
import { docsSchema, i18nSchema } from "@astrojs/starlight/schema"
import { defineCollection } from "astro:content"

export const collections = {
	docs: defineCollection({ loader: docsLoader(), schema: docsSchema() }),
	// Starlight's built-in English dictionary omits the Expressive Code labels, so with a
	// zh-CN default locale they would silently fall back to Chinese on /en/ pages.
	i18n: defineCollection({ loader: i18nLoader(), schema: i18nSchema() }),
}
