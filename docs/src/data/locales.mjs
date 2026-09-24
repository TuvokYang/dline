/**
 * Site editions. Chinese is served at the site root and English below /en/.
 *
 * astro.config.ts and the verification scripts both read this module, so the
 * routing the build produces and the routing the checks expect cannot diverge.
 */

export const ROOT_LOCALE = "root"

export const locales = Object.freeze({
	root: Object.freeze({ label: "简体中文", lang: "zh-CN" }),
	en: Object.freeze({ label: "English", lang: "en" }),
})
