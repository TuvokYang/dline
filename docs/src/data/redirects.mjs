/**
 * Legacy URL to current URL map, passed to Astro's `redirects` option.
 *
 * Keys and values are base-free, root-relative paths; Astro emits a static HTML
 * redirect page for every key. Static hosting such as GitHub Pages cannot send
 * server-side 301/308 responses, so these redirects are client-side only.
 *
 * Destinations must point at current pages directly: chains are not allowed.
 * @type {Record<string, string>}
 */
export const redirects = {}
