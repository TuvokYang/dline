import { defineCollection } from "astro:content"
import { docsLoader, i18nLoader } from "@astrojs/starlight/loaders"
import { docsSchema, i18nSchema } from "@astrojs/starlight/schema"

export const collections = {
	docs: defineCollection({ loader: docsLoader(), schema: docsSchema() }),
	// Starlight's built-in English dictionary omits the Expressive Code labels; the
	// project dictionary in src/content/i18n/en.json pins them in English.
	i18n: defineCollection({ loader: i18nLoader(), schema: i18nSchema() }),
}
